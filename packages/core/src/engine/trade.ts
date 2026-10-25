import { CONSTELLATION_POINTS_FACTOR, FEATURE } from '../rules/constants';
import { reserveFor, reserveTotal, type Reserve } from '../rules/reserve';
import {
  cardKey,
  SHINIES,
  type CardKey,
  type Catalog,
  type Item,
  type MarketOffer,
  type Player,
  type Shiny,
} from '../model/types';
import { CARD_SEPARATOR, cardsToken } from './commands';
import { buildContext, resolveOptions, type Context } from './context';
import { planCard, type PlanCard } from './plan';
import { getCard, initialState } from './state';

/**
 * Réserve d'un joueur, comme les options du plan : les exemplaires qu'il garde au lieu de les
 * échanger, et ceux qu'il lui manque encore. L'exemplaire à enchanter pour une dorée qui manque et
 * les composants des fusions à faire en font toujours partie.
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

/**
 * Ce que la carte apporte à celui qui la reçoit : une carte qui lui manque, des exemplaires qu'il
 * lui faut encore pour une fusion, sa constellation ou une dorée à enchanter, ou rien (`none` : il
 * a déjà tout ce qui lui sert, mais rien n'interdit de la lui donner).
 */
export type TradeNeed = 'missing' | 'fusion' | 'constellation' | 'enchant' | 'none';

/**
 * Carte qu'un joueur peut donner à l'autre, qui en a l'usage. `count` : exemplaires proposés par
 * défaut (un pour une carte qui manque, tous ceux qui servent sinon).
 */
export interface TradeCard extends PlanCard {
  key: CardKey;
  /** Points de collection du premier exemplaire pour celui qui le reçoit. */
  points: number;
  /** Ce que le premier exemplaire apporte au receveur. */
  need: TradeNeed;
  /**
   * Points de collection de chaque exemplaire successif pour le receveur (0 pour un composant de
   * fusion ou une normale à enchanter) : autant que d'exemplaires utiles à échanger.
   */
  gains: number[];
  /** Exemplaires que le donneur peut céder sans rien perdre (0 pour une carte gardée). */
  spare: number;
  /**
   * Exemplaires que le donneur peut céder au plus : son surplus, ou tous ceux d'une carte qu'il
   * garde. Au-delà de `gains`, un exemplaire ne sert plus au receveur, mais rien n'interdit de le
   * donner.
   */
  available: number;
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
   * Cartes utiles à l'autre mais que ce joueur garde (dernier exemplaire, fusion, enchantement,
   * constellation) : à céder seulement s'il le veut bien, quand l'autre les demande.
   */
  kept: TradeCard[];
  /**
   * Le reste du surplus de ce joueur : des cartes dont l'autre n'a pas l'usage (il a déjà tout ce
   * qui lui sert), à donner quand même si on le veut. Jamais ajoutées d'office.
   */
  extra: TradeCard[];
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

const NEED_RANK: Record<TradeNeed, number> = {
  missing: 0,
  constellation: 1,
  fusion: 2,
  enchant: 3,
  none: 4,
};

