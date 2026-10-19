import type { SeasonForecast } from '../rules/calendar';
import { CURRENCIES, type Balances, type Currency } from '../model/types';

/**
 * Valeur de garde des monnaies (option `horizon`) : ce que rapporteront plus tard les unités
 * gardées aujourd'hui, au-delà de leur poids. C'est une courbe concave par paliers : les premières
 * unités gardées servent aux dépenses à venir les plus rentables, les suivantes à des dépenses
 * moins rentables, et au-delà de tout ce qui sera dépensé une unité ne vaut plus que son poids.
 * Calculée par `horizon.ts` ; ce module ne dépend pas du moteur, pour que `stateValue` l'utilise.
 */

export interface HoldStep {
  amount: number;
  /** Points par unité au-delà du poids de la monnaie, probabilité et attente comprises. */
  value: number;
  /** Index de la source dans `Horizon.sources`. */
  source: number;
}

export interface HoldCurve {
  /**
   * Revenu certain d'ici là (récompenses quotidiennes) : il couvre d'abord les dépenses à venir,
   * les unités gardées aujourd'hui ne servent qu'au-delà.
   */
  offset: number;
  /** Paliers par valeur décroissante. */
  steps: HoldStep[];
  /** Montant et valeur cumulés avant chaque palier. */
  starts: number[];
  totals: number[];
}

export type HoldCurves = Partial<Record<Currency, HoldCurve>>;

/** Période à venir qui donne de la valeur aux monnaies gardées. */
export interface HoldSource {
  currency: Currency;
  kind: 'vortex' | 'ascension' | 'event';
  /** Groupe du Vortex, nom de l'évènement… */
  label: string;
  /** Dates AAAA-MM-JJ de la période, fin exclue. */
  begin: string;
  end: string;
  /** Probabilité que la période ait lieu dans l'horizon (groupe de Vortex prévu). */
  probability: number;
  /** Essais d'ascension encore à créditer (source `ascension`). */
  count?: number;
}

export interface Horizon {
  curves: HoldCurves;
  sources: HoldSource[];
  forecasts: SeasonForecast[];
  stats: {
    /** Périodes à venir simulées. */
    windows: number;
    /** Périodes écartées par les heuristiques (inutiles, improbables, hors budget…). */
    skipped: number;
    durationMs: number;
  };
}

/** Courbe d'une monnaie, `null` sans aucune dépense à venir qui rapporte. */
export function holdCurve(steps: HoldStep[], offset: number): HoldCurve | null {
  // Tri stable : à valeur égale, l'ordre des sources est gardé (plan déterministe).
  const sorted = steps.filter((s) => s.amount > 0 && s.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length === 0) return null;
  const starts: number[] = [];
  const totals: number[] = [];
  let amount = 0;
  let total = 0;
  for (const step of sorted) {
    starts.push(amount);
    totals.push(total);
    amount += step.amount;
    total += step.amount * step.value;
  }
  return { offset: Math.max(0, offset), steps: sorted, starts, totals };
}

/** Valeur des `x` premières unités dépensées plus tard. */
function cumulative(curve: HoldCurve, x: number): number {
  if (x <= 0) return 0;
  // Dernier palier commencé avant `x`.
  let lo = 0;
  let hi = curve.steps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (curve.starts[mid]! < x) lo = mid;
    else hi = mid - 1;
  }
  const step = curve.steps[lo]!;
  return curve.totals[lo]! + Math.min(x - curve.starts[lo]!, step.amount) * step.value;
}

/** Valeur de garde de `x` unités. */
export const curveValue = (curve: HoldCurve, x: number) =>
  cumulative(curve, x + curve.offset) - cumulative(curve, curve.offset);

/** Valeur de garde d'un solde. */
export function holdValue(curves: HoldCurves, balances: Balances): number {
  let value = 0;
  for (const c of CURRENCIES) {
    const curve = curves[c];
    if (curve) value += curveValue(curve, balances[c]);
  }
  return value;
}

/** Valeur de garde perdue en payant `price` : ce que ces monnaies auraient rapporté plus tard. */
export function holdCost(curves: HoldCurves, balances: Balances, price: Partial<Balances>): number {
  let cost = 0;
  for (const c of CURRENCIES) {
    const curve = curves[c];
    const amount = price[c];
    if (!curve || !amount) continue;
    cost += curveValue(curve, balances[c]) - curveValue(curve, Math.max(0, balances[c] - amount));
  }
  return cost;
}
