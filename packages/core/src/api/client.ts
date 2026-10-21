import type { z } from 'zod';
import {
  AchievementCategoriesSchema,
  AchievementEntriesSchema,
  ChallengesSchema,
  CorporationSchema,
  EventsSchema,
  EvolutionSchema,
  FusionSchema,
  InventoryLogsSchema,
  InventorySchema,
  ItemSchema,
  LootSchema,
  RecycleConfigSchema,
  SettingsSchema,
  TowerSchema,
  TowerSeasonSchema,
  TowersSchema,
  UserSchema,
  UserTowerSchema,
  UserOverviewSchema,
} from './schemas';

export type RuleSet = 'NORMAL' | 'HARDCORE';

export interface ClientOptions {
  /** Base de l'API, sans slash final. */
  baseUrl?: string;
  ruleSet?: RuleSet;
  /** Implémentation de fetch (tests, proxy…). */
  fetch?: typeof fetch;
  /** Ajouté uniquement côté serveur : les navigateurs ignorent cet en-tête. */
  userAgent?: string;
  timeoutMs?: number;
  /** Nombre de nouvelles tentatives sur erreur réseau / 5xx / 429. */
  retries?: number;
}

export const DEFAULT_API_BASE_URL = 'https://zunivers-api.zerator.com';

export class ZuApiError extends Error {
  readonly path: string;
  readonly status: number | undefined;

  constructor(message: string, path: string, status?: number) {
    super(message);
    this.name = 'ZuApiError';
    this.path = path;
    this.status = status;
  }
}

/** Le joueur (ou la ressource) n'existe pas. */
export class ZuNotFoundError extends ZuApiError {
  constructor(path: string) {
    super(`Ressource introuvable : ${path}`, path, 404);
    this.name = 'ZuNotFoundError';
  }
}

/** La réponse ne correspond plus au format attendu : l'API a probablement changé. */
export class ZuSchemaError extends ZuApiError {
  readonly issues: string;

  constructor(path: string, issues: string) {
    super(`Format de réponse inattendu pour ${path} :\n${issues}`, path);
    this.name = 'ZuSchemaError';
    this.issues = issues;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = (s: string) => encodeURIComponent(s.trim());

export function createClient(options: ClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  const ruleSet = options.ruleSet ?? 'NORMAL';
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 2;

  async function raw(path: string): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-zunivers-rulesettype': ruleSet,
    };
    if (options.userAgent) headers['user-agent'] = options.userAgent;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseUrl}${path}`, { headers, signal: controller.signal });
        if (res.status === 404) throw new ZuNotFoundError(path);
        if (res.status === 204) return null;
        if (res.status === 429 || res.status >= 500) {
          lastError = new ZuApiError(`HTTP ${res.status} sur ${path}`, path, res.status);
          continue;
        }
        if (!res.ok) throw new ZuApiError(`HTTP ${res.status} sur ${path}`, path, res.status);
        const text = await res.text();
        return text.length === 0 ? null : JSON.parse(text);
      } catch (error) {
        if (error instanceof ZuApiError) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastError instanceof ZuApiError) throw lastError;
    throw new ZuApiError(
      `Impossible de joindre l'API ZUnivers (${path}) : ${String(lastError)}`,
      path,
    );
  }

  async function get<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
    const data = await raw(path);
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `  - ${i.path.join('.') || '(racine)'} : ${i.message}`)
        .join('\n');
      throw new ZuSchemaError(path, issues);
    }
    return parsed.data;
  }

  /** Ressource facultative : absente (204 ou 404) ou illisible, elle vaut `null`. */
  async function getOptional<S extends z.ZodType>(
    path: string,
    schema: S,
  ): Promise<z.output<S> | null> {
    let data: unknown;
    try {
      data = await raw(path);
    } catch (error) {
      if (error instanceof ZuNotFoundError) return null;
      throw error;
    }
    if (data === null) return null;
    const parsed = schema.safeParse(data);
    return parsed.success ? parsed.data : null;
  }

  return {
    ruleSet,
    raw,
    settings: () => get('/app/settings', SettingsSchema),
    items: () => get('/public/item', ItemSchema.array()),
    fusions: () => get('/public/fusion', FusionSchema.array()),
    recycleConfig: () => get('/public/recycle/config', RecycleConfigSchema),
    events: () => get('/public/event/current', EventsSchema),
    towers: () => get('/public/tower', TowersSchema),
    towerSeason: () => getOptional('/public/tower/season', TowerSeasonSchema),
    /** Tour du prochain Vortex, annoncée avant son ouverture. */
    nextTower: () => getOptional('/public/tower/next', TowerSchema),
    user: (name: string) => get(`/public/user/${enc(name)}`, UserSchema),
    inventory: (name: string) => get(`/public/inventory/${enc(name)}`, InventorySchema),
    /** Dernières cartes reçues d'une invocation (`/im <évènement>`), 50 opérations au plus. */
    invocationLogs: (name: string, event: string) =>
      getOptional(
        `/public/inventory/${enc(name)}/logs?source=INVOKE&eventName=${enc(event)}&pageIndex=0&pageSize=50`,
        InventoryLogsSchema,
      ),
    challenges: (name: string) => get(`/public/challenge/${enc(name)}`, ChallengesSchema),
    loot: (name: string) => get(`/public/loot/${enc(name)}?year=0`, LootSchema),
    userTower: (name: string) => get(`/public/tower/${enc(name)}`, UserTowerSchema),
    evolution: (name: string) => getOptional(`/public/evolution/${enc(name)}`, EvolutionSchema),
    overview: (name: string) =>
      getOptional(`/public/user/${enc(name)}/overview`, UserOverviewSchema),
    corporation: (id: string) => getOptional(`/public/corporation/${enc(id)}`, CorporationSchema),
    achievementCategories: (name: string) =>
      getOptional(`/public/achievement/${enc(name)}/category`, AchievementCategoriesSchema),
    achievements: (name: string, categoryId: string) =>
      getOptional(`/public/achievement/${enc(name)}/${enc(categoryId)}`, AchievementEntriesSchema),
  };
}

export type ZuClient = ReturnType<typeof createClient>;