/** Ordre d'affichage : cartes recherchées d'abord, puis celles qui manquent, puis les plus rares. */
function compareCards(a: TradeCard, b: TradeCard): number {
  return (
    Number(b.wanted) - Number(a.wanted) ||
    NEED_RANK[a.need] - NEED_RANK[b.need] ||
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

/**
 * Ce qu'apporterait chaque exemplaire reçu, dans l'ordre où le plan les utilise : l'exemplaire
 * gardé (la carte elle-même), les composants de fusion, les doublons de constellation (même avant
 * les normales à enchanter, voir `reserveBeforeConstellation`), puis les normales à enchanter.
 * `null` si le receveur n'a plus l'usage d'aucun exemplaire.
 */
function receiverGains(
  item: Item,
  shiny: Shiny,
  have: number,
  reserve: Reserve,
): { need: Exclude<TradeNeed, 'none'>; gains: number[] } | null {
  const score = item.scores[shiny];
  const slots: [Exclude<TradeNeed, 'none'>, number, number][] = [
    ['missing', reserve.keep, score],
    ['fusion', reserve.fusion, 0],
    ['constellation', reserve.constellation, score * CONSTELLATION_POINTS_FACTOR],
    ['enchant', reserve.enchant, 0],
  ];
  let owned = have;
  let need: Exclude<TradeNeed, 'none'> | null = null;
  const gains: number[] = [];
  for (const [kind, size, gain] of slots) {
    const free = Math.max(0, size - owned);
    owned = Math.max(0, owned - size);
    if (free > 0) need ??= kind;
    for (let i = 0; i < free; i++) gains.push(gain);
  }
  return need ? { need, gains } : null;
}

/** Contexte de la réserve d'un joueur : celle du plan, sans exemplaires gardés pour l'échange. */
function reserveContext(catalog: Catalog, player: Player, keep: TradeKeep, now: Date): Context {
  // Les doublons gardés pour l'échange (`keepExtra`) sont justement ceux à proposer.
  const options = resolveOptions({
    keepExtra: 0,
    keepForGolden: keep.golden,
    keepForGoldenFusions: keep.goldenFusions,
    allow: { constellation: keep.constellation },
  });
  // Les succès ne changent pas la réserve : inutile de les résoudre, le plus long du contexte.
  return buildContext(catalog, { ...player, achievements: [] }, now, options);
}

/**
 * Cartes échangeables de `giver` dont `receiver` a l'usage, chacun avec sa réserve : celles qui lui
 * manquent, et les exemplaires qu'il lui faut encore (fusion, constellation, normale à enchanter).
 * Le surplus du donneur d'un côté, ce qu'il garde de l'autre, et le reste de son surplus, dont
 * le receveur n'a pas l'usage.
 */
function givable(
  catalog: Catalog,
  players: { giver: Player; receiver: Player },
  keep: { giver: TradeKeep; receiver: TradeKeep },
  markets: { giver: MarketOffer | null; receiver: MarketOffer | null },
  now: Date,
): { gives: TradeCard[]; kept: TradeCard[]; extra: TradeCard[] } {
  const ctx = reserveContext(catalog, players.giver, keep.giver, now);
  const state = initialState(ctx);
  const receiverCtx = reserveContext(catalog, players.receiver, keep.receiver, now);
  const receiverState = initialState(receiverCtx);
  const offered = new Set(markets.giver?.offers ?? []);
  const wanted = new Set(markets.receiver?.wants ?? []);
  const gives: TradeCard[] = [];
  const kept: TradeCard[] = [];
  const extra: TradeCard[] = [];
  for (const owned of Object.values(players.giver.inventory)) {
    const item = ctx.items[owned.itemId];
    if (!item?.tradable || owned.copies <= 0) continue;
    const shiny: Shiny = owned.shiny;
    const copies = getCard(state, item.id, shiny).copies;
    const reserve = reserveFor(ctx, state, item.id, shiny);
    const spare = copies - reserveTotal(reserve);
    // Une carte Constellation seule ne vaut pas possession : la carte manque toujours.
    const use = receiverGains(
      item,
      shiny,
      getCard(receiverState, item.id, shiny).copies,
      reserveFor(receiverCtx, receiverState, item.id, shiny),
    );
    // Sans usage pour le receveur : seul le surplus reste proposé, une carte gardée l'est pour rien.
    if (!use && spare <= 0) continue;
    // Exemplaires à céder : le surplus, ou ce que le donneur céderait de ce qu'il garde.
    const available = spare > 0 ? spare : copies;
    const gains = use?.gains.slice(0, available) ?? [];
    const need: TradeNeed = use?.need ?? 'none';
    const card: TradeCard = {
      ...planCard(ctx, item.id, shiny),
      key: cardKey(item.id, shiny),
      count: spare > 0 && need !== 'missing' && gains.length > 0 ? gains.length : 1,
      points: gains[0] ?? 0,
      need,
      gains,
      spare: Math.max(0, spare),
      available,
      wanted: wanted.has(item.id),
      offered: offered.has(item.id),
    };
    if (!use) extra.push(card);
    else if (spare > 0) gives.push(card);
    else kept.push({ ...card, keptFor: keptFor(copies, reserve) });
  }
  return {
    gives: gives.sort(compareCards),
    kept: kept.sort(compareCards),
    extra: extra.sort(compareCards),
  };
}

/** Carte échangeable dont un joueur a l'usage : elle lui manque, ou il lui en faut encore. */
export interface TradeWant {
  itemId: string;
  shiny: Shiny;
  need: Exclude<TradeNeed, 'none'>;
  /** Points de collection de chaque exemplaire utile, comme `TradeCard.gains`. */
  gains: number[];
}

/**
 * Ce qu'un joueur cherche à obtenir par l'échange, selon sa réserve : les cartes échangeables dont
 * il a l'usage, et les catégories (`rareté:brillance`) où il a du surplus à donner en face. Le jeu
 * n'échange que des cartes de même catégorie : une carte voulue hors de ces catégories ne peut pas
 * être obtenue sans rien perdre.
 */
export function tradeNeeds(
  catalog: Catalog,
  player: Player,
  keep: Partial<TradeKeep> = {},
  now = new Date(),
): { wants: TradeWant[]; spare: Set<string> } {
  const ctx = reserveContext(catalog, player, { ...DEFAULT_TRADE_KEEP, ...keep }, now);
  const state = initialState(ctx);
  const wants: TradeWant[] = [];
  for (const item of ctx.itemList) {
    if (!item.tradable) continue;
    for (const shiny of SHINIES) {
      if (!item.shinyAvailable[shiny]) continue;
      const copies = getCard(state, item.id, shiny).copies;
      const use = receiverGains(item, shiny, copies, reserveFor(ctx, state, item.id, shiny));
      if (use) wants.push({ itemId: item.id, shiny, ...use });
    }
  }
  const spare = new Set<string>();
  for (const owned of Object.values(player.inventory)) {
    const item = ctx.items[owned.itemId];
    if (!item?.tradable) continue;
    const reserve = reserveFor(ctx, state, item.id, owned.shiny);
    if (getCard(state, item.id, owned.shiny).copies > reserveTotal(reserve))
      spare.add(`${item.rarity}:${owned.shiny}`);
  }
  return { wants, spare };
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

/** Ce que deux joueurs peuvent s'échanger : le surplus de chacun dont l'autre a l'usage. */
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
    cards: { gives: TradeCard[]; kept: TradeCard[]; extra: TradeCard[] },
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
      givable(
        catalog,
        { giver: me, receiver: other },
        { giver: keepMe, receiver: keepOther },
        { giver: marketMe, receiver: marketOther },
        now,
      ),
    ),
    other: side(
      other,
      keepOther,
      marketOther,
      givable(
        catalog,
        { giver: other, receiver: me },
        { giver: keepOther, receiver: keepMe },
        { giver: marketOther, receiver: marketMe },
        now,
      ),
    ),
  };
}

