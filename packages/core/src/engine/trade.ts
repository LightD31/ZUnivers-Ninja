import { FEATURE } from '../rules/constants';
import { reserveFor, reserveTotal, type Reserve } from '../rules/reserve';
import {
  cardKey,
  type CardKey,
  type Catalog,
  type MarketOffer,
  type Player,
  type Shiny,
} from '../model/types';
import { CARD_SEPARATOR, cardsToken } from './commands';
import { buildContext, resolveOptions } from './context';
import { planCard, type PlanCard } from './plan';
import { getCard, initialState } from './state';

/**
 * Exemplaires qu'un joueur garde au lieu de les échanger, comme les options du plan. L'exemplaire
 * à enchanter pour une dorée qui manque et les composants des fusions à faire sont toujours
 * gardés.
 */
export interface TradeKeep {
  /** Normales à enchanter pour la constellation dorée (option `keepForGolden` du plan). */
  golden: boolean;
  /** Normales à enchanter pour les fusions dorées encore à faire (`keepForGoldenFusions`). */
  goldenFusions: boolean;
  /** Doublons qui monteront la constellation de la carte. */
  constellation: boolean;
}

export const DEFAULT_TRADE_KEEP: TradeKeep = {
  golden: true,
  goldenFusions: true,
  constellation: true,
};

export const TRADE_KEEP_KEYS = Object.keys(DEFAULT_TRADE_KEEP) as (keyof TradeKeep)[];

/**
 * Pourquoi le donneur garde une carte : son dernier exemplaire, un composant de fusion, une normale
 * à enchanter ou un doublon pour sa constellation.
 */
export type TradeKeptFor = 'last' | 'fusion' | 'enchant' | 'constellation';

/** Carte qu'un joueur peut donner à l'autre : un exemplaire qui manque à l'autre. */
export interface TradeCard extends PlanCard {
  key: CardKey;
  /** Points de collection que la carte rapporte à celui qui la reçoit. */
  points: number;
  /** Exemplaires que le donneur peut céder sans rien perdre (0 pour une carte gardée). */
  spare: number;
  /** Carte gardée : ce que le donneur perdrait en la cédant. */
  keptFor?: TradeKeptFor;
  /** Sur la liste des cartes recherchées du receveur, sur le marché. */
  wanted: boolean;
  /** Proposée par le donneur sur le marché. */
  offered: boolean;
}

export interface TradeSide {
  player: { name: string; displayName: string; avatar: string | null; tradesLeft: number };
  keep: TradeKeep;
  /** Le joueur a une annonce sur le marché. */
  market: boolean;
  /** Cartes que ce joueur peut donner à l'autre, les plus intéressantes d'abord. */
  gives: TradeCard[];
  /**
   * Cartes qui manquent à l'autre mais que ce joueur garde (dernier exemplaire, fusion,
   * enchantement, constellation) : à céder seulement s'il le veut bien, quand l'autre les demande.
   */
  kept: TradeCard[];
}

export interface TradeResult {
  version: 1;
  generatedAt: string;
  ruleSet: string;
  me: TradeSide;
  other: TradeSide;
}

/** Échanges ouverts dans ce mode de jeu (pas en Hardcore). Une liste vide : tout est actif. */
export const tradesAvailable = (catalog: Catalog) =>
  catalog.settings.features.length === 0 || catalog.settings.features.includes(FEATURE.trade);

/** Ordre d'affichage : cartes recherchées d'abord, puis les plus rares. */
function compareCards(a: TradeCard, b: TradeCard): number {
  return (
    Number(b.wanted) - Number(a.wanted) ||
    b.rarity - a.rarity ||
    b.shiny - a.shiny ||
    a.identifier - b.identifier
  );
}

/** Raison principale pour laquelle aucun exemplaire n'est en trop. */
function keptFor(copies: number, reserve: Reserve): TradeKeptFor {
  let left = copies - reserve.keep;
  if (left <= 0) return 'last';
  left -= reserve.fusion;
  if (left <= 0) return 'fusion';
  left -= reserve.enchant;
  return left <= 0 ? 'enchant' : 'constellation';
}

