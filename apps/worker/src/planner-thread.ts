import { parentPort } from 'node:worker_threads';
import { createPlan, type CreatePlanInput } from '@zuninja/core';

/** Thread de calcul : le planificateur occupe le CPU sans bloquer le serveur HTTP. */
parentPort!.on('message', (input: CreatePlanInput) => {
  try {
    parentPort!.postMessage({ ok: true, plan: createPlan(input) });
  } catch (error) {
    parentPort!.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