export interface TradeProposal {
  /** Cartes que je reçois, avec leur nombre d'exemplaires (`count`). */
  receive: TradeCard[];
  /** Cartes que je donne. */
  give: TradeCard[];
  /** Cartes ajoutées pour équilibrer l'échange. */
  added: CardKey[];
  /** Cartes choisies dont des exemplaires restent sans contrepartie. */
  unmatched: CardKey[];
}

/** Cartes choisies d'un côté de l'échange, avec le nombre d'exemplaires de chacune. */
export type TradePicks = Readonly<Partial<Record<CardKey, number>>>;

const bucketOf = (c: TradeCard) => `${c.rarity}:${c.shiny}`;

/** Ordre d'affichage d'un échange : par rareté et brillance, puis par numéro. */
const byCategory = (a: TradeCard, b: TradeCard) =>
  b.rarity - a.rarity || b.shiny - a.shiny || a.identifier - b.identifier;

/** Un exemplaire d'une carte de l'échange : l'équilibre se fait exemplaire par exemplaire. */
interface Unit {
  card: TradeCard;
  /** Rang de l'exemplaire (0 pour le premier). */
  copy: number;
}

const unitOrder = (a: Unit, b: Unit) => byCategory(a.card, b.card) || a.copy - b.copy;

/**
 * Exemplaires choisis : de 1 à tous ceux que le donneur peut céder, même au-delà de ce qui sert au
 * receveur (ceux-là ne lui rapportent rien, mais comptent dans l'échange comme les autres).
 */