/** Cartes échangeables de `giver` qui manquent à `receiver` : son surplus, et ce qu'il garde. */
function givable(
  catalog: Catalog,
  giver: Player,
  receiver: Player,
  keep: TradeKeep,
  markets: { giver: MarketOffer | null; receiver: MarketOffer | null },
  now: Date,
): { gives: TradeCard[]; kept: TradeCard[] } {
  // Mêmes réserves que le recyclage du plan. Les doublons gardés pour l'échange (`keepExtra`)
  // sont justement ceux à proposer.
  const options = resolveOptions({
    keepExtra: 0,
    keepForGolden: keep.golden,
    keepForGoldenFusions: keep.goldenFusions,
    allow: { constellation: keep.constellation },
  });
  const ctx = buildContext(catalog, giver, now, options);
  const state = initialState(ctx);
  const offered = new Set(markets.giver?.offers ?? []);
  const wanted = new Set(markets.receiver?.wants ?? []);
  const gives: TradeCard[] = [];
  const kept: TradeCard[] = [];
  for (const owned of Object.values(giver.inventory)) {
    const item = ctx.items[owned.itemId];
    if (!item?.tradable || owned.copies <= 0) continue;
    const shiny: Shiny = owned.shiny;
    const key = cardKey(item.id, shiny);
    // Une carte Constellation seule ne vaut pas possession : la carte manque toujours.
    if ((receiver.inventory[key]?.copies ?? 0) > 0) continue;
    const copies = getCard(state, item.id, shiny).copies;
    const reserve = reserveFor(ctx, state, item.id, shiny);
    const spare = copies - reserveTotal(reserve);
    const card: TradeCard = {
      ...planCard(ctx, item.id, shiny),
      key,
      points: item.scores[shiny],
      spare: Math.max(0, spare),
      wanted: wanted.has(item.id),
      offered: offered.has(item.id),
    };
    if (spare > 0) gives.push(card);
    else kept.push({ ...card, keptFor: keptFor(copies, reserve) });
  }
  return { gives: gives.sort(compareCards), kept: kept.sort(compareCards) };
}

export interface CompareTradeInput {
  catalog: Catalog;
  me: Player;
  other: Player;
  keep?: { me?: Partial<TradeKeep>; other?: Partial<TradeKeep> };
  /** Annonces des joueurs sur le marché, pour mettre en avant les cartes recherchées. */
  market?: { me?: MarketOffer | null; other?: MarketOffer | null };
  now?: Date;
}

/** Ce que deux joueurs peuvent s'échanger : le surplus de chacun qui manque à l'autre. */
export function compareForTrade({
  catalog,
  me,
  other,
  keep = {},
  market = {},
  now = new Date(),
}: CompareTradeInput): TradeResult {
  const keepMe = { ...DEFAULT_TRADE_KEEP, ...keep.me };
  const keepOther = { ...DEFAULT_TRADE_KEEP, ...keep.other };
  const marketMe = market.me ?? null;
  const marketOther = market.other ?? null;
  const side = (
    player: Player,
    sideKeep: TradeKeep,
    sideMarket: MarketOffer | null,
    cards: { gives: TradeCard[]; kept: TradeCard[] },
  ): TradeSide => ({
    player: {
      name: player.name,
      displayName: player.displayName,
      avatar: player.avatar,
      tradesLeft: player.tradesLeft,
    },
    keep: sideKeep,
    market: sideMarket !== null,
    ...cards,
  });
  return {
    version: 1,
    generatedAt: now.toISOString(),
    ruleSet: catalog.ruleSet,
    me: side(
      me,
      keepMe,
      marketMe,
      givable(catalog, me, other, keepMe, { giver: marketMe, receiver: marketOther }, now),
    ),
    other: side(
      other,
      keepOther,
      marketOther,
      givable(catalog, other, me, keepOther, { giver: marketOther, receiver: marketMe }, now),
    ),
  };
}

