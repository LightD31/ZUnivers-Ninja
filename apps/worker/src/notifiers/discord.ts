import {
  CURRENCY_LABEL,
  DEFAULT_STRATEGY,
  SHINY_LABEL,
  type Currency,
  type PlanResult,
  type Shiny,
} from '@zuninja/core';
import { logger } from '../logger';
import type { Notifier } from './types';

const COLOR = 0xff3434;
const AVATAR =
  'https://repository-images.githubusercontent.com/420819440/51db7016-b325-4d1b-a1d3-ce82d771f58b';
const DESCRIPTION_LIMIT = 4096;
const FIELD_LIMIT = 1024;

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');
const signed = (n: number) => `${Math.round(n) > 0 ? '+' : ''}${fmt(n)}`;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export interface DiscordOptions {
  webUrl?: string | undefined;
  mention?: boolean;
}

export interface DiscordMessage {
  payload: Record<string, unknown>;
  /** Plan complet en pièce jointe quand il dépasse la limite d'un embed. */
  attachment: { name: string; content: string } | null;
}

/** Construit le message Discord (embed) d'un plan. */
export function buildDiscordMessage(
  plan: PlanResult,
  options: DiscordOptions = {},
): DiscordMessage {
  const commands = plan.commands.join('\n');
  const block = `\`\`\`\n${commands}\n\`\`\``;
  const fitsInEmbed = block.length + 40 <= DESCRIPTION_LIMIT;

  const money = (Object.keys(plan.before.balances) as Currency[])
    .filter((c) => plan.before.balances[c] !== plan.after.balances[c])
    .map(
      (c) =>
        `${CURRENCY_LABEL[c]} : \`${fmt(plan.before.balances[c])}\` → \`${fmt(plan.after.balances[c])}\``,
    );
  const collection = ([0, 1, 2] as Shiny[])
    .filter((s) => plan.before.unique[s] !== plan.after.unique[s])
    .map(
      (s) =>
        `${SHINY_LABEL[s]} : \`${plan.before.unique[s]}\` → \`${plan.after.unique[s]}\` / ${plan.after.total[s]}`,
    );
  if (plan.before.constellationLevels !== plan.after.constellationLevels) {
    collection.push(
      `Constellations : \`${plan.before.constellationLevels}\` → \`${plan.after.constellationLevels}\` / ${plan.after.constellationMax}`,
    );
  }
  const challenges = plan.challenges
    .filter((c) => c.after !== c.before)
    .map((c) => `${c.description} : \`${c.before}/${c.max}\` → \`${c.after}/${c.max}\``);

  const fields = [
    {
      name: 'Gain',
      value: `${signed(plan.gain.points)} points${plan.gain.expected > 0.5 ? ` (+${fmt(plan.gain.expected)} espérés)` : ''}`,
      inline: true,
    },
    ...(money.length ? [{ name: 'Monnaies', value: money.join('\n'), inline: true }] : []),
    ...(collection.length
      ? [{ name: 'Collection', value: collection.join('\n'), inline: false }]
      : []),
    ...(challenges.length ? [{ name: 'Défis', value: challenges.join('\n'), inline: false }] : []),
  ].map((f) => ({ ...f, value: clip(f.value, FIELD_LIMIT) }));

  // Le lien ouvre le plan avec la même stratégie (paramètre omis pour la stratégie par défaut).
  const linkParams = new URLSearchParams({ u: plan.player.name });
  if (plan.strategy.id !== DEFAULT_STRATEGY) linkParams.set('strategy', plan.strategy.id);
  const link = options.webUrl ? `${options.webUrl.replace(/\/+$/, '')}/?${linkParams}` : undefined;
  const description = fitsInEmbed
    ? block
    : `Le plan compte ${plan.commands.length} commandes : il est joint en fichier.${link ? `\n[Voir le détail](${link})` : ''}`;

  const mention =
    options.mention && plan.player.discordId
      ? `<@${plan.player.discordId}>`
      : plan.player.displayName;
  return {
    payload: {
      username: 'ZUnivers Ninja',
      avatar_url: AVATAR,
      content: `Conseils pour ${mention}`,
      allowed_mentions: {
        parse: [],
        users: options.mention && plan.player.discordId ? [plan.player.discordId] : [],
      },
      embeds: [
        {
          title: `Plan du jour — ${plan.player.displayName}`,
          ...(link ? { url: link } : {}),
          color: COLOR,
          description,
          fields,
          ...(plan.player.avatar ? { thumbnail: { url: plan.player.avatar } } : {}),
          footer: {
            text: [
              `Stratégie : ${plan.strategy.label}`,
              plan.season
                ? `Vortex : ${plan.season.name} · forge « ${plan.season.group} » jusqu'au ${plan.season.end.split('-').reverse().join('/')}`
                : 'ZUnivers Ninja',
            ].join(' · '),
          },
          timestamp: plan.generatedAt,
        },
      ],
    },
    attachment: fitsInEmbed ? null : { name: 'conseils.txt', content: `${commands}\n` },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendDiscord(
  webhookUrl: string,
  message: DiscordMessage,
  fetchImpl: typeof fetch = fetch,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let body: BodyInit;
    const headers: Record<string, string> = {};
    if (message.attachment) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(message.payload));
      form.append(
        'files[0]',
        new Blob([message.attachment.content], { type: 'text/plain' }),
        message.attachment.name,
      );
      body = form;
    } else {
      body = JSON.stringify(message.payload);
      headers['content-type'] = 'application/json';
    }
    const res = await fetchImpl(webhookUrl, { method: 'POST', body, headers });
    if (res.ok) return;
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.ceil((data.retry_after ?? 1) * 1000));
      continue;
    }
    throw new Error(`Webhook Discord : HTTP ${res.status} ${await res.text().catch(() => '')}`);
  }
  throw new Error('Webhook Discord : trop de requêtes (429)');
}

export function discordNotifier(webhookUrl: string, options: DiscordOptions): Notifier {
  return {
    name: 'discord',
    async notify(plan) {
      await sendDiscord(webhookUrl, buildDiscordMessage(plan, options));
      logger.info(`Conseils envoyés sur Discord pour ${plan.player.name}`);
    },
  };
}
