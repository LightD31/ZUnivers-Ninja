import {
  CURRENCIES,
  DEFAULT_OPTIONS,
  DEFAULT_STRATEGY,
  OPTIONAL_ACTIONS,
  allowExcept,
  isOptionalAction,
  isStrategy,
  resolveOptions,
  type Balances,
  type OptionalAction,
  type PlannerOptionsInput,
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
    allow: allowExcept(s.skip),
    weights: s.weights,
  };
}
