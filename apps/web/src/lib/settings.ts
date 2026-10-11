import {
  DEFAULT_OPTIONS,
  type Balances,
  type PlannerOptionsInput,
  type RuleSet,
} from '@zuninja/core';
import { load, save } from './storage';

export interface Settings {
  ruleSet: RuleSet;
  beamWidth: number;
  branching: number;
  keepExtra: number;
  weights: Balances;
}

export const DEFAULT_SETTINGS: Settings = {
  ruleSet: 'NORMAL',
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
    weights: { ...DEFAULT_SETTINGS.weights, ...stored.weights },
  };
};
export const saveSettings = (s: Settings) => save(KEY, s);

export function plannerOptions(s: Settings): PlannerOptionsInput {
  return {
    beamWidth: s.beamWidth,
    branching: s.branching,
    keepExtra: s.keepExtra,
    weights: s.weights,
  };
}
