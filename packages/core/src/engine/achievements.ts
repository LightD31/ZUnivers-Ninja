import {
  SHINIES,
  cardKey,
  type Achievement,
  type Catalog,
  type Item,
  type OwnedCard,
  type Player,
  type Shiny,
} from '../model/types';

/**
 * Actions comptées par les succès à compteur (« Recycler 100 cartes »…). `challenge` compte les
 * défis terminés, `weekChallenges` les semaines dont tous les défis sont terminés.
 */
export type AchievementCounter =
  'recycle' | 'fusion' | 'ascension' | 'challenge' | 'weekChallenges';

export interface GoalCard {
  itemId: string;
  /** Brillance à posséder, `null` pour n'importe laquelle. */
  shiny: Shiny | null;
}

/** Succès que le planificateur sait faire progresser. */
export interface AchievementGoal {
  id: string;
  name: string;
  description: string;
  score: number;
  rewardLoreDust: number;
  current: number;
  max: number;
  /** Cartes à réunir (succès de collection), `null` pour un succès à compteur. */
  cards: GoalCard[] | null;
  /** Les cartes doivent avoir leur constellation au niveau maximal. */
  constellation: boolean;
  counter: AchievementCounter | null;
}

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .trim();

const count = (text: string) => (/^une?$|^un$/.test(text) ? 1 : Number(text.replace(/\s/g, '')));

/**
 * La carte compte-t-elle pour le succès ? Comme pour les points de collection, une carte
 * Constellation seule ne vaut pas possession de la carte : il faut un exemplaire.
 */
export function goalCardMet(
  get: (shiny: Shiny) => OwnedCard | undefined,
  rarity: number,
  shiny: Shiny | null,
  constellation: boolean,
): boolean {
  for (const s of shiny === null ? SHINIES : [shiny]) {
    const card = get(s);
    if (!card) continue;
    if (constellation ? card.constellation >= rarity : card.copies > 0) return true;
  }
  return false;
}

const RE_CLASSIC = /^obtenir toutes les cartes (?:(★+) )?(dorees )?classiques$/;
const RE_CONSTELLATION =
  /^completer toutes les cartes constellation (?:(★+) )?(dorees )?classiques$/;
const RE_PACK = /^obtenir toutes les cartes du pack (.+)$/;
const RE_CARD = /^obtenir la carte (?:\S+ )?["«“]\s*(.+?)\s*["»”]$/;
const RE_FUSIONS = /^faire toutes les fusions classiques$/;
const RE_RECYCLE = /^recycler (une|[\d ]+) cartes? avec la commande/;
const RE_FUSION_COUNT = /^faire (une|[\d ]+) fusions? de cartes/;
const RE_CHALLENGES = /^completer (un|[\d ]+) defis?$/;
const RE_WEEK_CHALLENGES = /^completer tous les defis d'une semaine$/;
/**
 * Cartes d'une collection classique absentes du catalogue public (les cartes de boss, par exemple) :
 * l'API les compte, mais le planificateur ne peut ni les voir ni les obtenir.
 */
const OUTSIDE_CATALOG_MAX = 5;

/** Cartes visées par un succès de collection, d'après sa description. */
function goalCards(catalog: Catalog, items: Item[], description: string): GoalCard[] | null {
  const classic = RE_CLASSIC.exec(description) ?? RE_CONSTELLATION.exec(description);
  if (classic) {
    const rarity = classic[1]?.length;
    const golden = !!classic[2];
    const constellation = description.startsWith('completer');
    return (
      items
        .filter(
          (i) =>
            i.isClassic &&
            i.counting &&
            (rarity === undefined || i.rarity === rarity) &&
            i.shinyAvailable[golden ? 1 : 0] &&
            (!constellation || i.upgradable),
        )
        // Hors constellations, une carte normale peut être possédée dans n'importe quelle brillance.
        .map((i) => ({ itemId: i.id, shiny: golden ? 1 : constellation ? 0 : null }))
    );
  }

  const pack = RE_PACK.exec(description);
  if (pack) {
    const name = pack[1];
    return items
      .filter(
        (i) =>
          !i.isClassic &&
          i.counting &&
          (normalize(`${i.packName} ${i.packYear ?? ''}`) === name ||
            normalize(i.packName) === name),
      )
      .map((i) => ({ itemId: i.id, shiny: null }));
  }

  const single = RE_CARD.exec(description);
  if (single) {
    const item = items.find((i) => normalize(i.name) === single[1]);
    return item ? [{ itemId: item.id, shiny: null }] : null;
  }

  if (RE_FUSIONS.test(description)) {
    return catalog.fusions
      .filter((f) => catalog.items[f.resultId]?.isClassic)
      .map((f) => ({ itemId: f.resultId, shiny: null }));
  }
  return null;
}

