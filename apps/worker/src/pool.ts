import { Worker } from 'node:worker_threads';
import type { CreatePlanInput, PlanResult } from '@zuninja/core';

/** Tous les threads sont occupés et la file d'attente est pleine. */
export class PlannerBusyError extends Error {
  constructor() {
    super('Trop de calculs en cours.');
    this.name = 'PlannerBusyError';
  }
}

/** Le calcul a dépassé le délai maximal : son thread a été arrêté. */
export class PlannerTimeoutError extends Error {
  constructor(ms: number) {
    super(`Calcul interrompu après ${Math.round(ms / 1000)} s.`);
    this.name = 'PlannerTimeoutError';
  }
}

/** Plus personne n'attend ce calcul : il a été retiré de la file ou son thread arrêté. */
export class PlanAbortedError extends Error {
  constructor() {
    super('Calcul annulé.');
    this.name = 'PlanAbortedError';
  }
}

export interface PoolOptions {
  threads: number;
  /** Calculs en attente au-delà desquels `run` échoue immédiatement. */
  queueLimit: number;
  /** Délai (ms) au-delà duquel le thread est arrêté, 0 = aucun. */
  timeoutMs: number;
}

interface Job {
  input: CreatePlanInput;
  signal: AbortSignal | undefined;
  resolve: (plan: PlanResult) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

interface Slot {
  worker: Worker | null;
  job: Job | null;
  timer: NodeJS.Timeout | undefined;
}

type Reply = { ok: true; plan: PlanResult } | { ok: false; message: string };

// Bundle (dist/*.js) en production, sources TypeScript via tsx en dev et dans les tests.
const fromSources = import.meta.url.endsWith('.ts');
const THREAD_URL = new URL(
  fromSources ? './planner-thread.ts' : './planner-thread.js',
  import.meta.url,
);
const THREAD_OPTIONS = {
  ...(fromSources ? { execArgv: ['--import', 'tsx'] } : {}),
  // Un calcul qui s'emballe tue son thread, pas tout le serveur.
  resourceLimits: { maxOldGenerationSizeMb: 512 },
};

/**
 * Exécute les plans dans des threads dédiés : le serveur reste réactif pendant les calculs, la
 * file d'attente est bornée, et un calcul abandonné ou trop long libère aussitôt son thread.
 */
export class PlannerPool {
  private readonly slots: Slot[];
  private readonly queue: Job[] = [];
  private readonly options: PoolOptions;

  constructor(options: PoolOptions) {
    this.options = options;
    this.slots = Array.from({ length: Math.max(1, options.threads) }, () => ({
      worker: null,
      job: null,
      timer: undefined,
    }));
  }

  /** Vrai si un nouveau calcul serait refusé. */
  get saturated(): boolean {
    return this.slots.every((s) => s.job) && this.queue.length >= this.options.queueLimit;
  }

  run(input: CreatePlanInput, signal?: AbortSignal): Promise<PlanResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new PlanAbortedError());
      const job: Job = { input, signal, resolve, reject, onAbort: () => this.abort(job) };
      const slot = this.slots.find((s) => !s.job);
      if (slot) this.start(slot, job);
      else if (this.queue.length < this.options.queueLimit) this.queue.push(job);
      else return reject(new PlannerBusyError());
      signal?.addEventListener('abort', job.onAbort, { once: true });
    });
  }

  /** Arrête tous les threads et rejette les calculs en cours ou en attente. */
  async close(): Promise<void> {
    for (const job of this.queue.splice(0))
      this.settle(job, () => job.reject(new PlanAbortedError()));
    const exits = this.slots.map((slot) => {
      const worker = slot.worker;
      slot.worker = null;
      const job = slot.job;
      if (job) this.finish(slot, () => job.reject(new PlanAbortedError()));
      return worker?.terminate();
    });
    await Promise.all(exits);
  }

  private abort(job: Job) {
    const queued = this.queue.indexOf(job);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.settle(job, () => job.reject(new PlanAbortedError()));
      return;
    }
    const slot = this.slots.find((s) => s.job === job);
    if (!slot) return;
    this.kill(slot);
    this.finish(slot, () => job.reject(new PlanAbortedError()));
  }

  private start(slot: Slot, job: Job) {
    slot.job = job;
    try {
      const worker = (slot.worker ??= this.spawn(slot));
      worker.ref();
      worker.postMessage(job.input);
    } catch (error) {
      this.kill(slot);
      this.finish(slot, () =>
        job.reject(error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    const { timeoutMs } = this.options;
    if (timeoutMs > 0) {
      slot.timer = setTimeout(() => {
        this.kill(slot);
        this.finish(slot, () => job.reject(new PlannerTimeoutError(timeoutMs)));
      }, timeoutMs);
    }
  }

  private spawn(slot: Slot): Worker {
    const worker = new Worker(THREAD_URL, THREAD_OPTIONS);
    // Un thread arrêté volontairement (kill) a déjà été remplacé : ses évènements sont ignorés.
    const fail = (error: Error) => {
      if (slot.worker !== worker) return;
      slot.worker = null;
      void worker.terminate();
      const job = slot.job;
      if (job) this.finish(slot, () => job.reject(error));
    };
    worker.on('message', (reply: Reply) => {
      const job = slot.job;
      if (slot.worker !== worker || !job) return;
      // Un thread inoccupé n'empêche pas le processus de s'arrêter (mode --once).
      worker.unref();
      this.finish(slot, () =>
        reply.ok ? job.resolve(reply.plan) : job.reject(new Error(reply.message)),
      );
    });
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`Thread de calcul arrêté (code ${code}).`)));
    return worker;
  }

  private kill(slot: Slot) {
    const worker = slot.worker;
    slot.worker = null;
    void worker?.terminate();
  }

  /** Libère le thread, règle le calcul, puis lance le suivant dans la file. */
  private finish(slot: Slot, settle: () => void) {
    const job = slot.job!;
    clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.job = null;
    this.settle(job, settle);
    const next = this.queue.shift();
    if (next) this.start(slot, next);
  }

  private settle(job: Job, settle: () => void) {
    job.signal?.removeEventListener('abort', job.onAbort);
    settle();
  }
}
