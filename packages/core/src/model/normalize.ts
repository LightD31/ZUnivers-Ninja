import type {
  ApiAchievementEntry,
  ApiChallenge,
  ApiCorporation,
  ApiEvent,
  ApiEvolution,
  ApiUserOverview,
  ApiFusion,
  ApiInventoryEntry,
  ApiItem,
  ApiLoot,
  ApiRecycleConfig,
  ApiSettings,
  ApiTower,
  ApiTowerSeason,
  ApiUser,
  ApiUserTower,
} from '../api/schemas';
import {
  CLASSIC_PACK_SLUG,
  STAR_RARITY,
  cardKey,
  type Achievement,
  type Catalog,
  type Challenge,
  type ChallengeAction,
  type Fusion,
  type GameEvent,
  type Item,
  type LootDay,
  type OwnedCard,
  type Player,
  type Season,
  type Shiny,
} from './types';

const toShiny = (n: number | null | undefined): Shiny => (n === 1 ? 1 : n === 2 ? 2 : 0);

export function normalizeItem(raw: ApiItem, fusionResults: ReadonlySet<string> = new Set()): Item {
  const score = (s: number) => raw.scores[String(s)] ?? 0;
  const available = (s: number) => raw.shinyLevels[String(s)] ?? (s === 0 || score(s) > 0);
  const packSlug = raw.pack.slug || raw.pack.name.toLowerCase();
  return {
    id: raw.id,
    identifier: raw.identifier,
    name: raw.name,
    slug: raw.slug,
    genre: raw.genre,
    rarity: raw.rarity,
    packId: raw.pack.id,
    packName: raw.pack.name,
    packSlug,
    packYear: raw.pack.year ?? null,
    urls: raw.urls,
    scores: [score(0), score(1), score(2)],
    shinyAvailable: [available(0), available(1), available(2)],
    recyclable: raw.isRecyclable,
    tradable: raw.isTradable,
    counting: raw.isCounting,
    craftable: raw.isCraftable,
    invocable: raw.isInvocable,
    goldable: raw.isGoldable,
    upgradable: raw.isUpgradable,
    isFusion: fusionResults.has(raw.id),
    isStar: raw.rarity >= STAR_RARITY || raw.genre.toUpperCase() === 'STAR',
    isClassic: packSlug === CLASSIC_PACK_SLUG,
  };
}

export function normalizeFusion(raw: ApiFusion): Fusion {
  // L'API liste un composant autant de fois qu'il est requis.
  const counts = new Map<string, number>();
  for (const input of raw.items) counts.set(input.id, (counts.get(input.id) ?? 0) + 1);
  return {
    resultId: raw.item.id,
    inputs: [...counts].map(([itemId, quantity]) => ({ itemId, quantity })),
  };
}

export function normalizeEvent(raw: ApiEvent): GameEvent {
  return {
    id: raw.id,
    name: raw.name,
    packId: raw.pack?.id ?? null,
    packSlug: raw.pack?.slug ?? null,
    packName: raw.pack?.name ?? null,
    balanceCost: raw.balanceCost,
    loreDustCost: raw.loreDustCost,
    oneTime: raw.isOneTime,
    active: raw.isActive,
    invokeCount: raw.invokeCount,
    begin: raw.beginDate,
    end: raw.endDate,
    itemIds: raw.items.map((i) => i.id),
  };
}

export function normalizeSeason(raw: ApiTowerSeason | null): Season | null {
  if (!raw) return null;
  return {
    id: raw.id,
    index: raw.index,
    begin: raw.beginDate.slice(0, 10),
    end: raw.endDate.slice(0, 10),
    towerName: raw.tower.name,
    group: raw.tower.group,
    packId: raw.tower.pack.id,
    floors: [...raw.tower.towerFloors]
      .sort((a, b) => a.index - b.index)
      .map((f) => ({
        rate: f.rate / 100,
        drops: f.dropRates
          .filter((d) => d.rate > 0)
          .map((d) => ({ rarity: d.rarity, shiny: toShiny(d.shinyLevel), rate: d.rate / 100 })),
      })),
  };
}

export interface RawCatalog {
  settings: ApiSettings;
  items: ApiItem[];
  fusions: ApiFusion[];
  config: ApiRecycleConfig;
  events: ApiEvent[];
  season: ApiTowerSeason | null;
  towers: ApiTower[];
}

