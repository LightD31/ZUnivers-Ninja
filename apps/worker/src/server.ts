import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  DEFAULT_STRATEGY,
  HORIZON_SEASONS_MAX,
  STRATEGIES,
  STRATEGY_IDS,
  allowExcept,
  isOptionalAction,
  isStrategy,
  ZuApiError,
  ZuNotFoundError,
  ZuSchemaError,
  type PlanResult,
  type PlannerOptionsInput,
  type RuleSet,
  type StrategyId,
} from '@zuninja/core';
import { Hono, type Context } from 'hono';
import { buildDiscordMessage } from './notifiers/discord';
import { logger } from './logger';
import type { Metrics, PlanOutcome, PlanSource } from './metrics';
import { PlanAbortedError, PlannerBusyError, PlannerTimeoutError } from './pool';
import { VERSION, type PlanService } from './service';
import type { StateStore } from './store';

export interface ServerOptions {
  ruleSet: RuleSet;
  /** Stratégie par défaut du serveur (variable STRATEGY). */
  strategy?: StrategyId | undefined;
  users: string[];
  webDir: string;
  webUrl?: string | undefined;
  cron: string;
  /** Métriques Prometheus exposées sur /metrics, `null` pour les désactiver. */
  metrics?: Metrics | null;
  /** Jeton exigé sur /metrics (`Authorization: Bearer …`). */
  metricsToken?: string | undefined;
}

const clamp = (value: string | undefined, min: number, max: number): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

/** Options du planificateur lues dans la requête, bornées pour éviter les abus. */
export function parsePlannerQuery(query: Record<string, string | undefined>): PlannerOptionsInput {
  const options: PlannerOptionsInput = {};
  if (isStrategy(query.strategy)) options.strategy = query.strategy;
  const beamWidth = clamp(query.beamWidth, 1, 64);
  const branching = clamp(query.branching, 1, 16);
  const keepExtra = clamp(query.keepExtra, 0, 10);
  if (beamWidth !== undefined) options.beamWidth = beamWidth;
  if (branching !== undefined) options.branching = branching;
  if (keepExtra !== undefined) options.keepExtra = keepExtra;
  if (query.keepForGolden === '0' || query.keepForGolden === '1')
    options.keepForGolden = query.keepForGolden === '1';
  if (query.keepForGoldenFusions === '0' || query.keepForGoldenFusions === '1')
    options.keepForGoldenFusions = query.keepForGoldenFusions === '1';
  if (query.horizon === '0' || query.horizon === '1') options.horizon = query.horizon === '1';
  const horizonDiscount = clamp(query.horizonDiscount, 0, 1);
  const horizonSeasons = clamp(query.horizonSeasons, 1, HORIZON_SEASONS_MAX);
  if (horizonDiscount !== undefined) options.horizonDiscount = horizonDiscount;
  if (horizonSeasons !== undefined) options.horizonSeasons = horizonSeasons;
  // Actions refusées, séparées par des virgules. Présent (même vide), il remplace celles du
  // serveur : `skip=` les autorise toutes.
  if (query.skip !== undefined)
    options.allow = allowExcept(query.skip.split(',').filter(isOptionalAction));
  const weights: NonNullable<PlannerOptionsInput['weights']> = {};
  const w = (key: string) => clamp(query[key], 0, 10);
  const balance = w('wBalance');
  const loreDust = w('wLoreDust');
  const loreFragment = w('wLoreFragment');
  const upgradeDust = w('wUpgradeDust');
  if (balance !== undefined) weights.balance = balance;
  if (loreDust !== undefined) weights.loreDust = loreDust;
  if (loreFragment !== undefined) weights.loreFragment = loreFragment;
  if (upgradeDust !== undefined) weights.upgradeDust = upgradeDust;
  if (Object.keys(weights).length > 0) options.weights = weights;
  return options;
}

