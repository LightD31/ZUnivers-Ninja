import type {
  Catalog,
  Item,
  ItemOwner,
  MarketListing,
  MarketOffer,
  Player,
  Shiny,
} from '../model/types';
import {
  compareForTrade,
  proposeTrade,
  TRADE_MAX_CARDS,
  tradeNeeds,
  tradeValue,
  type TradeCard,
  type TradeKeep,
  type TradePicks,
  type TradeResult,
  type TradeSide,
} from './trade';

/** Joueurs comparés au plus par recherche : chacun coûte le chargement de sa collection entière. */
export const TRADE_PARTNERS_LIMIT = 30;

/** Cartes dont chercher les plus gros possesseurs : une fiche de carte par carte. */
export const OWNER_LOOKUPS = 20;

/** Plus gros possesseurs comparés au plus, pour laisser de la place à la corporation et au marché. */
export const OWNER_CANDIDATES = 15;

/** Appels à l'API ZUnivers en même temps, pour la ménager. */
const LOAD_CONCURRENCY = 4;

/**
 * Pourquoi un joueur est comparé : partenaire choisi (un échange récent), gros possesseur de cartes
 * que je cherche, membre de la même corporation, ou annonce sur le marché.
 */
export type TradePartnerSource = 'named' | 'owner' | 'corporation' | 'market';

export interface TradeCandidate {
  name: string;
  sources: TradePartnerSource[];
  /** Date de son annonce sur le marché, `null` sans annonce. */
  listedAt: string | null;
  /** Cartes que je cherche dont il a des doubles, d'après leurs plus gros possesseurs. */
  holding: number;
}

/** Carte dont chercher les plus gros possesseurs, et ce qu'elle me rapporterait. */
export interface OwnerLookup {
  item: Item;
  /** Brillances voulues, avec les points de tous leurs exemplaires utiles. */
  wants: { shiny: Shiny; points: number }[];
}

const pointsOf = (lookup: OwnerLookup) => lookup.wants.reduce((total, w) => total + w.points, 0);

/**
 * Cartes dont chercher les plus gros possesseurs : celles que je cherche (voir `tradeNeeds`) qui me
 * rapporteraient le plus, seulement dans les raretés et brillances où j'ai du surplus à donner en
 * face, puisque le jeu n'échange rien d'autre.
 */
export function ownerLookups(
  catalog: Catalog,
  me: Player,
  keep: Partial<TradeKeep> = {},
  now = new Date(),
  limit = OWNER_LOOKUPS,
): OwnerLookup[] {
  const { wants, spare } = tradeNeeds(catalog, me, keep, now);
  const lookups = new Map<string, OwnerLookup>();
  for (const want of wants) {
    const item = catalog.items[want.itemId];
    if (!item?.slug || !spare.has(`${item.rarity}:${want.shiny}`)) continue;
    let lookup = lookups.get(item.id);
    if (!lookup) lookups.set(item.id, (lookup = { item, wants: [] }));
    lookup.wants.push({ shiny: want.shiny, points: want.gains.reduce((t, g) => t + g, 0) });
  }
  return [...lookups.values()]
    .sort((a, b) => pointsOf(b) - pointsOf(a) || a.item.identifier - b.item.identifier)
    .slice(0, limit);
}

/** Un gros possesseur de cartes que je cherche. */
export interface CardHolder {
  name: string;
  /** Cartes que je cherche dont il a des doubles. */
  holding: number;
  /** Points qu'elles me rapporteraient. */
  points: number;
}

/**
 * Les plus gros possesseurs des cartes cherchées (`owners[i]` pour `lookups[i]`), ceux qui ont des
 * doubles des cartes qui me rapporteraient le plus d'abord. Un joueur qui n'a qu'un exemplaire
 * garde le sien : il ne compte pas.
 */
export function rankHolders(
  lookups: readonly OwnerLookup[],
  owners: readonly (readonly ItemOwner[])[],
): CardHolder[] {
  const holders = new Map<string, CardHolder>();
  lookups.forEach((lookup, i) => {
    for (const owner of owners[i] ?? []) {
      const want = lookup.wants.find((w) => w.shiny === owner.shiny);
      if (!want || owner.quantity < 2) continue;
      const key = owner.name.toLowerCase();
      let holder = holders.get(key);
      if (!holder) holders.set(key, (holder = { name: owner.name, holding: 0, points: 0 }));
      holder.holding++;
      holder.points += want.points;
    }
  });
  return [...holders.values()].sort(
    (a, b) => b.points - a.points || b.holding - a.holding || a.name.localeCompare(b.name),
  );
}

