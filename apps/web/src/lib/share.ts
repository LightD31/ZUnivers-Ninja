import {
  DEFAULT_TRADE_KEEP,
  parsePlannerQuery,
  parseTradeKeep,
  plannerQuery,
  tradeKeepQuery,
  TRADE_KEEP_KEYS,
  type RuleSet,
  type Shiny,
  type TradeCard,
  type TradeKeep,
  type TradePicks,
} from '@zuninja/core';
import { linkOptions, settingsFromQuery, type Settings } from './settings';

/**
 * Lien vers une page de l'interface, qui la reproduit exactement : joueur, réglages du
 * planificateur, onglet, échange en cours et cartes choisies. Les réglages ont les noms des
 * paramètres de l'API (`/api/plan`) ; un lien qui porte `strategy` les donne tous, ceux qu'il ne
 * cite pas valant le préréglage de la stratégie.
 */

export type Tab = 'plan' | 'collection' | 'achievements' | 'trade';
const TABS: readonly Tab[] = ['plan', 'collection', 'achievements', 'trade'];

/** Une carte choisie dans un échange : son numéro dans le jeu, sa brillance, ses exemplaires. */
export interface LinkedCard {
  identifier: number;
  shiny: Shiny;
  count: number;
}

export interface TradeLink {
  partner: string;
  /** Réserve de chacun, `null` : celle par défaut. */
  keep: { me: TradeKeep | null; other: TradeKeep | null };
  /** Cartes choisies : celles que je reçois, celles que je donne. */
  picks: { receive: LinkedCard[]; give: LinkedCard[] };
}

export interface View {
  user: string;
  /** Mode de jeu, `null` : celui du visiteur. */
  ruleSet: RuleSet | null;
  /** Réglages du planificateur, `null` : ceux du visiteur. */
  settings: Settings | null;
  tab: Tab;
  trade: TradeLink | null;
}

/** Réserve par défaut du joueur dans un échange : les cases de son plan. */
export const myTradeKeep = (s: Settings): TradeKeep => ({
  golden: s.keepForGolden,
  goldenFusions: s.keepForGoldenFusions,
  constellation: !s.skip.includes('constellation'),
});

export const sameKeep = (a: TradeKeep, b: TradeKeep) => TRADE_KEEP_KEYS.every((k) => a[k] === b[k]);

/** Brillance dans un lien : rien pour une normale, `d` pour une dorée, `c` pour une chroma. */
const SHINY_LETTER: Record<Shiny, string> = { 0: '', 1: 'd', 2: 'c' };

const cardToken = (c: LinkedCard) =>
  `${c.identifier}${SHINY_LETTER[c.shiny]}${c.count > 1 ? `x${c.count}` : ''}`;

function parseCards(value: string | null): LinkedCard[] {
  return (value ?? '').split(',').flatMap((token) => {
    const match = /^(\d+)([dc]?)(?:x(\d+))?$/.exec(token.trim());
    if (!match) return [];
    const shiny: Shiny = match[2] === 'd' ? 1 : match[2] === 'c' ? 2 : 0;
    return [{ identifier: Number(match[1]), shiny, count: Math.max(1, Number(match[3] ?? 1)) }];
  });
}

function parseKeep(value: string | null): TradeKeep | null {
  return value === null ? null : { ...DEFAULT_TRADE_KEEP, ...parseTradeKeep(value) };
}

/** La page que décrit un lien (`location.search`). */
export function readLink(search: string): View {
  const params = new URLSearchParams(search);
  const mode = params.get('mode')?.toUpperCase();
  const ruleSet: RuleSet | null = mode === 'HARDCORE' || mode === 'NORMAL' ? mode : null;
  const partner = params.get('with')?.trim() ?? '';
  const tab = params.get('tab');
  // Avec `strategy`, le lien donne tous les réglages ; sans, ceux du visiteur s'appliquent.
  const exact = parsePlannerQuery(Object.fromEntries(params));
  return {
    user: params.get('u')?.trim() ?? '',
    ruleSet,
    settings: exact.strategy ? settingsFromQuery(ruleSet ?? 'NORMAL', exact) : null,
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : partner ? 'trade' : 'plan',
    trade: partner
      ? {
          partner,
          keep: { me: parseKeep(params.get('keep')), other: parseKeep(params.get('otherKeep')) },
          picks: { receive: parseCards(params.get('take')), give: parseCards(params.get('give')) },
        }
      : null,
  };
}

