import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  ZuApiError,
  ZuNotFoundError,
  ZuSchemaError,
  type PlanResult,
  type PlannerOptionsInput,
  type RuleSet,
} from '@zuninja/core';
import { Hono, type Context } from 'hono';
import { buildDiscordMessage } from './notifiers/discord';
import { logger } from './logger';
import { VERSION, type PlanService } from './service';
import type { StateStore } from './store';

export interface ServerOptions {
  ruleSet: RuleSet;
  users: string[];
  webDir: string;
  webUrl?: string | undefined;
  cron: string;
}

const clamp = (value: string | undefined, min: number, max: number): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

/** Options du planificateur lues dans la requête, bornées pour éviter les abus. */
export function parsePlannerQuery(query: Record<string, string | undefined>): PlannerOptionsInput {
  const options: PlannerOptionsInput = {};
  const beamWidth = clamp(query.beamWidth, 1, 64);
  const branching = clamp(query.branching, 1, 16);
  const keepExtra = clamp(query.keepExtra, 0, 10);
  if (beamWidth !== undefined) options.beamWidth = beamWidth;
  if (branching !== undefined) options.branching = branching;
  if (keepExtra !== undefined) options.keepExtra = keepExtra;
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
    }),
  );

  /** Calcule le plan demandé, ou renvoie la réponse d'erreur adaptée. */
  async function planFor(c: Context): Promise<PlanResult | Response> {
    const user = (c.req.param('user') ?? '').trim();
    if (!user || user.length > 64) return c.json({ error: 'Pseudo invalide.' }, 400);
    const ruleSetParam = (c.req.query('ruleset') ?? options.ruleSet).toUpperCase();
    const ruleSet: RuleSet = ruleSetParam === 'HARDCORE' ? 'HARDCORE' : 'NORMAL';
    try {
      return await service.plan(user, ruleSet, parsePlannerQuery(c.req.query()), {
        fresh: c.req.query('fresh') === '1',
      });
    } catch (error) {
      if (error instanceof ZuNotFoundError) {
        return c.json({ error: `Joueur « ${user} » introuvable sur ZUnivers (${ruleSet}).` }, 404);
      }
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
      logger.error(`Erreur inattendue pour ${user}`, error);
      return c.json({ error: 'Erreur interne.' }, 500);
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
    const plan = await planFor(c);
    if (plan instanceof Response) return plan;
    return notModified(c, plan) ?? c.json(plan);
  });

  /**
   * Version compacte pour les bots Discord : message prêt à poster (contenu + embed) et plan en
   * pièce jointe quand il est trop long. `?mention=1` mentionne le joueur.
   */
  app.get('/api/plan/:user/discord', async (c) => {
    const plan = await planFor(c);
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