export interface TradeProposal {
  /** Cartes que je reçois. */
  receive: TradeCard[];
  /** Cartes que je donne. */
  give: TradeCard[];
  /** Cartes ajoutées pour équilibrer l'échange. */
  added: CardKey[];
  /** Cartes choisies sans contrepartie de même rareté et brillance. */
  unmatched: CardKey[];
}

const bucketOf = (c: TradeCard) => `${c.rarity}:${c.shiny}`;

/** Ordre d'affichage d'un échange : par rareté et brillance, puis par numéro. */
const byCategory = (a: TradeCard, b: TradeCard) =>
  b.rarity - a.rarity || b.shiny - a.shiny || a.identifier - b.identifier;

/**
 * Échange équilibré, carte pour carte. Les cartes choisies des deux côtés s'échangent entre elles :
 * de même rareté et brillance d'abord, puis les autres, au plus proche en points (le joueur a
 * choisi lui-même la contrepartie). Une carte qui reste seule reçoit en face une carte de même
 * rareté et brillance, la plus intéressante d'abord (recherchée sur le marché), ou reste dans
 * l'échange sans contrepartie, signalée. Une carte gardée peut être choisie (l'autre la demande),
 * jamais ajoutée d'office.
 */
export function proposeTrade(
  trade: Pick<TradeResult, 'me' | 'other'>,
  picked: { receive: readonly CardKey[]; give: readonly CardKey[] },
): TradeProposal {
  const pickedReceive = new Set(picked.receive);
  const pickedGive = new Set(picked.give);
  const chosenReceive = [...trade.other.gives, ...trade.other.kept]
    .filter((c) => pickedReceive.has(c.key))
    .sort(byCategory);
  const chosenGive = [...trade.me.gives, ...trade.me.kept]
    .filter((c) => pickedGive.has(c.key))
    .sort(byCategory);

  // Cartes choisies restées seules après les paires de même catégorie.
  const aloneReceive: TradeCard[] = [];
  const aloneGive: TradeCard[] = [];
  for (const bucket of new Set([...chosenReceive, ...chosenGive].map(bucketOf))) {
    const receive = chosenReceive.filter((c) => bucketOf(c) === bucket);
    const give = chosenGive.filter((c) => bucketOf(c) === bucket);
    aloneReceive.push(...receive.slice(give.length));
    aloneGive.push(...give.slice(receive.length));
  }
  // Paires entre catégories, les plus proches en points ensemble : les plus chères des deux côtés.
  const byPoints = (a: TradeCard, b: TradeCard) => b.points - a.points || byCategory(a, b);
  const crossed = Math.min(aloneReceive.length, aloneGive.length);
  const leftReceive = aloneReceive.sort(byPoints).slice(crossed).sort(byCategory);
  const leftGive = aloneGive.sort(byPoints).slice(crossed).sort(byCategory);

  // Les cartes encore seules reçoivent une contrepartie de même catégorie, la meilleure d'abord.
  const added: TradeCard[] = [];
  const unmatched: CardKey[] = [];
  const fill = (alone: TradeCard[], pool: TradeCard[], chosen: Set<CardKey>) => {
    const free = pool.filter((c) => !chosen.has(c.key)).sort(compareCards);
    const extra: TradeCard[] = [];
    for (const card of alone) {
      const match = free.find((c) => bucketOf(c) === bucketOf(card) && !extra.includes(c));
      if (match) extra.push(match);
      else unmatched.push(card.key);
    }
    added.push(...extra);
    return extra;
  };
  const giveExtra = fill(leftReceive, trade.me.gives, pickedGive);
  const receiveExtra = fill(leftGive, trade.other.gives, pickedReceive);

  return {
    receive: [...chosenReceive, ...receiveExtra].sort(byCategory),
    give: [...chosenGive, ...giveExtra].sort(byCategory),
    added: added.map((c) => c.key),
    unmatched,
  };
}

