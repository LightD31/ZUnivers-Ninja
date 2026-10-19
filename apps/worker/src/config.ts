import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_API_BASE_URL,
  OPTIONAL_ACTIONS,
  STRATEGY_IDS,
  allowExcept,
  isOptionalAction,
  isStrategy,
  type OptionalAction,
  type StrategyId,
} from '@zuninja/core';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));
const optionalNumber = z.coerce.number().finite().optional();
/** Booléen facultatif : absent, la valeur de la stratégie s'applique. */
const optionalBool = z
  .string()
  .optional()
  .transform((v) =>
    v === undefined || v.trim() === ''
      ? undefined
      : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
  );
const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .pipe(z.url().optional());

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  /**
   * Pseudos Discord à conseiller automatiquement (séparés par des virgules), chacun suivi au
   * besoin de sa stratégie : `alice:prudent,bob`.
   */
  ZU_USERS: z.string().optional(),
  /** Ancien nom de ZU_USERS (v1). */
  DISCORD_TAGS: z.string().optional(),
  RULESET: z.enum(['NORMAL', 'HARDCORE']).default('NORMAL'),
  /** Stratégie par défaut du planificateur. */
  STRATEGY: z.enum(STRATEGY_IDS).optional(),
  CRON: z.string().default('*/30 * * * *'),
  TZ: z.string().default('Europe/Paris'),
  WEBHOOK_URL: optionalUrl,
  JSON_WEBHOOK_URL: optionalUrl,
  /** URL publique de l'interface, pour les liens dans Discord. */
  WEB_URL: optionalUrl,
  DISCORD_MENTION: bool,
  STATE_FILE: z.string().default('./data/state.json'),
  WEB_DIR: z.string().optional(),
  DRY_RUN: bool,
  RUN_ON_START: z
    .string()
    .optional()
    .transform(
      (v) => v === undefined || !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase()),
    ),
  API_BASE_URL: z.string().default(DEFAULT_API_BASE_URL),
  CATALOG_TTL_MINUTES: z.coerce.number().positive().default(10),
  BEAM_WIDTH: optionalNumber,
  BRANCHING: optionalNumber,
  KEEP_EXTRA: optionalNumber,
  KEEP_FOR_GOLDEN: optionalBool,
  KEEP_FOR_GOLDEN_FUSIONS: optionalBool,
  /** Actions que le plan ne propose jamais, séparées par des virgules. */
  SKIP_ACTIONS: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const list = (v ?? '')
        .split(/[,\s]+/)
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean);
      const unknown = list.filter((a) => !isOptionalAction(a));
      if (unknown.length > 0)
        ctx.addIssue({
          code: 'custom',
          message: `action(s) inconnue(s) : ${unknown.join(', ')} (${OPTIONAL_ACTIONS.join(', ')})`,
        });
      return list as OptionalAction[];
    }),
  /** Threads dédiés au planificateur (calculs simultanés). */
  PLANNER_THREADS: z.coerce.number().int().positive().default(2),
  /** Calculs en attente au-delà desquels l'API répond 503. */
  PLANNER_QUEUE_LIMIT: z.coerce.number().int().nonnegative().default(4),
  /** Temps de recherche maximal par plan (0 = illimité), ensuite la fin est cherchée en glouton. */
  PLANNER_TIME_LIMIT_SECONDS: z.coerce.number().nonnegative().default(20),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Métriques Prometheus sur /metrics (activées par défaut). */
  METRICS: z
    .string()
    .optional()
    .transform(
      (v) => v === undefined || !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase()),
    ),
  /** Jeton exigé sur /metrics (`Authorization: Bearer …`), facultatif. */
  METRICS_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
});

export type Config = ReturnType<typeof loadConfig>;

function defaultWebDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../web'),
    resolve(here, '../../web/dist'),
    resolve(here, '../../../web/dist'),
  ];
  return candidates.find((p) => existsSync(resolve(p, 'index.html'))) ?? candidates[0]!;
}

const invalid = (issues: string[]) =>
  new Error(`Configuration invalide :\n${issues.map((i) => `  - ${i}`).join('\n')}`);

/** Joueurs suivis et stratégie choisie par chacun (`pseudo:stratégie`), indexée en minuscules. */
function parseUsers(value: string) {
  const users: string[] = [];
  const strategies: Record<string, StrategyId> = {};
  for (const entry of value.split(/[,\s]+/)) {
    const [name = '', strategy] = entry.split(':').map((part) => part.trim());
    if (!name) continue;
    if (strategy !== undefined) {
      if (!isStrategy(strategy))
        throw invalid([
          `ZU_USERS : stratégie « ${strategy} » inconnue pour ${name} (${STRATEGY_IDS.join(', ')})`,
        ]);
      strategies[name.toLowerCase()] = strategy;
    }
    if (!users.includes(name)) users.push(name);
  }
  return { users, strategies };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw invalid(parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`));
  }
  const e = parsed.data;
  const { users, strategies } = parseUsers(e.ZU_USERS ?? e.DISCORD_TAGS ?? '');
  return {
    port: e.PORT,
    host: e.HOST,
    users,
    strategies,
    ruleSet: e.RULESET,
    cron: e.CRON,
    timezone: e.TZ,
    discordWebhook: e.WEBHOOK_URL,
    jsonWebhook: e.JSON_WEBHOOK_URL,
    webUrl: e.WEB_URL,
    discordMention: e.DISCORD_MENTION,
    stateFile: resolve(e.STATE_FILE),
    webDir: e.WEB_DIR ? resolve(e.WEB_DIR) : defaultWebDir(),
    dryRun: e.DRY_RUN,
    runOnStart: e.RUN_ON_START,
    apiBaseUrl: e.API_BASE_URL,
    catalogTtlMs: e.CATALOG_TTL_MINUTES * 60_000,
    planner: {
      ...(e.STRATEGY !== undefined ? { strategy: e.STRATEGY } : {}),
      ...(e.BEAM_WIDTH !== undefined ? { beamWidth: e.BEAM_WIDTH } : {}),
      ...(e.BRANCHING !== undefined ? { branching: e.BRANCHING } : {}),
      ...(e.KEEP_EXTRA !== undefined ? { keepExtra: e.KEEP_EXTRA } : {}),
      ...(e.KEEP_FOR_GOLDEN !== undefined ? { keepForGolden: e.KEEP_FOR_GOLDEN } : {}),
      ...(e.KEEP_FOR_GOLDEN_FUSIONS !== undefined
        ? { keepForGoldenFusions: e.KEEP_FOR_GOLDEN_FUSIONS }
        : {}),
      ...(e.SKIP_ACTIONS.length > 0 ? { allow: allowExcept(e.SKIP_ACTIONS) } : {}),
    },
    threads: e.PLANNER_THREADS,
    queueLimit: e.PLANNER_QUEUE_LIMIT,
    timeLimitMs: e.PLANNER_TIME_LIMIT_SECONDS * 1000,
    logLevel: e.LOG_LEVEL,
    metricsEnabled: e.METRICS,
    metricsToken: e.METRICS_TOKEN,
    /** Joueurs distincts (empreintes), à côté de l'état. */
    metricsFile: resolve(dirname(resolve(e.STATE_FILE)), 'metrics.json'),
  };
}
