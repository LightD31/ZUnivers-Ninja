import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_API_BASE_URL } from '@zuninja/core';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));
const optionalNumber = z.coerce.number().finite().optional();
const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .pipe(z.url().optional());

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  /** Pseudos Discord à conseiller automatiquement (séparés par des virgules). */
  ZU_USERS: z.string().optional(),
  /** Ancien nom de ZU_USERS (v1). */
  DISCORD_TAGS: z.string().optional(),
  RULESET: z.enum(['NORMAL', 'HARDCORE']).default('NORMAL'),
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
  /** Threads dédiés au planificateur (calculs simultanés). */
  PLANNER_THREADS: z.coerce.number().int().positive().default(2),
  /** Calculs en attente au-delà desquels l'API répond 503. */
  PLANNER_QUEUE_LIMIT: z.coerce.number().int().nonnegative().default(4),
  /** Temps de recherche maximal par plan (0 = illimité), ensuite la fin est cherchée en glouton. */
  PLANNER_TIME_LIMIT_SECONDS: z.coerce.number().nonnegative().default(20),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')} : ${i.message}`)
      .join('\n');
    throw new Error(`Configuration invalide :\n${issues}`);
  }
  const e = parsed.data;
  const users = (e.ZU_USERS ?? e.DISCORD_TAGS ?? '')
    .split(/[,\s]+/)
    .map((u) => u.trim())
    .filter(Boolean);
  return {
    port: e.PORT,
    host: e.HOST,
    users: [...new Set(users)],
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
      ...(e.BEAM_WIDTH !== undefined ? { beamWidth: e.BEAM_WIDTH } : {}),
      ...(e.BRANCHING !== undefined ? { branching: e.BRANCHING } : {}),
      ...(e.KEEP_EXTRA !== undefined ? { keepExtra: e.KEEP_EXTRA } : {}),
    },
    threads: e.PLANNER_THREADS,
    queueLimit: e.PLANNER_QUEUE_LIMIT,
    timeLimitMs: e.PLANNER_TIME_LIMIT_SECONDS * 1000,
    logLevel: e.LOG_LEVEL,
  };
}