export function createApp(service: PlanService, store: StateStore | null, options: ServerOptions) {
  const app = new Hono();
  const strategyList = () => ({
    strategy: options.strategy ?? DEFAULT_STRATEGY,
    strategies: STRATEGY_IDS.map((id) => ({
      id,
      label: STRATEGIES[id].label,
      description: STRATEGIES[id].description,
    })),
  });

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      version: VERSION,
      users: options.users.length,
      lastTick: store?.lastTick ?? null,
    }),
  );

  app.get('/api/config', (c) =>
    c.json({
      version: VERSION,
      ruleSet: options.ruleSet,
      users: options.users,
      cron: options.cron,
      webUrl: options.webUrl ?? null,
      ...strategyList(),
    }),
  );

  /** Stratégies disponibles, pour qu'un bot propose les mêmes choix que l'interface. */
  app.get('/api/strategies', (c) => c.json(strategyList()));

  const metrics = options.metrics ?? null;

  /** Calcule le plan demandé, ou renvoie la réponse d'erreur adaptée, et le compte. */
  async function planFor(c: Context, source: PlanSource): Promise<PlanResult | Response> {
    const user = (c.req.param('user') ?? '').trim();
    const { result, outcome } = await planOutcome(c, user);
    metrics?.request(source, outcome, user);
    return result;
  }

  async function planOutcome(
    c: Context,
    user: string,
  ): Promise<{ result: PlanResult | Response; outcome: PlanOutcome }> {
    const fail = (outcome: PlanOutcome, result: Response) => ({ result, outcome });
    if (!user || user.length > 64)
      return fail('invalid', c.json({ error: 'Pseudo invalide.' }, 400));
    const ruleSetParam = (c.req.query('ruleset') ?? options.ruleSet).toUpperCase();
    const ruleSet: RuleSet = ruleSetParam === 'HARDCORE' ? 'HARDCORE' : 'NORMAL';
    const strategy = c.req.query('strategy');
    if (strategy && !isStrategy(strategy)) {
      return fail(
        'invalid',
        c.json(
          {
            error: `Stratégie « ${strategy} » inconnue. Valeurs possibles : ${STRATEGY_IDS.join(', ')}.`,
          },
          400,
        ),
      );
    }
    try {
      const plan = await service.plan(user, ruleSet, parsePlannerQuery(c.req.query()), {
        fresh: c.req.query('fresh') === '1',
        // Client parti (onglet fermé, nouvelle recherche…) : le calcul est abandonné.
        signal: c.req.raw.signal,
      });
      return { result: plan, outcome: 'ok' };
    } catch (error) {
      if (error instanceof PlanAbortedError) {
        return fail('aborted', c.json({ error: 'Requête annulée.' }, 503));
      }
      if (error instanceof PlannerBusyError) {
        c.header('Retry-After', '10');
        return fail(
          'busy',
          c.json({ error: 'Trop de calculs en cours, réessaie dans quelques secondes.' }, 503),
        );
      }
      if (error instanceof PlannerTimeoutError) {
        logger.warn(`Calcul trop long pour ${user}`, error.message);
        return fail(
          'timeout',
          c.json(
            {
              error:
                'Le calcul a pris trop de temps : réduis la largeur du faisceau ou la ramification.',
            },
            503,
          ),
        );
      }
      if (error instanceof ZuNotFoundError) {
        return fail(
          'not_found',
          c.json({ error: `Joueur « ${user} » introuvable sur ZUnivers (${ruleSet}).` }, 404),
        );
      }
      if (error instanceof ZuSchemaError) {
        logger.error('Format de l’API ZUnivers inattendu', error.message);
        return fail(
          'zu_api_error',
          c.json(
            {
              error: "L'API ZUnivers a changé de format, ZUnivers Ninja doit être mis à jour.",
              detail: error.issues,
            },
            502,
          ),
        );
      }
      if (error instanceof ZuApiError) {
        return fail(
          'zu_api_error',
          c.json(
            { error: "L'API ZUnivers ne répond pas pour le moment, réessaie dans un instant." },
            502,
          ),
        );
      }
      logger.error(`Erreur inattendue pour ${user}`, error);
      return fail('error', c.json({ error: 'Erreur interne.' }, 500));
    }
  }

  /**
   * ETag = empreinte des commandes : un client qui renvoie `If-None-Match` reçoit un 304
   * tant que le plan n'a pas changé (pratique pour un bot qui interroge régulièrement).
   */
  function notModified(c: Context, plan: PlanResult): Response | null {
    const etag = `W/"${plan.hash}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'no-cache');
    const ifNoneMatch = c.req.header('if-none-match');
    if (
      ifNoneMatch &&
      ifNoneMatch.split(',').some((t) => t.trim() === etag || t.trim() === `"${plan.hash}"`)
    ) {
      return c.body(null, 304);
    }
    return null;
  }

  app.get('/api/plan/:user', async (c) => {
    const plan = await planFor(c, 'web');
    if (plan instanceof Response) return plan;
    return notModified(c, plan) ?? c.json(plan);
  });

  /**
   * Version compacte pour les bots Discord : message prêt à poster (contenu + embed) et plan en
   * pièce jointe quand il est trop long. `?mention=1` mentionne le joueur.
   */
  app.get('/api/plan/:user/discord', async (c) => {
    const plan = await planFor(c, 'bot');
    if (plan instanceof Response) return plan;
    const cached = notModified(c, plan);
    if (cached) return cached;
    const message = buildDiscordMessage(plan, {
      webUrl: options.webUrl,
      mention: c.req.query('mention') === '1',
    });
    return c.json({
      hash: plan.hash,
      generatedAt: plan.generatedAt,
      strategy: plan.strategy,
      empty: plan.commands.length === 0,
      player: {
        name: plan.player.name,
        displayName: plan.player.displayName,
        discordId: plan.player.discordId,
        avatar: plan.player.avatar,
      },
      commandCount: plan.commands.length,
      commands: plan.commands,
      gain: { points: plan.gain.points, expected: plan.gain.expected },
      content: message.payload.content,
      embeds: message.payload.embeds,
      attachment: message.attachment,
    });
  });

  app.all('/api/*', (c) => c.json({ error: 'Route inconnue.' }, 404));

  if (metrics) {
    /** Métriques Prometheus (usage, erreurs, calculs, threads). */
    app.get('/metrics', async (c) => {
      const token = options.metricsToken;
      if (token && c.req.header('authorization') !== `Bearer ${token}`)
        return c.text('Unauthorized', 401);
      c.header('Content-Type', metrics.registry.contentType);
      return c.body(await metrics.registry.metrics());
    });
    // Pages de l'interface ouvertes dans un navigateur (pas les fichiers statiques ni l'API).
    // Seule une navigation envoie `Sec-Fetch-Mode: navigate` : les sondes (Uptime Kuma…) et les
    // aperçus de liens (Discordbot…) ne comptent pas, ni le préchargement (`Sec-Purpose`).
    app.use('*', async (c, next) => {
      await next();
      if (
        c.req.method === 'GET' &&
        c.req.header('sec-fetch-mode') === 'navigate' &&
        !c.req.header('sec-purpose') &&
        c.res.headers.get('content-type')?.startsWith('text/html')
      )
        metrics.pageView();
    });
  }

  // Interface web (fichiers statiques + repli SPA).
  const indexFile = join(options.webDir, 'index.html');
  if (existsSync(indexFile)) {
    const root = relative(process.cwd(), options.webDir) || '.';
    const index = readFileSync(indexFile, 'utf8');
    app.use('/*', serveStatic({ root }));
    app.get('*', (c) => c.html(index));
  } else {
    logger.warn(`Interface web introuvable (${options.webDir}) : seule l'API est servie.`);
    app.get('/', (c) => c.text('ZUnivers Ninja — API disponible sur /api/plan/:pseudo'));
  }

  return app;
}