function pickedUnits(cards: TradeCard[], picks: TradePicks): Unit[] {
  return cards.flatMap((card) => {
    const wanted = picks[card.key];
    if (!wanted || wanted <= 0) return [];
    const count = Math.min(Math.max(1, Math.round(wanted)), card.available);
    return Array.from({ length: count }, (_, copy) => ({ card, copy }));
  });
}

/** Regroupe des exemplaires par carte, `count` étant leur nombre. */
function regroup(units: Unit[]): TradeCard[] {
  const cards = new Map<CardKey, TradeCard>();
  for (const { card } of units) {
    const known = cards.get(card.key);
    cards.set(card.key, { ...card, count: (known?.count ?? 0) + 1 });
  }
  return [...cards.values()].sort(byCategory);
}

/**
 * Échange équilibré, exemplaire pour exemplaire, comme l'exige le jeu : autant d'exemplaires de
 * chaque rareté et brillance des deux côtés (source : zunivers.zerator.com/commandes). Les
 * exemplaires choisis de même catégorie s'échangent entre eux ; un exemplaire qui reste seul reçoit
 * en face un exemplaire de même catégorie, de cartes différentes d'abord et la plus intéressante en
 * premier (recherchée sur le marché), ou reste dans l'échange sans contrepartie, signalé. Une carte
 * gardée (l'autre la demande) ou sans usage pour l'autre peut être choisie, jamais ajoutée d'office.
 */
export function proposeTrade(
  trade: Pick<TradeResult, 'me' | 'other'>,
  picked: { receive: TradePicks; give: TradePicks },
): TradeProposal {
  const chosenReceive = pickedUnits(
    [...trade.other.gives, ...trade.other.kept, ...trade.other.extra],
    picked.receive,
  );
  const chosenGive = pickedUnits(
    [...trade.me.gives, ...trade.me.kept, ...trade.me.extra],
    picked.give,
  );
  chosenReceive.sort(unitOrder);
  chosenGive.sort(unitOrder);

  // Exemplaires choisis restés seuls après les paires de même catégorie.
  const aloneReceive: Unit[] = [];
  const aloneGive: Unit[] = [];
  for (const bucket of new Set([...chosenReceive, ...chosenGive].map((u) => bucketOf(u.card)))) {
    const receive = chosenReceive.filter((u) => bucketOf(u.card) === bucket);
    const give = chosenGive.filter((u) => bucketOf(u.card) === bucket);
    aloneReceive.push(...receive.slice(give.length));
    aloneGive.push(...give.slice(receive.length));
  }

  // Ils reçoivent une contrepartie de même catégorie : un exemplaire de chaque carte d'abord, la
  // meilleure en premier.
  const added = new Set<CardKey>();
  const unmatched = new Set<CardKey>();
  const fill = (alone: Unit[], pool: TradeCard[], chosen: TradePicks): Unit[] => {
    const free = pool
      .filter((card) => !chosen[card.key])
      .flatMap((card) => card.gains.map((_, copy) => ({ card, copy })))
      .sort((a, b) => a.copy - b.copy || compareCards(a.card, b.card));
    const extra: Unit[] = [];
    for (const unit of alone) {
      const match = free.find(
        (u) => bucketOf(u.card) === bucketOf(unit.card) && !extra.includes(u),
      );
      if (match) {
        extra.push(match);
        added.add(match.card.key);
      } else unmatched.add(unit.card.key);
    }
    return extra;
  };
  const giveExtra = fill(aloneReceive, trade.me.gives, picked.give);
  const receiveExtra = fill(aloneGive, trade.other.gives, picked.receive);

  return {
    receive: regroup([...chosenReceive, ...receiveExtra]),
    give: regroup([...chosenGive, ...giveExtra]),
    added: [...added],
    unmatched: [...unmatched],
  };
}

/** Points de collection que les exemplaires échangés d'une carte rapportent à celui qui les reçoit. */
export const tradeValue = (card: TradeCard) =>
  card.gains.slice(0, card.count).reduce((total, gain) => total + gain, 0);

/** Contreparties possibles pour une catégorie (rareté et brillance) de l'échange. */
export interface TradeAlternative {
  rarity: number;
  shiny: Shiny;
  /** Autres cartes de l'autre joueur à demander en échange. */
  ask: TradeCard[];
  /** Autres cartes à lui proposer. */
  offer: TradeCard[];
}

