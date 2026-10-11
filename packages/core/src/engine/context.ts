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

export interface PlannerOptions {
  /** Largeur du faisceau (1 = glouton). */
  beamWidth: number;
  /** Nombre d'actions candidates explorées depuis chaque état. */
  branching: number;
  /** Nombre maximal d'actions de dépense dans un plan. */
  maxDepth: number;
  /** Valeur (en points de collection) d'une unité de chaque monnaie conservée. */
  weights: Balances;
  /** Valeur d'un point de réputation d'Ascension (améliore les récompenses du Vortex). */
  reputationWeight: number;
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
  beamWidth: 16,
  branching: 6,
  maxDepth: 400,
  weights: { balance: 0.002, loreDust: 0.01, loreFragment: 0.01, upgradeDust: 0.05 },
  reputationWeight: 0.001,
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

export function resolveOptions(input: PlannerOptionsInput = {}): PlannerOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...input,
    beamWidth: Math.max(1, Math.floor(input.beamWidth ?? DEFAULT_OPTIONS.beamWidth)),
    branching: Math.max(1, Math.floor(input.branching ?? DEFAULT_OPTIONS.branching)),
    keepExtra: Math.max(0, Math.floor(input.keepExtra ?? DEFAULT_OPTIONS.keepExtra)),
    weights: { ...DEFAULT_OPTIONS.weights, ...input.weights },
    allow: { ...DEFAULT_OPTIONS.allow, ...input.allow },
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
    itemList: Object.values(catalog.items).sort(
      (a, b) => a.identifier - b.identifier || a.id.localeCompare(b.id),
    ),
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
