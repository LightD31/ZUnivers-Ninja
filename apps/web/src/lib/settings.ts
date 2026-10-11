import {
  CURRENCIES,
  DEFAULT_OPTIONS,
  DEFAULT_STRATEGY,
  isStrategy,
  resolveOptions,
  type Balances,
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
  weights: Balances;
}

export const DEFAULT_SETTINGS: Settings = {
  ruleSet: 'NORMAL',
  strategy: DEFAULT_STRATEGY,
  beamWidth: DEFAULT_OPTIONS.beamWidth,
  branching: DEFAULT_OPTIONS.branching,
  keepExtra: DEFAULT_OPTIONS.keepExtra,
  weights: { ...DEFAULT_OPTIONS.weights },
};

const KEY = 'zuninja:settings';

export const loadSettings = (): Settings => {
  const stored = load<Partial<Settings>>(KEY, {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    strategy: isStrategy(stored.strategy) ? stored.strategy : DEFAULT_STRATEGY,
    weights: { ...DEFAULT_SETTINGS.weights, ...stored.weights },
  };
};
export const saveSettings = (s: Settings) => save(KEY, s);

/** Choisit une stratégie : les réglages affichés reprennent les valeurs de son préréglage. */
export function withStrategy(s: Settings, strategy: StrategyId): Settings {
  const preset = resolveOptions({ strategy });
  return { ...s, strategy, keepExtra: preset.keepExtra, weights: { ...preset.weights } };
}

/** Les réglages s'écartent du préréglage de la stratégie choisie. */
export function isCustomized(s: Settings): boolean {
  const preset = resolveOptions({ strategy: s.strategy });
  return (
    s.keepExtra !== preset.keepExtra || CURRENCIES.some((c) => s.weights[c] !== preset.weights[c])
  );
}

export function plannerOptions(s: Settings): PlannerOptionsInput {
  return {
    strategy: s.strategy,
    beamWidth: s.beamWidth,
    branching: s.branching,
    keepExtra: s.keepExtra,
    weights: s.weights,
  };
}