export function normalizeCatalog(
  raw: RawCatalog,
  ruleSet = 'NORMAL',
  fetchedAt = new Date(),
): Catalog {
  const fusions = raw.fusions.map(normalizeFusion);
  const fusionResults = new Set(fusions.map((f) => f.resultId));
  const items: Record<string, Item> = {};
  for (const item of raw.items) items[item.id] = normalizeItem(item, fusionResults);
  // Les composants des fusions et les cartes d'évènement viennent avec leur fiche complète :
  // on complète le catalogue si jamais une carte y manquait.
  for (const f of raw.fusions)
    for (const it of [f.item, ...f.items]) items[it.id] ??= normalizeItem(it, fusionResults);
  for (const e of raw.events)
    for (const it of e.items) items[it.id] ??= normalizeItem(it, fusionResults);

  const config: Catalog['config'] = {};
  for (const c of raw.config) {
    (config[c.rarity] ??= {})[toShiny(c.shinyLevel)] = {
      recycle: c.recycleValue,
      craft: c.craftValue,
    };
  }

  return {
    fetchedAt: fetchedAt.toISOString(),
    ruleSet,
    settings: {
      dailyReward: raw.settings.dailyReward,
      weeklyReward: raw.settings.weeklyReward,
      dailyLoreDust: raw.settings.dailyLoreDust,
      features: raw.settings.gameFeatures,
    },
    items,
    fusions: fusions.filter((f) => items[f.resultId] && f.inputs.every((i) => items[i.itemId])),
    config,
    events: raw.events.map(normalizeEvent),
    season: normalizeSeason(raw.season),
    towers: raw.towers.map((t) => ({ name: t.name, group: t.group, packId: t.pack.id })),
  };
}

/** Associe un défi à l'action du planificateur qui le fait progresser. */
export function challengeActionFor(type: string, description: string): ChallengeAction {
  const d = description.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (d.includes('constell')) return 'constellation';
  if (d.includes('enchant')) return 'enchant';
  if (d.includes('evolu')) return 'evolution';
  switch (type) {
    case 'FUSE':
      return 'fusion';
    case 'INVOKE':
      return 'invoke';
    case 'INVOKE_ITEMS':
      return 'invokeItems';
    case 'ASCEND':
      return 'ascension';
    case 'UPGRADE':
      return 'constellation';
    case 'CRAFT':
      return 'craft';
    case 'RECYCLE':
      return 'recycle';
    case 'LOOT':
      return 'loot';
    case 'WEEKLY':
      return 'weekly';
    case 'META_CHALLENGE':
      return 'challenge';
    default:
      return null;
  }
}

export function normalizeChallenge(raw: ApiChallenge): Challenge {
  const progress = raw.progress ?? { current: raw.challengeLog ? 1 : 0, max: 1 };
  return {
    id: raw.id,
    type: raw.challenge.type,
    description: raw.challenge.description,
    rewardLoreDust: raw.challenge.rewardLoreDust,
    score: raw.challenge.score,
    current: Math.min(progress.current, progress.max),
    max: progress.max,
    action: challengeActionFor(raw.challenge.type, raw.challenge.description),
  };
}

/** Succès pas encore obtenus (sans date d'obtention). */
export function normalizeAchievements(raw: ApiAchievementEntry[]): Achievement[] {
  return raw
    .filter((e) => !e.date)
    .map((e) => {
      const progress = e.progress ?? { current: 0, max: 1 };
      const max = Math.max(1, progress.max);
      return {
        id: e.achievement.id,
        name: e.achievement.name,
        description: e.achievement.description,
        score: e.achievement.score,
        rewardLoreDust: e.achievement.rewardLoreDust ?? 0,
        current: Math.min(Math.max(0, progress.current), max),
        max,
      };
    });
}

/**
 * Niveau d'une carte Constellation. L'API compte à rebours : `upgradeLevel` 1 est le niveau
 * maximum (égal à la rareté), `upgradeLevel` = rareté le premier niveau. C'est le calcul que fait
 * le site ZUnivers pour afficher « Niveau x/rareté » : niveau = rareté − upgradeLevel + 1.
 */
export function constellationLevel(upgradeLevel: number, rarity: number): number {
  if (upgradeLevel <= 0) return 0;
  return Math.min(rarity, Math.max(1, rarity - upgradeLevel + 1));
}

