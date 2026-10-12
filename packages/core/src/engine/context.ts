import { FEATURE } from '../rules/constants';
import {
  type Balances,
  type Catalog,
  type Currency,
  type Fusion,
  type Item,
  type Player,
  type RarityConfig,
  type Shiny,
} from '../model/types';
import { resolveAchievements, type AchievementGoal } from './achievements';
import { DEFAULT_STRATEGY, STRATEGIES, isStrategy, type StrategyId } from './strategies';

export interface PlannerOptions {
  /** Stratégie dont les options sont issues (préréglage, avant les options explicites). */
  strategy: StrategyId;
  /** Largeur du faisceau (1 = glouton). */
  beamWidth: number;
  /** Nombre d'actions candidates explorées depuis chaque état. */
  branching: number;
  /** Nombre maximal d'actions de dépense dans un plan. */
  maxDepth: number;
  /**
   * Temps de recherche maximal (ms, 0 = illimité). Au-delà, la fin du plan est cherchée en
   * glouton depuis le meilleur état du faisceau : le plan reste complet, juste moins optimisé.
   */
  timeLimitMs: number;
  /** Valeur (en points de collection) d'une unité de chaque monnaie conservée. */
  weights: Balances;
  /** Valeur d'un point de réputation d'Ascension (améliore les récompenses du Vortex). */
  reputationWeight: number;
  /** Part de l'espérance des actions aléatoires (invocations, ascensions) prise en compte, de 0 à 1. */
  evFactor: number;
  /** Points ajoutés pour chaque carte (et brillance) jamais possédée qui entre dans la collection. */
  newCardBonus: number;
  /** Exemplaires supplémentaires à garder pour les échanges. */
  keepExtra: number;
  /** Actions autorisées. */
  allow: {
    recycle: boolean;
    craft: boolean;
    enchant: boolean;
    fusion: boolean;
    constellation: boolean;
    invoke: boolean;
    ascension: boolean;
    evolution: boolean;
  };
}

export const DEFAULT_OPTIONS: PlannerOptions = {
  strategy: DEFAULT_STRATEGY,
  // Mesuré sur 162 joueurs réels : 8 × 4 fait à 0,03 % près les plans de 16 × 6, et 64 × 12 les
  // mêmes, en deux fois moins de temps. Les chaînes d'actions et le prix d'opportunité des monnaies
  // font l'essentiel, plus la largeur du faisceau.
  beamWidth: 8,
  branching: 4,
  maxDepth: 400,
  timeLimitMs: 0,
  weights: { balance: 0.002, loreDust: 0.01, loreFragment: 0.01, upgradeDust: 0.05 },
  reputationWeight: 0.001,
  evFactor: 1,
  newCardBonus: 0,
  keepExtra: 0,
  allow: {
    recycle: true,
    craft: true,
    enchant: true,
    fusion: true,
    constellation: true,
    invoke: true,
    ascension: true,
    evolution: true,
  },
};

export type PlannerOptionsInput = Partial<Omit<PlannerOptions, 'weights' | 'allow'>> & {
  weights?: Partial<Balances>;
  allow?: Partial<PlannerOptions['allow']>;
};

const finite = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

/**
 * Options complètes : valeurs par défaut, puis préréglage de la stratégie choisie, puis options
 * explicites (qui l'emportent toujours sur le préréglage).
 */
export function resolveOptions(input: PlannerOptionsInput = {}): PlannerOptions {
  const strategy = isStrategy(input.strategy) ? input.strategy : DEFAULT_STRATEGY;
  const preset = STRATEGIES[strategy].options;
  const base: PlannerOptions = {
    ...DEFAULT_OPTIONS,
    ...preset,
    strategy,
    weights: { ...DEFAULT_OPTIONS.weights, ...preset.weights },
    allow: { ...DEFAULT_OPTIONS.allow, ...preset.allow },
  };
  return {
    ...base,
    ...input,
    strategy,
    beamWidth: Math.max(1, Math.floor(finite(input.beamWidth, base.beamWidth))),
    branching: Math.max(1, Math.floor(finite(input.branching, base.branching))),
    maxDepth: Math.max(0, Math.floor(finite(input.maxDepth, base.maxDepth))),
    keepExtra: Math.max(0, Math.floor(finite(input.keepExtra, base.keepExtra))),
    timeLimitMs: Math.max(0, finite(input.timeLimitMs, base.timeLimitMs)),
    reputationWeight: Math.max(0, finite(input.reputationWeight, base.reputationWeight)),
    evFactor: Math.min(1, Math.max(0, finite(input.evFactor, base.evFactor))),
    newCardBonus: Math.max(0, finite(input.newCardBonus, base.newCardBonus)),
    weights: { ...base.weights, ...input.weights },
    allow: { ...base.allow, ...input.allow },
  };
}

/** Données dérivées, calculées une fois par plan. */
export interface Context {
  catalog: Catalog;
  player: Player;
  now: Date;
  options: PlannerOptions;
  items: Record<string, Item>;
  fusionsByInput: Map<string, Fusion[]>;
  fusionsByResult: Map<string, Fusion>;
  /** Packs dont les cartes sont forgeables (Classique + groupe de l'Ascension en cours). */
  forgeablePacks: Set<string>;
  features: Set<string>;
  /** Corporation : bonus de ZUMonnaie par récompense, et multiplicateur de recyclage par monnaie. */
  corporation: { loot: number; recycle: Partial<Record<Currency, number>> };
  /** Toutes les cartes connues, triées par numéro (ordre stable pour le déterminisme). */
  itemList: Item[];
  /** Succès que le planificateur sait faire progresser. */
  achievements: AchievementGoal[];
  /** Succès de collection concernés par chaque carte (index dans `achievements`). */
  achievementsByItem: Map<string, { index: number; shiny: Shiny | null }[]>;
}