/**
 * Joueurs à comparer, sans doublon ni soi-même : les partenaires choisis, puis les plus gros
 * possesseurs des cartes que je cherche (`OWNER_CANDIDATES` au plus), la corporation, et les
 * annonces du marché, la plus récente d'abord. `limit` au plus.
 */
export function tradeCandidates(
  me: Player,
  {
    names = [],
    holders = [],
    market = [],
  }: {
    names?: readonly string[];
    holders?: readonly CardHolder[];
    market?: readonly MarketListing[];
  },
  limit = TRADE_PARTNERS_LIMIT,
): TradeCandidate[] {
  const holding = new Map(holders.map((h) => [h.name.toLowerCase(), h.holding]));
  const candidates = new Map<string, TradeCandidate>();
  const add = (name: string, source: TradePartnerSource, listedAt: string | null = null) => {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || key === me.name.toLowerCase()) return;
    const known = candidates.get(key);
    if (!known)
      candidates.set(key, {
        name: trimmed,
        sources: [source],
        listedAt,
        holding: holding.get(key) ?? 0,
      });
    else {
      if (!known.sources.includes(source)) known.sources.push(source);
      known.listedAt ??= listedAt;
    }
  };
  for (const name of names) add(name, 'named');
  for (const holder of holders.slice(0, OWNER_CANDIDATES)) add(holder.name, 'owner');
  for (const name of me.corporation?.members ?? []) add(name, 'corporation');
  for (const listing of market) add(listing.name, 'market', listing.date);
  return [...candidates.values()].slice(0, limit);
}

/** Exemplaires choisis d'un côté de l'échange, et ce qu'ils rapportent au receveur. */
interface Selection {
  points: number;
  /** Cartes choisies que le receveur recherche sur le marché. */
  wanted: number;
  picks: TradePicks;
}

const NOTHING: Selection = { points: 0, wanted: 0, picks: {} };

const merge = (a: Selection, b: Selection): Selection => ({
  points: a.points + b.points,
  wanted: a.wanted + b.wanted,
  picks: { ...a.picks, ...b.picks },
});

/**
 * Meilleurs exemplaires à prendre parmi des cartes de même rareté et brillance, pour chaque nombre
 * d'exemplaires de 0 à `TRADE_MAX_CARDS` (`undefined` : il n'y en a pas assez). Le plus de points
 * pour le receveur, puis le plus de cartes qu'il recherche. Les exemplaires d'une carte se prennent
 * dans l'ordre de `gains` : le premier compte comme la carte, les suivants pour sa fusion, sa
 * constellation ou une dorée à enchanter.
 */
function bestSelections(cards: readonly TradeCard[]): (Selection | undefined)[] {
  let best: (Selection | undefined)[] = Array.from({ length: TRADE_MAX_CARDS + 1 }, (_, i) =>
    i === 0 ? NOTHING : undefined,
  );
  for (const card of cards) {
    const next = [...best];
    best.forEach((base, have) => {
      if (!base) return;
      let points = 0;
      for (let take = 1; take <= card.gains.length && have + take <= TRADE_MAX_CARDS; take++) {
        points += card.gains[take - 1]!;
        const known = next[have + take];
        const selection = {
          points: base.points + points,
          wanted: base.wanted + Number(card.wanted),
          picks: { ...base.picks, [card.key]: take },
        };
        if (
          !known ||
          selection.points > known.points ||
          (selection.points === known.points && selection.wanted > known.wanted)
        )
          next[have + take] = selection;
      }
    });
    best = next;
  }
  return best;
}

/** Un échange possible : les exemplaires reçus, ceux donnés, et leur nombre de chaque côté. */
interface Pairing {
  receive: Selection;
  give: Selection;
  copies: number;
}

