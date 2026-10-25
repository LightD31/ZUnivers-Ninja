import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  DEFAULT_STRATEGY,
  STRATEGIES,
  STRATEGY_IDS,
  isStrategy,
  parsePlannerQuery,
  parseTradeKeep,
  ZuApiError,
  ZuNotFoundError,
  ZuSchemaError,
  type PlanResult,
  type RuleSet,
  type StrategyId,
} from '@zuninja/core';
import { Hono, type Context } from 'hono';
import { buildDiscordMessage } from './notifiers/discord';
import { logger } from './logger';
import type { Metrics, PlanOutcome, PlanSource } from './metrics';
import { PlanAbortedError, PlannerBusyError, PlannerTimeoutError } from './pool';
import { PlayerNotFoundError, TradeUnavailableError, VERSION, type PlanService } from './service';
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

const invalidUser = (user: string) => !user || user.length > 64;

/** Partenaires à comparer en plus, au plus. */
const TRADE_NAMES_MAX = 10;

/** Partenaires à comparer en plus (`alice,bob`), sans doublon ni pseudo invalide. */
export function parseTradeNames(value: string | undefined): string[] {
  const names = new Map<string, string>();
  for (const name of (value ?? '').split(',').map((n) => n.trim()))
    if (!invalidUser(name) && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  return [...names.values()].slice(0, TRADE_NAMES_MAX);
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

  const ruleSetOf = (c: Context): RuleSet =>
    (c.req.query('ruleset') ?? options.ruleSet).toUpperCase() === 'HARDCORE'
      ? 'HARDCORE'
      : 'NORMAL';

  /** Réponse à un échec de l'API ZUnivers, `null` si l'erreur vient d'ailleurs. */
  function zuApiFailure(c: Context, error: unknown): Response | null {
    if (error instanceof ZuSchemaError) {
      logger.error('Format de l’API ZUnivers inattendu', error.message);
      return c.json(
        {
          error: "L'API ZUnivers a changé de format, ZUnivers Ninja doit être mis à jour.",
          detail: error.issues,
        },
        502,
      );
    }
    if (error instanceof ZuApiError) {
      return c.json(
        { error: "L'API ZUnivers ne répond pas pour le moment, réessaie dans un instant." },
        502,
      );
    }
    return null;
  }

  async function planOutcome(
    c: Context,
    user: string,
  ): Promise<{ result: PlanResult | Response; outcome: PlanOutcome }> {
    const fail = (outcome: PlanOutcome, result: Response) => ({ result, outcome });
    if (invalidUser(user)) return fail('invalid', c.json({ error: 'Pseudo invalide.' }, 400));
    const ruleSet = ruleSetOf(c);
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
      const failure = zuApiFailure(c, error);
      if (failure) return fail('zu_api_error', failure);
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

  /** Réponse à un échec d'une route d'échange. */
  function tradeFailure(c: Context, error: unknown, ruleSet: RuleSet, what: string): Response {
    if (error instanceof PlannerBusyError) {
      c.header('Retry-After', '10');
      return c.json(
        { error: 'Trop de recherches en cours, réessaie dans quelques secondes.' },
        503,
      );
    }
    if (error instanceof TradeUnavailableError)
      return c.json({ error: "Pas d'échanges dans ce mode de jeu." }, 400);
    if (error instanceof PlayerNotFoundError)
      return c.json(
        { error: `Joueur « ${error.player} » introuvable sur ZUnivers (${ruleSet}).` },
        404,
      );
    const failure = zuApiFailure(c, error);
    if (failure) return failure;
    logger.error(`Erreur inattendue pour ${what}`, error);
    return c.json({ error: 'Erreur interne.' }, 500);
  }

  /** Exemplaires gardés par chacun (`golden,goldenFusions,constellation`, tous par défaut). */
  const tradeKeep = (c: Context) => ({
    me: parseTradeKeep(c.req.query('keep')),
    other: parseTradeKeep(c.req.query('otherKeep')),
  });

  /** Ce que deux joueurs peuvent s'échanger. `keep` et `otherKeep` : exemplaires gardés. */
  app.get('/api/trade/:me/:other', async (c) => {
    const me = c.req.param('me').trim();
    const other = c.req.param('other').trim();
    if (invalidUser(me) || invalidUser(other)) return c.json({ error: 'Pseudo invalide.' }, 400);
    if (me.toLowerCase() === other.toLowerCase())
      return c.json({ error: 'Choisis un autre joueur que toi pour échanger.' }, 400);
    const ruleSet = ruleSetOf(c);
    try {
      const trade = await service.trade(me, other, ruleSet, tradeKeep(c), {
        fresh: c.req.query('fresh') === '1',
      });
      c.header('Cache-Control', 'no-cache');
      return c.json(trade);
    } catch (error) {
      return tradeFailure(c, error, ruleSet, `l'échange ${me} ↔ ${other}`);
    }
  });

  /**
   * Les meilleurs joueurs avec qui échanger, et le meilleur échange avec chacun. `with` :
   * partenaires à comparer en plus (séparés par des virgules) ; `keep` et `otherKeep` comme pour
   * /api/trade, `otherKeep` valant pour chacun des autres joueurs.
   */
  app.get('/api/partners/:me', async (c) => {
    const me = c.req.param('me').trim();
    if (invalidUser(me)) return c.json({ error: 'Pseudo invalide.' }, 400);
    const ruleSet = ruleSetOf(c);
    try {
      const partners = await service.partners(
        me,
        ruleSet,
        { names: parseTradeNames(c.req.query('with')), keep: tradeKeep(c) },
        { fresh: c.req.query('fresh') === '1' },
      );
      c.header('Cache-Control', 'no-cache');
      return c.json(partners);
    } catch (error) {
      return tradeFailure(c, error, ruleSet, `les partenaires de ${me}`);
    }
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
