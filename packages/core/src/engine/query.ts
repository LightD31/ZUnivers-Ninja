import { CURRENCIES, type Currency } from '../model/types';
import {
  HORIZON_SEASONS_MAX,
  OPTIONAL_ACTIONS,
  allowExcept,
  isOptionalAction,
  resolveOptions,
  type PlannerOptionsInput,
  type QueryOptions,
} from './context';
import { isStrategy } from './strategies';
import { TRADE_KEEP_KEYS, type TradeKeep } from './trade';

/**
 * Paramètres des options du planificateur, les mêmes pour l'API (`/api/plan`) et les liens vers
 * l'interface : un lien partagé reproduit exactement le plan.
 */

/** Paramètre de chaque poids de monnaie. */
const WEIGHT_PARAMS: Record<Currency, string> = {
  balance: 'wBalance',
  loreDust: 'wLoreDust',
  loreFragment: 'wLoreFragment',
  upgradeDust: 'wUpgradeDust',
};

const clamp = (value: string | undefined, min: number, max: number): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

/** Options du planificateur lues dans la requête, bornées pour éviter les abus. */
export function parsePlannerQuery(query: Record<string, string | undefined>): PlannerOptionsInput {
  const options: PlannerOptionsInput = {};
  if (isStrategy(query.strategy)) options.strategy = query.strategy;
  const beamWidth = clamp(query.beamWidth, 1, 64);
  const branching = clamp(query.branching, 1, 16);
  const keepExtra = clamp(query.keepExtra, 0, 10);
  if (beamWidth !== undefined) options.beamWidth = beamWidth;
  if (branching !== undefined) options.branching = branching;
  if (keepExtra !== undefined) options.keepExtra = keepExtra;
  if (query.keepForGolden === '0' || query.keepForGolden === '1')
    options.keepForGolden = query.keepForGolden === '1';
  if (query.keepForGoldenFusions === '0' || query.keepForGoldenFusions === '1')
    options.keepForGoldenFusions = query.keepForGoldenFusions === '1';
  if (query.horizon === '0' || query.horizon === '1') options.horizon = query.horizon === '1';
  const horizonDiscount = clamp(query.horizonDiscount, 0, 1);
  const horizonSeasons = clamp(query.horizonSeasons, 1, HORIZON_SEASONS_MAX);
  if (horizonDiscount !== undefined) options.horizonDiscount = horizonDiscount;
  if (horizonSeasons !== undefined) options.horizonSeasons = horizonSeasons;
  // Actions refusées, séparées par des virgules. Présent (même vide), il remplace celles du
  // serveur : `skip=` les autorise toutes.
  if (query.skip !== undefined)
    options.allow = allowExcept(query.skip.split(',').filter(isOptionalAction));
  const weights: NonNullable<PlannerOptionsInput['weights']> = {};
  for (const currency of CURRENCIES) {
    const weight = clamp(query[WEIGHT_PARAMS[currency]], 0, 10);
    if (weight !== undefined) weights[currency] = weight;
  }
  if (Object.keys(weights).length > 0) options.weights = weights;
  return options;
}

/**
 * Paramètres qui reproduisent ces options, l'inverse de `parsePlannerQuery` : la stratégie, puis
 * seulement ce qui s'écarte de son préréglage, pour des liens courts.
 */
export function plannerQuery(options: QueryOptions): Record<string, string> {
  const preset = resolveOptions({ strategy: options.strategy });
  const query: Record<string, string> = { strategy: preset.strategy };
  const numbers = [
    'beamWidth',
    'branching',
    'keepExtra',
    'horizonDiscount',
    'horizonSeasons',
  ] as const;
  for (const key of numbers) if (options[key] !== preset[key]) query[key] = String(options[key]);
  const flags = ['keepForGolden', 'keepForGoldenFusions', 'horizon'] as const;
  for (const key of flags) if (options[key] !== preset[key]) query[key] = options[key] ? '1' : '0';
  // Toutes les actions refusées, même vide (`skip=`) : présent, il remplace celles par défaut.
  if (OPTIONAL_ACTIONS.some((a) => options.allow[a] !== preset.allow[a]))
    query.skip = OPTIONAL_ACTIONS.filter((a) => !options.allow[a]).join(',');
  for (const currency of CURRENCIES)
    if (options.weights[currency] !== preset.weights[currency])
      query[WEIGHT_PARAMS[currency]] = String(options.weights[currency]);
  return query;
}

/**
 * Exemplaires gardés par un joueur lors d'un échange (`golden,goldenFusions,constellation`).
 * Absent : tout est gardé ; présent mais vide : rien.
 */
export function parseTradeKeep(value: string | undefined): Partial<TradeKeep> {
  if (value === undefined) return {};
  const keys = new Set(value.split(',').map((k) => k.trim()));
  return Object.fromEntries(TRADE_KEEP_KEYS.map((k) => [k, keys.has(k)]));
}

/** Exemplaires gardés, au format de `parseTradeKeep` (`golden,constellation`). */
export const tradeKeepQuery = (keep: TradeKeep) => TRADE_KEEP_KEYS.filter((k) => keep[k]).join(',');