/**
 * `a` vaut mieux que `b` : plus de points pour moi, puis plus d'exemplaires utiles échangés, plus de
 * points pour l'autre, et enfin plus de cartes recherchées sur le marché.
 */
const preferred = (a: Pairing, b: Pairing | undefined) =>
  !b ||
  (a.receive.points - b.receive.points ||
    a.copies - b.copies ||
    a.give.points - b.give.points ||
    a.receive.wanted + a.give.wanted - b.receive.wanted - b.give.wanted) > 0;

/** Le meilleur échange avec un joueur, et ce qu'il rapporte à chacun. */
export interface BestTrade {
  /** Cartes choisies de chaque côté, avec leur nombre d'exemplaires, comme dans la comparaison. */
  picks: { receive: TradePicks; give: TradePicks };
  /** Cartes que je reçois. */
  receive: TradeCard[];
  /** Cartes que je donne. */
  give: TradeCard[];
  /** Points de collection que l'échange rapporte à chacun. */
  points: { receive: number; give: number };
  /** Exemplaires échangés de chaque côté. */
  copies: number;
}

/**
 * Le meilleur échange que le jeu accepterait entre deux joueurs, sans que personne ne perde rien :
 * seul le surplus de chacun dont l'autre a l'usage est échangé, autant d'exemplaires de chaque
 * rareté et brillance des deux côtés, `TRADE_MAX_CARDS` au plus. Le meilleur pour moi d'abord (les
 * points de collection que je gagne), puis le plus d'exemplaires utiles, puis le meilleur pour
 * l'autre. Aucun exemplaire si les deux joueurs n'ont rien à s'échanger.
 */
export function bestTrade(trade: Pick<TradeResult, 'me' | 'other'>): BestTrade {
  const buckets = new Map<string, { receive: TradeCard[]; give: TradeCard[] }>();
  const bucket = (card: TradeCard) => {
    const key = `${card.rarity}:${card.shiny}`;
    let found = buckets.get(key);
    if (!found) buckets.set(key, (found = { receive: [], give: [] }));
    return found;
  };
  for (const card of trade.other.gives) bucket(card).receive.push(card);
  for (const card of trade.me.gives) bucket(card).give.push(card);

  // Meilleur échange pour chaque nombre d'exemplaires, catégorie après catégorie : le jeu exige
  // autant d'exemplaires de chaque rareté et brillance des deux côtés.
  let best: (Pairing | undefined)[] = [{ receive: NOTHING, give: NOTHING, copies: 0 }];
  for (const { receive, give } of buckets.values()) {
    const received = bestSelections(receive);
    const given = bestSelections(give);
    const next = [...best];
    best.forEach((base, have) => {
      if (!base) return;
      for (let pairs = 1; have + pairs <= TRADE_MAX_CARDS; pairs++) {
        const r = received[pairs];
        const g = given[pairs];
        if (!r || !g) break;
        const pairing = {
          receive: merge(base.receive, r),
          give: merge(base.give, g),
          copies: have + pairs,
        };
        if (preferred(pairing, next[have + pairs])) next[have + pairs] = pairing;
      }
    });
    best = next;
  }
  let chosen = best[0]!;
  for (const pairing of best) if (pairing && preferred(pairing, chosen)) chosen = pairing;

  const picks = { receive: chosen.receive.picks, give: chosen.give.picks };
  const proposal = proposeTrade(trade, picks);
  const value = (cards: TradeCard[]) => cards.reduce((total, c) => total + tradeValue(c), 0);
  return {
    picks,
    receive: proposal.receive,
    give: proposal.give,
    points: { receive: value(proposal.receive), give: value(proposal.give) },
    copies: chosen.copies,
  };
}

/** Un joueur avec qui échanger, et le meilleur échange à lui proposer. */
export interface TradePartner extends BestTrade {
  player: TradeSide['player'];
  sources: TradePartnerSource[];
  /** Date de son annonce sur le marché, `null` sans annonce. */
  listedAt: string | null;
  /** Cartes que je cherche dont il a des doubles, d'après leurs plus gros possesseurs. */
  holding: number;
  /**
   * Cartes en trop que chacun peut donner à l'autre et qui lui sont utiles, au-delà du meilleur
   * échange : de quoi en faire d'autres, ou choisir d'autres cartes.
   */
  useful: { receive: number; give: number };
}

