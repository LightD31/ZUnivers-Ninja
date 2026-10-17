import type { PlanResult, RuleSet, StrategyId } from '@zuninja/core';
import { logger } from './logger';
import type { Metrics } from './metrics';
import type { Notifier } from './notifiers/types';
import type { PlanService } from './service';
import type { StateStore } from './store';

export interface TickOptions {
  users: string[];
  ruleSet: RuleSet;
  dryRun: boolean;
  /** Stratégie choisie par joueur (pseudo en minuscules), sinon celle du serveur. */
  strategies?: Record<string, StrategyId>;
  metrics?: Metrics | null;
}

export interface TickResult {
  user: string;
  plan?: PlanResult;
  notified: boolean;
  error?: string;
}

/**
 * Un passage : calcule le plan de chaque joueur suivi et ne notifie que s'il a changé
 * depuis la dernière notification.
 */
export async function runTick(
  service: PlanService,
  store: StateStore,
  notifiers: Notifier[],
  options: TickOptions,
): Promise<TickResult[]> {
  const results: TickResult[] = [];
  for (const user of options.users) {
    const now = new Date().toISOString();
    try {
      const strategy = options.strategies?.[user.toLowerCase()];
      const plan = await service.plan(user, options.ruleSet, strategy ? { strategy } : {}, {
        fresh: true,
      });
      const previous = store.user(user);
      const changed = plan.commands.length > 0 && plan.hash !== previous.hash;
      let notified = false;
      if (changed && !options.dryRun) {
        for (const notifier of notifiers) {
          try {
            await notifier.notify(plan);
            notified = true;
          } catch (error) {
            logger.error(`Notification ${notifier.name} échouée pour ${user}`, error);
          }
        }
      }
      store.update(user, {
        checkedAt: now,
        lastError: null,
        ...(notified || (changed && notifiers.length === 0 && !options.dryRun)
          ? { hash: plan.hash, notifiedAt: now }
          : {}),
      });
      logger.info(
        `${user} (${plan.strategy.label}) : ${plan.commands.length} commandes, ${plan.gain.points > 0 ? '+' : ''}${Math.round(plan.gain.points)} points${changed ? '' : ' (inchangé)'}${notified ? ', notifié' : ''}`,
      );
      options.metrics?.request('cron', 'ok');
      results.push({ user, plan, notified });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Échec du plan pour ${user}`, message);
      store.update(user, { checkedAt: now, lastError: message });
      options.metrics?.request('cron', 'error');
      results.push({ user, notified: false, error: message });
    }
  }
  store.lastTick = new Date().toISOString();
  if (!options.dryRun) store.save();
  return results;
}
