import {
  ApiCache,
  createClient,
  fetchCatalog,
  fetchPlayer,
  type Catalog,
  type Player,
  type PlanResult,
  type PlannerOptionsInput,
  type RuleSet,
  type ZuClient,
} from '@zuninja/core';
import type { Config } from './config';
import { logger } from './logger';
import type { Metrics } from './metrics';
import { PlanAbortedError, PlannerBusyError, PlannerPool } from './pool';

/** Version publiée : tirée du tag de release et injectée au build de l'image Docker. */
export const VERSION = process.env.APP_VERSION || 'dev';
const USER_AGENT = `ZUnivers-Ninja/${VERSION} (+https://github.com/LightD31/ZUnivers-Ninja)`;
const PLAN_CACHE_MS = 60_000;
/** Données d'un joueur réutilisées quand seuls les réglages du plan changent. */
const PLAYER_CACHE_MS = 60_000;
/** « Actualiser » ne recharge pas un joueur chargé il y a moins longtemps que ça. */
const PLAYER_FRESH_MIN_MS = 15_000;
/** Marge laissée au-delà de la limite de recherche avant d'arrêter un thread. */
const THREAD_TIMEOUT_MARGIN_MS = 30_000;

type ServiceConfig = Pick<
  Config,
  'apiBaseUrl' | 'catalogTtlMs' | 'planner' | 'threads' | 'queueLimit' | 'timeLimitMs'
> & { fetch?: typeof fetch; metrics?: Metrics | null };

/** Calcul en cours, partagé par toutes les requêtes identiques. */
interface Flight {
  promise: Promise<PlanResult>;
  waiters: number;
  controller: AbortController;
}

export class PlanService {
  private readonly clients = new Map<RuleSet, ZuClient>();
  private readonly catalogs: ApiCache<Catalog>;
  private readonly players = new ApiCache<Player>({
    ttlMs: PLAYER_CACHE_MS,
    freshMinMs: PLAYER_FRESH_MIN_MS,
  });
  private readonly plans = new Map<string, { value: PlanResult; expires: number }>();
  private readonly flights = new Map<string, Flight>();
  private readonly pool: PlannerPool;
  private readonly config: ServiceConfig;

  constructor(config: ServiceConfig) {
    this.config = config;
    this.catalogs = new ApiCache({ ttlMs: config.catalogTtlMs });
    this.pool = new PlannerPool({
      threads: config.threads,
      queueLimit: config.queueLimit,
      timeoutMs: config.timeLimitMs > 0 ? config.timeLimitMs + THREAD_TIMEOUT_MARGIN_MS : 0,
    });
  }

  close(): Promise<void> {
    return this.pool.close();
  }

  get poolStats() {
    return this.pool.stats;
  }

  client(ruleSet: RuleSet): ZuClient {
    let client = this.clients.get(ruleSet);
    if (!client) {
      client = createClient({
        baseUrl: this.config.apiBaseUrl,
        ruleSet,
        userAgent: USER_AGENT,
        ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
      });
      this.clients.set(ruleSet, client);
    }
    return client;
  }

  /** Catalogue partagé entre tous les joueurs, rafraîchi périodiquement. */
  catalog(ruleSet: RuleSet): Promise<Catalog> {
    return this.catalogs.get(ruleSet, () => fetchCatalog(this.client(ruleSet)));
  }

  /**
   * Données d'un joueur, partagées entre ses plans : changer de stratégie ou de réglages ne
   * rappelle pas l'API ZUnivers.
   */
  player(name: string, ruleSet: RuleSet, fresh = false): Promise<Player> {
    return this.players.get(
      `${ruleSet}|${name.toLowerCase()}`,
      () => fetchPlayer(this.client(ruleSet), name),
      fresh,
    );
  }

  /**
   * Plan d'un joueur. Les requêtes identiques partagent le même calcul, qui n'est annulé
   * (thread libéré) que lorsque toutes ont été abandonnées via leur `signal`.
   */
  plan(
    name: string,
    ruleSet: RuleSet,
    options: PlannerOptionsInput = {},
    { fresh = false, signal }: { fresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<PlanResult> {
    const merged = { ...this.config.planner, ...options };
    const key = `${ruleSet}|${name.toLowerCase()}|${JSON.stringify(merged)}`;
    const cached = this.plans.get(key);
    if (!fresh && cached && cached.expires > Date.now()) return Promise.resolve(cached.value);

    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const promise = this.compute(name, ruleSet, merged, key, fresh, controller.signal);
      const created: Flight = { promise, waiters: 0, controller };
      void promise.catch(() => {}).finally(() => this.land(key, created));
      this.flights.set(key, created);
      flight = created;
    }
    flight.waiters++;
    if (!signal) return flight.promise;

    const shared = flight;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        reject(new PlanAbortedError());
        if (--shared.waiters > 0) return;
        this.land(key, shared);
        shared.controller.abort();
      };
      shared.promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private land(key: string, flight: Flight) {
    if (this.flights.get(key) === flight) this.flights.delete(key);
  }

  private async compute(
    name: string,
    ruleSet: RuleSet,
    options: PlannerOptionsInput,
    key: string,
    fresh: boolean,
    signal: AbortSignal,
  ): Promise<PlanResult> {
    // Refus immédiat quand le serveur est saturé, sans solliciter l'API ZUnivers.
    if (this.pool.saturated) throw new PlannerBusyError();
    const started = performance.now();
    const [catalog, player] = await Promise.all([
      this.catalog(ruleSet),
      this.player(name, ruleSet, fresh),
    ]);
    const plan = await this.pool.run(
      { catalog, player, options: { ...options, timeLimitMs: this.config.timeLimitMs } },
      signal,
    );
    logger.debug(
      `Plan calculé pour ${player.name} : ${plan.commands.length} commandes, ${plan.stats.explored} états, ${plan.stats.durationMs} ms${plan.stats.timedOut ? ' (limite de temps atteinte)' : ''}`,
    );
    this.config.metrics?.computedPlan(
      plan.strategy.id,
      ruleSet,
      (performance.now() - started) / 1000,
      plan.stats.timedOut,
    );
    this.plans.set(key, { value: plan, expires: Date.now() + PLAN_CACHE_MS });
    if (this.plans.size > 200) this.plans.delete(this.plans.keys().next().value!);
    return plan;
  }
}
