import type { PlanResult, TradePartners, TradeResult } from '@zuninja/core';
import { PlanError, type PartnersQuery, type TradeQuery } from './api';
import { plannerOptions, type Settings } from './settings';

/** Calcul entièrement local : le planificateur tourne dans un Web Worker. */
let worker: Worker | null = null;
let nextId = 0;

function call<T>(message: Record<string, unknown>): Promise<T> {
  worker ??= new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' });
  const id = ++nextId;
  const w = worker;
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      w.removeEventListener('message', onMessage);
      if (event.data.ok) resolve(event.data.result as T);
      else reject(new PlanError(event.data.error, event.data.status ?? 500));
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ ...message, id });
  });
}

export function fetchStandalone(
  user: string,
  settings: Settings,
  fresh: boolean,
): Promise<PlanResult> {
  return call({
    type: 'plan',
    user,
    ruleSet: settings.ruleSet,
    options: plannerOptions(settings),
    fresh,
  });
}

export function tradeStandalone(query: TradeQuery): Promise<TradeResult> {
  return call({ type: 'trade', ...query, fresh: query.fresh ?? false });
}

export function partnersStandalone(query: PartnersQuery): Promise<TradePartners> {
  return call({ type: 'partners', ...query, fresh: query.fresh ?? false });
}
