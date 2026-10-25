import {
  tradeKeepQuery,
  type PlanResult,
  type RuleSet,
  type TradeKeep,
  type TradePartners,
  type TradeResult,
} from '@zuninja/core';
import type { Settings } from './settings';

/** Mode autonome (GitHub Pages…) : tout est calculé dans le navigateur, sans serveur. */
export const STANDALONE = import.meta.env.VITE_STANDALONE === '1';

export class PlanError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function fetchFromServer(
  user: string,
  settings: Settings,
  fresh: boolean,
): Promise<PlanResult> {
  const params = new URLSearchParams({
    ruleset: settings.ruleSet,
    strategy: settings.strategy,
    beamWidth: String(settings.beamWidth),
    branching: String(settings.branching),
    keepExtra: String(settings.keepExtra),
    keepForGolden: settings.keepForGolden ? '1' : '0',
    keepForGoldenFusions: settings.keepForGoldenFusions ? '1' : '0',
    horizon: settings.horizon ? '1' : '0',
    horizonDiscount: String(settings.horizonDiscount),
    horizonSeasons: String(settings.horizonSeasons),
    skip: settings.skip.join(','),
    wBalance: String(settings.weights.balance),
    wLoreDust: String(settings.weights.loreDust),
    wLoreFragment: String(settings.weights.loreFragment),
    wUpgradeDust: String(settings.weights.upgradeDust),
  });
  if (fresh) params.set('fresh', '1');
  return getJson<PlanResult>(`./api/plan/${encodeURIComponent(user)}?${params}`);
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new PlanError('Impossible de joindre le serveur ZUnivers Ninja.', 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new PlanError(body?.error ?? `Erreur ${res.status}`, res.status);
  return body as T;
}

export async function fetchPlan(
  user: string,
  settings: Settings,
  fresh = false,
): Promise<PlanResult> {
  if (STANDALONE) {
    const { fetchStandalone } = await import('./standalone');
    return fetchStandalone(user, settings, fresh);
  }
  return fetchFromServer(user, settings, fresh);
}

export interface TradeQuery {
  me: string;
  other: string;
  ruleSet: RuleSet;
  keep: { me: TradeKeep; other: TradeKeep };
  fresh?: boolean;
}

/** Ce que deux joueurs peuvent s'échanger. */
export async function fetchTrade(query: TradeQuery): Promise<TradeResult> {
  if (STANDALONE) {
    const { tradeStandalone } = await import('./standalone');
    return tradeStandalone(query);
  }
  const params = new URLSearchParams({
    ruleset: query.ruleSet,
    keep: tradeKeepQuery(query.keep.me),
    otherKeep: tradeKeepQuery(query.keep.other),
  });
  if (query.fresh) params.set('fresh', '1');
  const path = [query.me, query.other].map(encodeURIComponent).join('/');
  return getJson<TradeResult>(`./api/trade/${path}?${params}`);
}

export interface PartnersQuery {
  me: string;
  ruleSet: RuleSet;
  keep: { me: TradeKeep; other: TradeKeep };
  /** Partenaires à comparer en plus (échanges récents). */
  names: string[];
  fresh?: boolean;
}

/** Les meilleurs joueurs avec qui échanger. */
export async function fetchPartners(query: PartnersQuery): Promise<TradePartners> {
  if (STANDALONE) {
    const { partnersStandalone } = await import('./standalone');
    return partnersStandalone(query);
  }
  const params = new URLSearchParams({
    ruleset: query.ruleSet,
    keep: tradeKeepQuery(query.keep.me),
    otherKeep: tradeKeepQuery(query.keep.other),
    with: query.names.join(','),
  });
  if (query.fresh) params.set('fresh', '1');
  return getJson<TradePartners>(`./api/partners/${encodeURIComponent(query.me)}?${params}`);
}
