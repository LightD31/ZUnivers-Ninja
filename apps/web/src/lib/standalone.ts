import type { PlanResult } from '@zuninja/core';
import { PlanError } from './api';
import { plannerOptions, type Settings } from './settings';

/** Calcul entièrement local : le planificateur tourne dans un Web Worker. */
let worker: Worker | null = null;
let nextId = 0;

export function fetchStandalone(
  user: string,
  settings: Settings,
  fresh: boolean,
): Promise<PlanResult> {
  worker ??= new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' });
  const id = ++nextId;
  const w = worker;
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      w.removeEventListener('message', onMessage);
      if (event.data.ok) resolve(event.data.plan as PlanResult);
      else reject(new PlanError(event.data.error, event.data.status ?? 500));
    };
    w.addEventListener('message', onMessage);
    w.postMessage({
      id,
      user,
      ruleSet: settings.ruleSet,
      options: plannerOptions(settings),
      fresh,
    });
  });
}