export interface TradePartners {
  version: 1;
  generatedAt: string;
  ruleSet: string;
  me: TradeSide['player'];
  /** Joueurs avec qui un échange est possible, les plus intéressants d'abord. */
  partners: TradePartner[];
  /** Cartes dont les plus gros possesseurs ont été cherchés. */
  searchedCards: number;
  /** Joueurs comparés. */
  checked: number;
  /** Joueurs dont la collection n'a pas pu être chargée (pseudo changé, API indisponible…). */
  failed: string[];
}

const comparePartners = (a: TradePartner, b: TradePartner) =>
  b.points.receive - a.points.receive ||
  b.copies - a.copies ||
  b.points.give - a.points.give ||
  b.useful.receive - a.useful.receive ||
  a.player.name.localeCompare(b.player.name);

/** `load` sur chaque élément, `limit` à la fois ; `undefined` pour un élément qui échoue. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  load: (item: T) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = items.map(() => undefined);
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await load(items[index]!);
      } catch {
        // Signalé par `undefined`.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, work));
  return results;
}

export interface FindTradePartnersInput {
  catalog: Catalog;
  me: Player;
  /** Mon annonce sur le marché. */
  market?: MarketOffer | null;
  /** Partenaires choisis (échanges récents), comparés en premier. */
  names?: readonly string[];
  /** Annonces du marché, la plus récente d'abord. */
  listings?: readonly MarketListing[];
  /** Plus gros possesseurs d'une carte. */
  owners: (item: Item) => Promise<ItemOwner[]>;
  /** Collection d'un joueur, et son annonce sur le marché. */
  load: (candidate: TradeCandidate) => Promise<{ player: Player; market: MarketOffer | null }>;
  /** Exemplaires gardés par moi, et par chacun des autres. */
  keep?: { me?: Partial<TradeKeep>; other?: Partial<TradeKeep> };
  /** Appels en même temps. */
  concurrency?: number;
  now?: Date;
}

/**
 * Les meilleurs joueurs avec qui échanger. Les plus gros possesseurs des cartes que je cherche sont
 * trouvés sur leurs fiches, puis chaque joueur à comparer (voir `tradeCandidates`) l'est comme dans
 * l'onglet Échanges, et classé selon le meilleur échange possible avec lui (voir `bestTrade`). Un
 * joueur qui ne se charge pas est signalé, sans empêcher la recherche.
 */
export async function findTradePartners({
  catalog,
  me,
  market = null,
  names = [],
  listings = [],
  owners,
  load,
  keep = {},
  concurrency = LOAD_CONCURRENCY,
  now = new Date(),
}: FindTradePartnersInput): Promise<TradePartners> {
  const lookups = ownerLookups(catalog, me, keep.me, now);
  const found = await mapLimit(lookups, concurrency, (lookup) => owners(lookup.item));
  const holders = rankHolders(
    lookups,
    found.map((list) => list ?? []),
  );
  const candidates = tradeCandidates(me, { names, holders, market: listings });
  const loaded = await mapLimit(candidates, concurrency, load);

  const partners: TradePartner[] = [];
  candidates.forEach((candidate, i) => {
    const other = loaded[i];
    if (!other) return;
    const trade = compareForTrade({
      catalog,
      me,
      other: other.player,
      keep,
      market: { me: market, other: other.market },
      now,
    });
    const best = bestTrade(trade);
    if (best.copies === 0) return;
    partners.push({
      player: trade.other.player,
      sources: candidate.sources,
      listedAt: candidate.listedAt,
      holding: candidate.holding,
      ...best,
      useful: { receive: trade.other.gives.length, give: trade.me.gives.length },
    });
  });
  return {
    version: 1,
    generatedAt: now.toISOString(),
    ruleSet: catalog.ruleSet,
    me: {
      name: me.name,
      displayName: me.displayName,
      avatar: me.avatar,
      tradesLeft: me.tradesLeft,
    },
    partners: partners.sort(comparePartners),
    searchedCards: lookups.length,
    checked: loaded.filter(Boolean).length,
    failed: candidates.filter((_, i) => !loaded[i]).map((c) => c.name),
  };
}