export function normalizeInventory(entries: ApiInventoryEntry[]): Record<string, OwnedCard> {
  const inventory: Record<string, OwnedCard> = {};
  for (const e of entries) {
    const shiny: Shiny = e.shinyLevel != null ? toShiny(e.shinyLevel) : e.isGolden ? 1 : 0;
    const key = cardKey(e.item.id, shiny);
    const card = (inventory[key] ??= { itemId: e.item.id, shiny, copies: 0, constellation: 0 });
    const level = constellationLevel(e.upgradeLevel ?? 0, e.item.rarity);
    // Une carte Constellation est une ligne distincte de l'inventaire : elle ne compte pas
    // parmi les exemplaires utilisables.
    if (level > 0) card.constellation = Math.max(card.constellation, level);
    else card.copies += e.quantity;
  }
  return inventory;
}

export function normalizeLoot(raw: ApiLoot): LootDay[] {
  return Object.entries(raw)
    .map(([date, loots]) => ({
      date: date.slice(0, 10),
      daily: loots.filter((l) => l.type === 'DAILY').length,
      weekly: loots.filter((l) => l.type === 'WEEKLY').length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface RawPlayer {
  user: ApiUser;
  inventory: ApiInventoryEntry[];
  challenges: ApiChallenge[];
  loot: ApiLoot;
  tower: ApiUserTower;
  evolution: ApiEvolution | null;
  corporation: ApiCorporation | null;
  /** Facultatif : absent des anciens instantanés. */
  overview?: ApiUserOverview | null;
  /** Facultatif : absent des anciens instantanés. */
  achievements?: ApiAchievementEntry[] | null;
}

const FINAL_EVOLUTION_SCORE = 600;

export function normalizePlayer(raw: RawPlayer, ruleSet = 'NORMAL'): Player {
  const u = raw.user;
  const currentTower = raw.tower.towerStats.find((s) => s.isCurrentTowerSeason);
  const evoItems = raw.evolution?.evolutionItems ?? [];
  return {
    id: u.user.id,
    discordId: u.user.discordId ?? null,
    name: u.user.discordUserName,
    displayName: u.user.discordGlobalName ?? u.user.discordUserName,
    avatar: u.user.discordAvatar ?? null,
    ruleSet: u.user.ruleSetType ?? ruleSet,
    balances: {
      balance: u.user.balance,
      loreDust: u.user.loreDust,
      loreFragment: u.user.loreFragment,
      upgradeDust: u.user.upgradeDust,
    },
    subscribed: u.isSubscribed ?? u.subscriptionBonusLimit > 0,
    corporation:
      raw.corporation && u.userCorporation?.corporation
        ? {
            id: raw.corporation.id,
            name: raw.corporation.name,
            bonuses: Object.fromEntries(
              raw.corporation.corporationBonuses.map((b) => [b.type, b.level]),
            ),
          }
        : null,
    inventory: normalizeInventory(raw.inventory),
    challenges: raw.challenges.map(normalizeChallenge),
    achievements: normalizeAchievements(raw.achievements ?? []),
    loot: normalizeLoot(raw.loot),
    lootStreak: u.currentLootStreak,
    tower: currentTower
      ? { floorIndex: currentTower.maxFloorIndex, logCount: currentTower.towerLogCount }
      : null,
    evolution:
      evoItems.length > 0
        ? {
            costs: raw.evolution?.evolutionUpgradeDustCost ?? [],
            steps: evoItems.map((e, i) => ({
              itemId: e.item.id,
              name: e.item.name,
              rarity: e.item.rarity,
              score:
                i === evoItems.length - 1
                  ? Math.max(e.item.scores['0'] ?? 0, FINAL_EVOLUTION_SCORE)
                  : (e.item.scores['0'] ?? 0),
              owned: e.isOwned,
            })),
          }
        : null,
    tradesLeft: Math.max(0, u.tradeLimit - u.tradeCountToday),
    invokeBeforePity: raw.overview?.invokeBeforePity ?? null,
    stats: {
      inventoryCount: u.inventoryCount,
      uniqueCount: u.inventoryUniqueCount,
      uniqueGoldenCount: u.inventoryUniqueGoldenCount,
    },
  };
}
