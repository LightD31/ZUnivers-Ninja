import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { STRATEGY_IDS, type RuleSet } from '@zuninja/core';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { logger } from './logger';

/** Origine d'une demande de plan : interface web, bot (route /discord) ou conseils planifiés. */
export const PLAN_SOURCES = ['web', 'bot', 'cron'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

/** Issue d'une demande de plan, pour suivre les erreurs et la saturation. */
export const PLAN_OUTCOMES = [
  'ok',
  'invalid',
  'not_found',
  'busy',
  'timeout',
  'aborted',
  'zu_api_error',
  'error',
] as const;
export type PlanOutcome = (typeof PLAN_OUTCOMES)[number];

const RULE_SETS: readonly RuleSet[] = ['NORMAL', 'HARDCORE'];

const DAY_MS = 86_400_000;
/** Fenêtres des joueurs distincts. */
export const PLAYER_WINDOWS = { '1d': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS } as const;

interface TrackerData {
  version: 1;
  /** Sel propre à l'instance : les empreintes ne permettent pas de retrouver les pseudos. */
  salt: string;
  /** Empreinte du pseudo → dernière demande (ms). */
  seen: Record<string, number>;
}

/**
 * Joueurs distincts ayant demandé un plan. Seule une empreinte salée du pseudo est gardée, avec la
 * date de sa dernière demande, dans un petit fichier qui survit aux redémarrages.
 */
export class PlayerTracker {
  private data: TrackerData = { version: 1, salt: randomBytes(16).toString('hex'), seen: {} };
  private dirty = false;
  private readonly file: string | null;

  constructor(file: string | null) {
    this.file = file;
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as TrackerData;
      if (parsed.version === 1 && parsed.salt) this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn(`Statistiques illisibles (${file}), on repart de zéro`, error);
    }
  }

  see(name: string, now = Date.now()) {
    const key = createHash('sha256')
      .update(`${this.data.salt}:${name.trim().toLowerCase()}`)
      .digest('hex')
      .slice(0, 24);
    this.data.seen[key] = now;
    this.dirty = true;
  }

  count(windowMs: number, now = Date.now()): number {
    let n = 0;
    for (const at of Object.values(this.data.seen)) if (now - at <= windowMs) n++;
    return n;
  }

  save(now = Date.now()) {
    if (!this.file || !this.dirty) return;
    for (const [key, at] of Object.entries(this.data.seen))
      if (now - at > PLAYER_WINDOWS['30d']) delete this.data.seen[key];
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (error) {
      logger.warn(`Statistiques non enregistrées (${this.file})`, error);
    }
  }
}

/** Métriques Prometheus du serveur, exposées sur /metrics. */
export class Metrics {
  readonly registry = new Registry();
  readonly players: PlayerTracker;

  private readonly requests = new Counter({
    name: 'zuninja_plan_requests_total',
    help: 'Demandes de plan, par origine et par issue (cache compris)',
    labelNames: ['source', 'outcome'] as const,
    registers: [this.registry],
  });

  private readonly computed = new Counter({
    name: 'zuninja_plans_computed_total',
    help: 'Plans réellement calculés (hors cache), par stratégie et mode de jeu',
    labelNames: ['strategy', 'ruleset'] as const,
    registers: [this.registry],
  });

  private readonly duration = new Histogram({
    name: 'zuninja_plan_duration_seconds',
    help: "Durée d'un calcul de plan, appels à l'API ZUnivers compris",
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
    registers: [this.registry],
  });

  private readonly timedOut = new Counter({
    name: 'zuninja_plans_timed_out_total',
    help: 'Plans dont la recherche a atteint la limite de temps (fin en glouton)',
    registers: [this.registry],
  });

  private readonly pageViews = new Counter({
    name: 'zuninja_page_views_total',
    help: "Pages de l'interface web servies",
    registers: [this.registry],
  });

  constructor(options: {
    version: string;
    players: PlayerTracker;
    pool?: () => { threads: number; busy: number; queued: number };
  }) {
    this.players = options.players;
    collectDefaultMetrics({ register: this.registry, prefix: 'zuninja_' });
    const registers = [this.registry];

    // Séries créées à zéro dès le démarrage : sinon increase() ignore la première demande de
    // chaque combinaison après un redémarrage, et Grafana affiche « No data » au lieu de 0.
    for (const source of PLAN_SOURCES)
      for (const outcome of PLAN_OUTCOMES) this.requests.inc({ source, outcome }, 0);
    for (const strategy of STRATEGY_IDS)
      for (const ruleset of RULE_SETS) this.computed.inc({ strategy, ruleset }, 0);

    new Gauge({
      name: 'zuninja_info',
      help: 'Version du serveur',
      labelNames: ['version'] as const,
      registers,
      collect() {
        this.set({ version: options.version }, 1);
      },
    });

    const players = this.players;
    new Gauge({
      name: 'zuninja_players',
      help: 'Joueurs distincts ayant demandé un plan (web ou bot) sur la fenêtre',
      labelNames: ['window'] as const,
      registers,
      collect() {
        const now = Date.now();
        for (const [window, ms] of Object.entries(PLAYER_WINDOWS))
          this.set({ window }, players.count(ms, now));
      },
    });

    const pool = options.pool;
    if (pool) {
      new Gauge({
        name: 'zuninja_planner_threads',
        help: 'Threads de calcul, par état',
        labelNames: ['state'] as const,
        registers,
        collect() {
          const { threads, busy } = pool();
          this.set({ state: 'busy' }, busy);
          this.set({ state: 'idle' }, threads - busy);
        },
      });
      new Gauge({
        name: 'zuninja_planner_queue_length',
        help: "Calculs en attente d'un thread",
        registers,
        collect() {
          this.set(pool().queued);
        },
      });
    }
  }

  /** Une demande de plan est terminée. Le pseudo n'est retenu (haché) que pour le web et les bots. */
  request(source: PlanSource, outcome: PlanOutcome, user?: string) {
    this.requests.inc({ source, outcome });
    if (outcome === 'ok' && user && source !== 'cron') this.players.see(user);
  }

  /** Un plan a été calculé (hors cache). */
  computedPlan(strategy: string, ruleSet: string, seconds: number, timedOut: boolean) {
    this.computed.inc({ strategy, ruleset: ruleSet });
    this.duration.observe(seconds);
    if (timedOut) this.timedOut.inc();
  }

  pageView() {
    this.pageViews.inc();
  }
}