/**
 * Toutes les contreparties possibles, catégorie par catégorie de l'échange : ce que je peux
 * demander d'autre en échange de mes cartes, et proposer d'autre pour les siennes. Seulement de
 * même rareté et brillance : le jeu n'accepte rien d'autre.
 */
export function tradeAlternatives(
  trade: Pick<TradeResult, 'me' | 'other'>,
  proposal: TradeProposal,
): TradeAlternative[] {
  const inTrade = new Set([...proposal.receive, ...proposal.give].map((c) => c.key));
  const seen = new Set<string>();
  const alternatives: TradeAlternative[] = [];
  for (const card of [...proposal.give, ...proposal.receive]) {
    const bucket = bucketOf(card);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    const others = (cards: TradeCard[]) =>
      cards.filter((c) => bucketOf(c) === bucket && !inTrade.has(c.key));
    alternatives.push({
      rarity: card.rarity,
      shiny: card.shiny,
      ask: others(trade.other.gives),
      offer: others(trade.me.gives),
    });
  }
  return alternatives.sort((a, b) => b.rarity - a.rarity || b.shiny - a.shiny);
}

/** Cartes au plus de chaque côté d'un échange (source : zunivers.zerator.com/commandes). */
export const TRADE_MAX_CARDS = 6;

/** Ce qui empêche le jeu d'accepter un échange. */
export type TradeIssue =
  /** Des cartes choisies n'ont pas de contrepartie de même rareté et brillance. */
  | { kind: 'unmatched'; cards: number }
  /** Plus de `TRADE_MAX_CARDS` exemplaires d'un côté. */
  | { kind: 'tooMany'; side: 'give' | 'receive'; copies: number };

const copies = (cards: readonly TradeCard[]) => cards.reduce((total, c) => total + c.count, 0);

/** Règles du jeu que l'échange ne respecte pas encore : aucune, il peut être fait tel quel. */
export function tradeIssues(proposal: TradeProposal): TradeIssue[] {
  const issues: TradeIssue[] = [];
  if (proposal.unmatched.length > 0)
    issues.push({ kind: 'unmatched', cards: proposal.unmatched.length });
  for (const side of ['give', 'receive'] as const) {
    const count = copies(proposal[side]);
    if (count > TRADE_MAX_CARDS) issues.push({ kind: 'tooMany', side, copies: count });
  }
  return issues;
}

/**
 * Commande `/échange` à taper dans le jeu, options nommées comme le jeu les attend (vérifié en jeu
 * par un joueur) : `/échange joueur:@pseudo cartes-données:2225*3 cartes-prises:2012 + 2031 + 2032`.
 */
export function tradeCommand(otherName: string, proposal: TradeProposal): string {
  return `/échange joueur:@${otherName} cartes-données:${tradeCardList(proposal.give)} cartes-prises:${tradeCardList(proposal.receive)}`;
}

/** Cartes à coller dans une commande du jeu (`1026 + 1030+ + 2225*2`). */
export const tradeCardList = (cards: readonly PlanCard[]) =>
  cards.map((c) => cardsToken(c.identifier, c.shiny, c.count)).join(CARD_SEPARATOR);

const describeCards = (cards: readonly PlanCard[]) =>
  cards
    .map(
      (c) =>
        `${c.count > 1 ? `${c.count}× ` : ''}${cardsToken(c.identifier, c.shiny, 1)} ${c.name}`,
    )
    .join(', ');

/**
 * Message à envoyer à l'autre joueur pour lui proposer l'échange, suivi de `link` : le lien qui lui
 * ouvre l'échange de son côté.
 */
export function tradeMessage(otherName: string, proposal: TradeProposal, link?: string): string {
  const give = describeCards(proposal.give);
  const receive = describeCards(proposal.receive);
  const message =
    give && receive
      ? `Salut ${otherName} ! Je te propose un échange : ${give} contre ${receive}. Ça te va ?`
      : receive
        ? `Salut ${otherName} ! Tu pourrais m'échanger ${receive} ?`
        : give
          ? `Salut ${otherName} ! Je peux te donner ${give}, ça t'intéresse ?`
          : '';
  return message && link ? `${message} Le détail : ${link}` : message;
}