export function buildContext(
  catalog: Catalog,
  player: Player,
  now: Date,
  options: PlannerOptions,
): Context {
  const fusionsByInput = new Map<string, Fusion[]>();
  const fusionsByResult = new Map<string, Fusion>();
  for (const f of catalog.fusions) {
    fusionsByResult.set(f.resultId, f);
    for (const input of f.inputs) {
      const list = fusionsByInput.get(input.itemId) ?? [];
      list.push(f);
      fusionsByInput.set(input.itemId, list);
    }
  }

  const forgeablePacks = new Set<string>();
  if (catalog.season) {
    forgeablePacks.add(catalog.season.packId);
    for (const t of catalog.towers)
      if (t.group === catalog.season.group) forgeablePacks.add(t.packId);
  }

  // Une liste vide signifie que l'API ne renseigne pas les fonctionnalités : tout est actif.
  const features = new Set(catalog.settings.features);
  if (features.size === 0) for (const f of Object.values(FEATURE)) features.add(f);

  const bonuses = player.corporation?.bonuses ?? {};
  const triangular = (level: number) => (level * (level + 1)) / 2;
  const corporation = {
    loot: triangular(bonuses.LOOT ?? 0) * 10,
    recycle: {
      loreDust: triangular(bonuses.RECYCLE_LORE_DUST ?? 0) * 0.01,
      loreFragment: triangular(bonuses.RECYCLE_LORE_FRAGMENT ?? 0) * 0.01,
    },
  };

  const itemList = Object.values(catalog.items).sort(
    (a, b) => a.identifier - b.identifier || a.id.localeCompare(b.id),
  );
  const achievements = resolveAchievements(catalog, player, itemList);
  const achievementsByItem = new Map<string, { index: number; shiny: Shiny | null }[]>();
  achievements.forEach((goal, index) => {
    for (const card of goal.cards ?? []) {
      const list = achievementsByItem.get(card.itemId) ?? [];
      list.push({ index, shiny: card.shiny });
      achievementsByItem.set(card.itemId, list);
    }
  });

  return {
    catalog,
    player,
    now,
    options,
    items: catalog.items,
    fusionsByInput,
    fusionsByResult,
    forgeablePacks,
    features,
    corporation,
    itemList,
    achievements,
    achievementsByItem,
  };
}

export const hasFeature = (ctx: Context, feature: string) => ctx.features.has(feature);

export function rarityConfig(ctx: Context, rarity: number, shiny: Shiny): RarityConfig | undefined {
  return ctx.catalog.config[rarity]?.[shiny];
}

/** Monnaie de forge d'une carte : poudre pour le Classique, cristaux pour les packs d'évènement. */
export const forgeCurrency = (item: Item): Currency =>
  item.isClassic ? 'loreDust' : 'loreFragment';

/** Les cartes d'évènement ne sont forgeables / enchantables que pendant leur Vortex (source : /forge). */
export const isForgeableNow = (ctx: Context, item: Item) =>
  item.isClassic || ctx.forgeablePacks.has(item.packId);

export function craftCost(ctx: Context, item: Item): number | undefined {
  if (!item.craftable || item.isFusion || item.isStar || !isForgeableNow(ctx, item))
    return undefined;
  const cost = rarityConfig(ctx, item.rarity, 0)?.craft;
  return cost && cost > 0 ? cost : undefined;
}

export function enchantCost(ctx: Context, item: Item): number | undefined {
  if (!item.goldable || item.isFusion || item.isStar || !item.shinyAvailable[1]) return undefined;
  if (!isForgeableNow(ctx, item)) return undefined;
  const cost = rarityConfig(ctx, item.rarity, 1)?.craft;
  return cost && cost > 0 ? cost : undefined;
}

/** Peut-on enchanter cette carte un jour (même hors période de Vortex) ? */
export const isEnchantable = (ctx: Context, item: Item) =>
  item.goldable &&
  !item.isFusion &&
  !item.isStar &&
  item.shinyAvailable[1] &&
  !!rarityConfig(ctx, item.rarity, 1)?.craft;

/**
 * Gain d'un recyclage. Une carte fusion rapporte le recyclage de chacun de ses composants
 * (source : /forge). Le bonus de corporation s'applique.
 */
export function recycleGain(ctx: Context, item: Item, shiny: Shiny, depth = 0): Partial<Balances> {
  const fusion = item.isFusion ? ctx.fusionsByResult.get(item.id) : undefined;
  if (fusion && depth < 4) {
    const total: Partial<Balances> = {};
    for (const input of fusion.inputs) {
      const component = ctx.items[input.itemId];
      if (!component) continue;
      const gain = recycleGain(ctx, component, shiny, depth + 1);
      for (const [c, v] of Object.entries(gain) as [Currency, number][])
        total[c] = (total[c] ?? 0) + v * input.quantity;
    }
    return total;
  }
  const base = rarityConfig(ctx, item.rarity, shiny)?.recycle ?? 0;
  if (base <= 0) return {};
  const currency = forgeCurrency(item);
  const bonus = ctx.corporation.recycle[currency] ?? 0;
  return { [currency]: base + Math.floor(base * bonus) };
}

export function canRecycle(ctx: Context, item: Item, shiny: Shiny): boolean {
  if (!item.recyclable || item.isStar) return false;
  const gain = recycleGain(ctx, item, shiny);
  return Object.values(gain).some((v) => v > 0);
}
