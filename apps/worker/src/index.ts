import { serve } from '@hono/node-server';
import { Cron } from 'croner';
import { loadConfig } from './config';
import { logger, setLogLevel } from './logger';
import { discordNotifier } from './notifiers/discord';
import { jsonNotifier } from './notifiers/json';
import type { Notifier } from './notifiers/types';
import { runTick } from './scheduler';
import { createApp } from './server';
import { PlanService, VERSION } from './service';
import { StateStore } from './store';

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  const once = process.argv.includes('--once');

  const service = new PlanService(config);
  const store = new StateStore(config.stateFile);
  const notifiers: Notifier[] = [];
  if (config.discordWebhook)
    notifiers.push(
      discordNotifier(config.discordWebhook, {
        webUrl: config.webUrl,
        mention: config.discordMention,
      }),
    );
  if (config.jsonWebhook) notifiers.push(jsonNotifier(config.jsonWebhook));

  const tickOptions = { users: config.users, ruleSet: config.ruleSet, dryRun: config.dryRun };

  if (once) {
    if (config.users.length === 0) throw new Error('Aucun joueur configuré (variable ZU_USERS).');
    const results = await runTick(service, store, notifiers, tickOptions);
    for (const r of results) {
      console.log(`\n=== ${r.user} ===`);
      if (r.error) console.log(`Erreur : ${r.error}`);
      if (r.plan) {
        console.log(r.plan.commands.join('\n') || '(rien à faire)');
        console.log(
          `\nGain : +${Math.round(r.plan.gain.points)} points, +${r.plan.gain.expected.toFixed(1)} espérés`,
        );
        for (const line of r.plan.advice) console.log(`• ${line}`);
      }
    }
    process.exitCode = results.some((r) => r.error) ? 1 : 0;
    return;
  }

  const app = createApp(service, store, {
    ruleSet: config.ruleSet,
    users: config.users,
    webDir: config.webDir,
    webUrl: config.webUrl,
    cron: config.cron,
  });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    logger.info(`ZUnivers Ninja ${VERSION} à l'écoute sur http://${config.host}:${info.port}`);
  });

  let job: Cron | null = null;
  if (config.users.length > 0) {
    const tick = async () => {
      try {
        await runTick(service, store, notifiers, tickOptions);
      } catch (error) {
        logger.error('Passage planifié échoué', error);
      }
    };
    job = new Cron(config.cron, { timezone: config.timezone, protect: true }, tick);
    logger.info(
      `Conseils automatiques pour ${config.users.join(', ')} (${config.cron}, ${config.timezone})` +
        (notifiers.length
          ? ` → ${notifiers.map((n) => n.name).join(', ')}`
          : ' (aucune notification configurée)') +
        (config.dryRun ? ' [DRY_RUN]' : ''),
    );
    if (config.runOnStart) void tick();
  } else {
    logger.info(
      'Aucun joueur dans ZU_USERS : conseils automatiques désactivés (interface web seule).',
    );
  }

  const shutdown = () => {
    logger.info('Arrêt…');
    job?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