function goalCounter(catalog: Catalog, description: string): AchievementCounter | null {
  if (RE_RECYCLE.test(description)) return 'recycle';
  if (RE_FUSION_COUNT.test(description)) return 'fusion';
  if (RE_CHALLENGES.test(description)) return 'challenge';
  if (RE_WEEK_CHALLENGES.test(description)) return 'weekChallenges';
  // « Participer à l'Ascension du ZEvent 2026 » : une ascension de la saison en cours suffit.
  const season = catalog.season;
  if (season && description === normalize(`participer a l'${season.towerName}`)) return 'ascension';
  return null;
}

/**
 * Succès que le planificateur sait faire progresser : collections (toutes les cartes d'une
 * rareté, d'un pack, toutes les constellations…) et compteurs (recyclages, fusions, ascension).
 *
 * L'API ne décrit un succès que par son texte. Pour ne jamais viser un mauvais objectif, un succès
 * de collection n'est retenu que si les cartes trouvées redonnent exactement la progression
 * affichée par l'API (possédées et total).
 */
export function resolveAchievements(
  catalog: Catalog,
  player: Player,
  items: Item[],
): AchievementGoal[] {
  const goals: AchievementGoal[] = [];
  for (const achievement of player.achievements) {
    const goal = resolveAchievement(catalog, player, items, achievement);
    if (goal) goals.push(goal);
  }
  return goals;
}

function resolveAchievement(
  catalog: Catalog,
  player: Player,
  items: Item[],
  achievement: Achievement,
): AchievementGoal | null {
  if (achievement.current >= achievement.max) return null;
  const description = normalize(achievement.description);
  const base = { ...achievement, constellation: false, cards: null, counter: null };

  const counter = goalCounter(catalog, description);
  if (counter) {
    const target = (RE_RECYCLE.exec(description) ??
      RE_FUSION_COUNT.exec(description) ??
      RE_CHALLENGES.exec(description))?.[1];
    const max = target ? count(target) : 1;
    if (!Number.isFinite(max) || max <= 0) return null;
    // Sans barre de progression dans l'API, on part de zéro : au pire, le succès arrive plus tard.
    const current = achievement.max === max ? achievement.current : 0;
    return { ...base, counter, max, current };
  }

  const cards = goalCards(catalog, items, description);
  if (!cards || cards.length === 0) return null;
  const constellation = RE_CONSTELLATION.test(description);
  let met = 0;
  for (const card of cards) {
    const rarity = catalog.items[card.itemId]?.rarity ?? 0;
    const get = (s: Shiny) => player.inventory[cardKey(card.itemId, s)];
    if (goalCardMet(get, rarity, card.shiny, constellation)) met++;
  }
  // Les cartes hors catalogue d'une collection classique ne s'obtiennent pas par le plan : le
  // succès n'est atteignable que si le joueur les a déjà toutes, ce que dit l'écart entre la
  // progression de l'API et les cartes trouvées.
  const outside = achievement.max - cards.length;
  const allowed = RE_CLASSIC.test(description) ? OUTSIDE_CATALOG_MAX : 0;
  if (outside < 0 || outside > allowed || achievement.current - met !== outside) return null;
  return { ...base, cards, constellation, current: met + outside };
}
