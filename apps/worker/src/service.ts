import {
  createClient,
  createPlan,
  fetchCatalog,
  fetchPlayer,
  type Catalog,
  type PlanResult,
  type PlannerOptionsInput,
  type RuleSet,
  type ZuClient,
} from '@zuninja/core';
import type { Config } from './config';
import { logger } from './logger';

export const VERSION = '2.0.0';
const USER_AGENT = `ZUnivers-Ninja/${VERSION} (+https://github.com/LightD31/ZUnivers-Ninja)`;
const PLAN_CACHE_MS = 60_000;

/** Limite le nombre de calculs simultanés (le planificateur occupe le CPU). */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class PlanService {
  private readonly clients = new Map<RuleSet, ZuClient>();
  private readonly catalogs = new Map<RuleSet, { value: Promise<Catalog>; expires: number }>();
  private readonly plans = new Map<string, { value: PlanResult; expires: number }>();
  private readonly semaphore = new Semaphore(2);
  private readonly config: Pick<Config, 'apiBaseUrl' | 'catalogTtlMs' | 'planner'>;

  constructor(config: Pick<Config, 'apiBaseUrl' | 'catalogTtlMs' | 'planner'>) {
    this.config = config;
  }

  client(ruleSet: RuleSet): ZuClient {
    let client = this.clients.get(ruleSet);
    if (!client) {
      client = createClient({ baseUrl: this.config.apiBaseUrl, ruleSet, userAgent: USER_AGENT });
      this.clients.set(ruleSet, client);
    }
    return client;
  }

  /** Catalogue partagé entre tous les joueurs, rafraîchi périodiquement. */
  catalog(ruleSet: RuleSet): Promise<Catalog> {
    const cached = this.catalogs.get(ruleSet);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = fetchCatalog(this.client(ruleSet));
    this.catalogs.set(ruleSet, { value, expires: Date.now() + this.config.catalogTtlMs });
    value.catch(() => this.catalogs.delete(ruleSet));
    return value;
  }

  async plan(
    name: string,
    ruleSet: RuleSet,
    options: PlannerOptionsInput = {},
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<PlanResult> {
    const merged = { ...this.config.planner, ...options };
    const key = `${ruleSet}|${name.toLowerCase()}|${JSON.stringify(merged)}`;
    const cached = this.plans.get(key);
    if (!fresh && cached && cached.expires > Date.now()) return cached.value;

    return this.semaphore.run(async () => {
      const [catalog, player] = await Promise.all([
        this.catalog(ruleSet),
        fetchPlayer(this.client(ruleSet), name),
      ]);
      const plan = createPlan({ catalog, player, options: merged });
      logger.debug(
        `Plan calculé pour ${player.name} : ${plan.commands.length} commandes, ${plan.stats.explored} états, ${plan.stats.durationMs} ms`,
      );
      this.plans.set(key, { value: plan, expires: Date.now() + PLAN_CACHE_MS });
      if (this.plans.size > 200) this.plans.delete(this.plans.keys().next().value!);
      return plan;
    });
  }
}
