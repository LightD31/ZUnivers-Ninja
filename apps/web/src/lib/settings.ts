import {
  CURRENCIES,
  DEFAULT_OPTIONS,
  DEFAULT_STRATEGY,
  OPTIONAL_ACTIONS,
  allowExcept,
  isOptionalAction,
  isStrategy,
  plannerQuery,
  queryOptions,
  resolveOptions,
  type Balances,
  type OptionalAction,
  type PlannerOptionsInput,
  type QueryOptions,
  type RuleSet,
  type StrategyId,
} from '@zuninja/core';
import { load, save } from './storage';

export interface Settings {
  ruleSet: RuleSet;
  strategy: StrategyId;
  beamWidth: number;
  branching: number;
  keepExtra: number;
  keepForGolden: boolean;
  keepForGoldenFusions: boolean;
  /** Anticipe les prochains Vortex et essais d'ascension : un choix du joueur, gardé d'une stratégie à l'autre. */
  horizon: boolean;
  /** Réglages de l'anticipation, eux aussi gardés d'une stratégie à l'autre (voir `PlannerOptions`). */
  horizonDiscount: number;
  horizonSeasons: number;
  /** Actions que le joueur ne veut pas faire : le plan ne les propose jamais. */
  skip: OptionalAction[];
  weights: Balances;
}

export const DEFAULT_SETTINGS: Settings = {
  ruleSet: 'NORMAL',
  strategy: DEFAULT_STRATEGY,
  beamWidth: DEFAULT_OPTIONS.beamWidth,
  branching: DEFAULT_OPTIONS.branching,
  keepExtra: DEFAULT_OPTIONS.keepExtra,
  keepForGolden: DEFAULT_OPTIONS.keepForGolden,
  keepForGoldenFusions: DEFAULT_OPTIONS.keepForGoldenFusions,
  horizon: DEFAULT_OPTIONS.horizon,
  horizonDiscount: DEFAULT_OPTIONS.horizonDiscount,
  horizonSeasons: DEFAULT_OPTIONS.horizonSeasons,
  skip: [],
  weights: { ...DEFAULT_OPTIONS.weights },
};

const KEY = 'zuninja:settings';

export const loadSettings = (): Settings => {
  const stored = load<Partial<Settings>>(KEY, {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    strategy: isStrategy(stored.strategy) ? stored.strategy : DEFAULT_STRATEGY,
    skip: Array.isArray(stored.skip) ? stored.skip.filter(isOptionalAction) : [],
    weights: { ...DEFAULT_SETTINGS.weights, ...stored.weights },
  };
};
export const saveSettings = (s: Settings) => save(KEY, s);

/**
 * Choisit une stratégie : les réglages affichés reprennent les valeurs de son préréglage. Les
 * actions refusées restent refusées : c'est un choix du joueur, pas de la stratégie.
 */
export function withStrategy(s: Settings, strategy: StrategyId): Settings {
  const preset = resolveOptions({ strategy });
  return {
    ...s,
    strategy,
    keepExtra: preset.keepExtra,
    keepForGolden: preset.keepForGolden,
    keepForGoldenFusions: preset.keepForGoldenFusions,
    weights: { ...preset.weights },
  };
}

/** Les réglages s'écartent du préréglage de la stratégie choisie. */
export function isCustomized(s: Settings): boolean {
  const preset = resolveOptions({ strategy: s.strategy });
  return (
    s.keepExtra !== preset.keepExtra ||
    s.keepForGolden !== preset.keepForGolden ||
    s.keepForGoldenFusions !== preset.keepForGoldenFusions ||
    s.horizon !== preset.horizon ||
    s.horizonDiscount !== preset.horizonDiscount ||
    s.horizonSeasons !== preset.horizonSeasons ||
    OPTIONAL_ACTIONS.some((a) => s.skip.includes(a) === preset.allow[a]) ||
    CURRENCIES.some((c) => s.weights[c] !== preset.weights[c])
  );
}

export function plannerOptions(s: Settings): PlannerOptionsInput {
  return {
    strategy: s.strategy,
    beamWidth: s.beamWidth,
    branching: s.branching,
    keepExtra: s.keepExtra,
    keepForGolden: s.keepForGolden,
    keepForGoldenFusions: s.keepForGoldenFusions,
    horizon: s.horizon,
    horizonDiscount: s.horizonDiscount,
    horizonSeasons: s.horizonSeasons,
    allow: allowExcept(s.skip),
    weights: s.weights,
  };
}

/** Les options que ces réglages donnent au planificateur, telles qu'un lien les porte. */
export const linkOptions = (s: Settings): QueryOptions =>
  queryOptions(resolveOptions(plannerOptions(s)));

/** Mêmes réglages du planificateur (le mode de jeu mis à part) : ils donnent le même plan. */
export const sameSettings = (a: Settings, b: Settings) =>
  JSON.stringify(plannerQuery(linkOptions(a))) === JSON.stringify(plannerQuery(linkOptions(b)));

/**
 * Réglages d'un lien partagé : le préréglage de sa stratégie, puis les options du lien, comme pour
 * celui qui l'a partagé (voir `plannerQuery`).
 */
export function settingsFromQuery(ruleSet: RuleSet, input: PlannerOptionsInput): Settings {
  const o = resolveOptions(input);
  return {
    ruleSet,
    strategy: o.strategy,
    beamWidth: o.beamWidth,
    branching: o.branching,
    keepExtra: o.keepExtra,
    keepForGolden: o.keepForGolden,
    keepForGoldenFusions: o.keepForGoldenFusions,
    horizon: o.horizon,
    horizonDiscount: o.horizonDiscount,
    horizonSeasons: o.horizonSeasons,
    skip: OPTIONAL_ACTIONS.filter((a) => !o.allow[a]),
    weights: { ...o.weights },
  };
}