/** Contreparties possibles pour une catégorie (rareté et brillance) de l'échange. */
export interface TradeAlternative {
  rarity: number;
  shiny: Shiny;
  /** Autres cartes de l'autre joueur à demander en échange. */
  ask: TradeCard[];
  /** Autres cartes à lui proposer. */
  offer: TradeCard[];
  /**
   * Les cartes sont de même rareté et brillance. Sinon (aucune ne l'est et une carte de l'échange
   * reste sans contrepartie), ce sont les plus proches en points de collection.
   */
  askExact: boolean;
  offerExact: boolean;
}

/** Contreparties approchées montrées au plus, faute de carte de même rareté et brillance. */
const CLOSEST_LIMIT = 8;

/**
 * Toutes les contreparties possibles, catégorie par catégorie de l'échange : ce que je peux
 * demander d'autre en échange de mes cartes, et proposer d'autre pour les siennes. Pour une carte
 * restée sans contrepartie, les cartes les plus proches en points, quelles que soient leur rareté
 * et leur brillance.
 */
export function tradeAlternatives(
  trade: Pick<TradeResult, 'me' | 'other'>,
  proposal: TradeProposal,
): TradeAlternative[] {
  const inTrade = new Set([...proposal.receive, ...proposal.give].map((c) => c.key));
  const unmatched = new Set(proposal.unmatched);
  const seen = new Set<string>();
  const alternatives: TradeAlternative[] = [];
  for (const card of [...proposal.give, ...proposal.receive]) {
    const bucket = bucketOf(card);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    const free = (cards: TradeCard[]) => cards.filter((c) => !inTrade.has(c.key));
    // Contreparties d'une carte restée seule : même catégorie, sinon les plus proches en points.
    const options = (cards: TradeCard[], alone: TradeCard[]) => {
      const exact = free(cards).filter((c) => bucketOf(c) === bucket);
      const missing = alone.find((c) => bucketOf(c) === bucket && unmatched.has(c.key));
      if (exact.length > 0 || !missing) return { cards: exact, exact: true };
      const distance = (c: TradeCard) => Math.abs(c.points - missing.points);
      const closest = free(cards)
        .sort((a, b) => distance(a) - distance(b) || compareCards(a, b))
        .slice(0, CLOSEST_LIMIT);
      return { cards: closest, exact: closest.length === 0 };
    };
    const ask = options(trade.other.gives, proposal.give);
    const offer = options(trade.me.gives, proposal.receive);
    alternatives.push({
      rarity: card.rarity,
      shiny: card.shiny,
      ask: ask.cards,
      offer: offer.cards,
      askExact: ask.exact,
      offerExact: offer.exact,
    });
  }
  return alternatives.sort((a, b) => b.rarity - a.rarity || b.shiny - a.shiny);
}

/** Cartes à coller dans une commande du jeu (`1026 + 1030+`). */
export const tradeCardList = (cards: readonly PlanCard[]) =>
  cards.map((c) => cardsToken(c.identifier, c.shiny, 1)).join(CARD_SEPARATOR);

const describeCards = (cards: readonly PlanCard[]) =>
  cards.map((c) => `${cardsToken(c.identifier, c.shiny, 1)} ${c.name}`).join(', ');

/** Message à envoyer à l'autre joueur pour lui proposer l'échange. */
export function tradeMessage(otherName: string, proposal: TradeProposal): string {
  const give = describeCards(proposal.give);
  const receive = describeCards(proposal.receive);
  if (give && receive)
    return `Salut ${otherName} ! Je te propose un échange : ${give} contre ${receive}. Ça te va ?`;
  if (receive) return `Salut ${otherName} ! Tu pourrais m'échanger ${receive} ?`;
  if (give) return `Salut ${otherName} ! Je peux te donner ${give}, ça t'intéresse ?`;
  return '';
}