/** Paramètres du lien d'une page, ceux implicites omis. */
export function linkQuery(view: View): string {
  const params = new URLSearchParams();
  if (view.user) {
    params.set('u', view.user);
    if (view.ruleSet === 'HARDCORE') params.set('mode', 'hardcore');
    if (view.settings)
      for (const [key, value] of Object.entries(plannerQuery(linkOptions(view.settings))))
        params.set(key, value);
    const { trade } = view;
    if (view.tab !== (trade ? 'trade' : 'plan')) params.set('tab', view.tab);
    if (trade) {
      params.set('with', trade.partner);
      if (trade.keep.me) params.set('keep', tradeKeepQuery(trade.keep.me));
      if (trade.keep.other) params.set('otherKeep', tradeKeepQuery(trade.keep.other));
      if (trade.picks.receive.length > 0)
        params.set('take', trade.picks.receive.map(cardToken).join(','));
      if (trade.picks.give.length > 0)
        params.set('give', trade.picks.give.map(cardToken).join(','));
    }
  }
  // Les virgules des listes restent lisibles : elles sont permises dans une requête.
  return params.toString().replace(/%2C/gi, ',');
}

/** Lien complet vers une page, depuis `base` (l'adresse de l'interface). */
export function linkUrl(view: View, base = `${location.origin}${location.pathname}`): string {
  const query = linkQuery(view);
  return query ? `${base}?${query}` : base;
}

/** Cartes choisies (`TradePicks`), telles qu'un lien les écrit. */
export function picksToLink(cards: readonly TradeCard[], picks: TradePicks): LinkedCard[] {
  const byKey = new Map(cards.map((c) => [c.key, c]));
  return Object.entries(picks).flatMap(([key, count]) => {
    const card = byKey.get(key as TradeCard['key']);
    return card && count ? [{ identifier: card.identifier, shiny: card.shiny, count }] : [];
  });
}

/** Les cartes d'une proposition, avec leurs exemplaires, telles qu'un lien les écrit. */
export const cardsToLink = (cards: readonly TradeCard[]): LinkedCard[] =>
  cards.map((c) => ({ identifier: c.identifier, shiny: c.shiny, count: c.count }));

/** Cartes choisies d'un lien, retrouvées parmi celles de l'échange ; les autres sont ignorées. */
export function picksFromLink(
  cards: readonly TradeCard[],
  linked: readonly LinkedCard[],
): TradePicks {
  const picks: Partial<Record<TradeCard['key'], number>> = {};
  for (const l of linked) {
    const card = cards.find((c) => c.identifier === l.identifier && c.shiny === l.shiny);
    if (card) picks[card.key] = l.count;
  }
  return picks;
}

/**
 * Le même échange vu par l'autre joueur : sa page, ses réglages à lui (aucun dans le lien), et les
 * cartes et réserves de chacun inversées. Les réserves sont écrites en entier : celles par défaut
 * dépendent des réglages de chacun.
 */
export function partnerView(me: string, trade: TradeLink, settings: Settings): View {
  return {
    user: trade.partner,
    ruleSet: null,
    settings: null,
    tab: 'trade',
    trade: {
      partner: me,
      keep: {
        me: trade.keep.other ?? DEFAULT_TRADE_KEEP,
        other: trade.keep.me ?? myTradeKeep(settings),
      },
      picks: { receive: trade.picks.give, give: trade.picks.receive },
    },
  };
}
