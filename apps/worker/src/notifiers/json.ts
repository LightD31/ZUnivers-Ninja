import { logger } from '../logger';
import type { Notifier } from './types';

/** Envoie le plan brut en JSON à n'importe quel service (remplace l'ancien système de plugins). */
export function jsonNotifier(url: string): Notifier {
  return {
    name: 'json',
    async notify(plan) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'plan', user: plan.player.name, plan }),
      });
      if (!res.ok) throw new Error(`Webhook JSON : HTTP ${res.status}`);
      logger.info(`Plan envoyé au webhook JSON pour ${plan.player.name}`);
    },
  };
}
