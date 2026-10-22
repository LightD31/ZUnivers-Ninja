import { describe, expect, it } from 'vitest';
import {
  cardKey,
  compareForTrade,
  proposeTrade,
  tradeAlternatives,
  tradeCardList,
  tradeMessage,
  tradesAvailable,
  type Item,
  type Shiny,
  type TradeCard,
  type TradeResult,
  type TradeSide,
} from '../src';
import { makeCatalog, makeItem, makePlayer, owned, TEST_NOW } from './factory';
import { fixtureCatalog, fixturePlayer, NOW } from './helpers';

const plain = makeItem(1002, { upgradable: false, goldable: false });
const r2 = makeItem(2001);
const r3 = makeItem(3001);

function compare(
  items: Item[],
  mine: ReturnType<typeof owned>[],
  theirs: ReturnType<typeof owned>[] = [],
  extra: Partial<Parameters<typeof compareForTrade>[0]> = {},
) {
  return compareForTrade({
    catalog: makeCatalog(items),
    me: makePlayer({ name: 'alice', inventory: Object.fromEntries(mine) }),
    other: makePlayer({ name: 'bob', inventory: Object.fromEntries(theirs) }),
    now: TEST_NOW,
    ...extra,
  });
}

const spares = (side: TradeSide) => Object.fromEntries(side.gives.map((c) => [c.key, c.spare]));

describe('cartes échangeables', () => {
  it('propose le surplus réel, y compris les doublons gardés pour l’échange', () => {
    const trade = compare([plain], [owned(plain.id, 0, 4)]);
    expect(spares(trade.me)).toEqual({ [cardKey(plain.id, 0)]: 3 });
    expect(trade.me.gives[0]).toMatchObject({ identifier: 1002, count: 1, points: 1 });
    expect(trade.other.gives).toEqual([]);
  });

  it('ne propose ni une carte non échangeable, ni une carte que l’autre possède', () => {
    const locked = makeItem(1003, { tradable: false, upgradable: false, goldable: false });
    const known = makeItem(1004, { upgradable: false, goldable: false });
    const trade = compare(
      [locked, known, plain],
      [owned(locked.id, 0, 5), owned(known.id, 0, 5), owned(plain.id, 0, 5)],
      // Une carte Constellation seule ne vaut pas possession : la carte manque toujours.
      [owned(known.id, 0, 1), owned(plain.id, 0, 0, 1)],
    );
    expect(trade.me.gives.map((c) => c.identifier)).toEqual([1002]);
  });

  it('garde au choix les normales à enchanter pour la constellation dorée', () => {
    // Constellation normale au maximum, dorée possédée : 2 dorées à obtenir pour sa constellation.
    const mine = [owned(r2.id, 0, 6, 2), owned(r2.id, 1, 1, 0)];
    expect(spares(compare([r2], mine).me)).toEqual({ [cardKey(r2.id, 0)]: 3 });
    const free = compare([r2], mine, [], { keep: { me: { golden: false } } });
    expect(spares(free.me)).toEqual({ [cardKey(r2.id, 0)]: 5 });
  });

  it('garde au choix les doublons qui monteront la constellation', () => {
    const mine = [owned(r3.id, 0, 5), owned(r3.id, 1, 1, 3)];
    expect(spares(compare([r3], mine).me)).toEqual({ [cardKey(r3.id, 0)]: 1 });
    const free = compare([r3], mine, [], { keep: { me: { constellation: false } } });
    expect(spares(free.me)).toEqual({ [cardKey(r3.id, 0)]: 4 });
  });

  it('garde toujours les composants des fusions à faire', () => {
    const piece = makeItem(1139, { upgradable: false, goldable: false });
    const result = makeItem(2129, { isFusion: true, upgradable: false });
    const catalog = makeCatalog([piece, result], {
      fusions: [{ resultId: result.id, inputs: [{ itemId: piece.id, quantity: 3 }] }],
    });
    const trade = compareForTrade({
      catalog,
      me: makePlayer({ inventory: Object.fromEntries([owned(piece.id, 0, 5)]) }),
      other: makePlayer(),
      keep: { me: { golden: false, goldenFusions: false, constellation: false } },
      now: TEST_NOW,
    });
    expect(spares(trade.me)).toEqual({ [cardKey(piece.id, 0)]: 1 });
  });

  it('applique les réglages de chaque joueur séparément', () => {
    const cards = [owned(r3.id, 0, 5), owned(r3.id, 1, 1, 3)];
    const trade = compare([r3], cards, cards, { keep: { other: { constellation: false } } });
    // Chacun possède la carte : rien à s'échanger, mais les réglages sont bien ceux de chacun.
    expect(trade.me.keep.constellation).toBe(true);
    expect(trade.other.keep).toEqual({ golden: true, goldenFusions: true, constellation: false });
  });

  it('met en avant les cartes recherchées sur le marché', () => {
    const r1 = makeItem(1001, { upgradable: false, goldable: false });
    const trade = compare(
      [r1, plain, r2],
      [owned(r1.id, 0, 3), owned(plain.id, 0, 3), owned(r2.id, 1, 3, 2)],
      [],
      { market: { me: { offers: [r1.id], wants: [] }, other: { offers: [], wants: [plain.id] } } },
    );
    expect(trade.me.gives.map((c) => [c.identifier, c.shiny, c.wanted, c.offered])).toEqual([
      [1002, 0, true, false],
      [2001, 1, false, false],
      [1001, 0, false, true],
    ]);
    expect(trade.me.market).toBe(true);
  });

  it('liste aussi les cartes gardées, avec ce qu’elles coûteraient', () => {
    // KallaX : ★★ sans dorée, deux doublons gardés pour sa constellation.
    const kallax = makeItem(2225, { goldable: false });
    const single = makeItem(1003, { upgradable: false, goldable: false });
    const piece = makeItem(1139, { upgradable: false, goldable: false });
    const result = makeItem(2129, { isFusion: true, upgradable: false });
    const golden = makeItem(2003);
    const catalog = makeCatalog([kallax, single, piece, result, golden], {
      fusions: [{ resultId: result.id, inputs: [{ itemId: piece.id, quantity: 3 }] }],
    });
    const me = makePlayer({
      inventory: Object.fromEntries([
        owned(kallax.id, 0, 2),
        owned(single.id, 0, 1),
        owned(piece.id, 0, 3),
        // Constellation normale au maximum, dorée à obtenir puis à monter : 3 normales à enchanter.
        owned(golden.id, 0, 2, 2),
      ]),
    });
    const trade = compareForTrade({ catalog, me, other: makePlayer(), now: TEST_NOW });
    expect(trade.me.gives).toEqual([]);
    expect(trade.me.kept.map((c) => [c.identifier, c.keptFor, c.spare])).toEqual([
      [2003, 'enchant', 0],
      [2225, 'constellation', 0],
      [1003, 'last', 0],
      [1139, 'fusion', 0],
    ]);
    // Constellations décochées : la KallaX en trop passe dans les cartes à donner.
    const free = compareForTrade({
      catalog,
      me,
      other: makePlayer(),
      keep: { me: { constellation: false } },
      now: TEST_NOW,
    });
    expect(free.me.gives.map((c) => c.identifier)).toEqual([2225]);
  });

  it('n’existe pas en Hardcore', () => {
    expect(tradesAvailable(makeCatalog([]))).toBe(true);
    const settings = { dailyReward: 1000, weeklyReward: 1000, dailyLoreDust: 10 };
    expect(
      tradesAvailable(makeCatalog([], { settings: { ...settings, features: ['LOOT'] } })),
    ).toBe(false);
    expect(
      tradesAvailable(makeCatalog([], { settings: { ...settings, features: ['LOOT', 'TRADE'] } })),
    ).toBe(true);
  });

  it('trouve le surplus échangeable d’un vrai joueur', () => {
    const catalog = fixtureCatalog();
    const trade = compareForTrade({
      catalog,
      me: fixturePlayer(),
      other: makePlayer({ name: 'debutant' }),
      now: NOW,
    });
    expect(trade.me.gives.length).toBeGreaterThan(0);
    for (const c of trade.me.gives) {
      expect(catalog.items[c.itemId]?.tradable).toBe(true);
      expect(c.spare).toBeGreaterThan(0);
    }
    expect(trade.other.gives).toEqual([]);
  });
});

function tc(identifier: number, shiny: Shiny = 0, wanted = false): TradeCard {
  const itemId = `item-${identifier}`;
  return {
    itemId,
    identifier,
    name: `Carte ${identifier}`,
    rarity: Math.floor(identifier / 1000),
    shiny,
    count: 1,
    image: null,
    slug: '',
    key: cardKey(itemId, shiny),
    points: 1,
    spare: 1,
    wanted,
    offered: false,
  };
}

function trade(
  mine: TradeCard[],
  theirs: TradeCard[],
  kept: { mine?: TradeCard[]; theirs?: TradeCard[] } = {},
): Pick<TradeResult, 'me' | 'other'> {
  const side = (gives: TradeCard[], keptCards: TradeCard[] = []): TradeSide => ({
    player: { name: 'x', displayName: 'X', avatar: null, tradesLeft: 2 },
    keep: { golden: true, goldenFusions: true, constellation: true },
    market: false,
    gives,
    kept: keptCards,
  });
  return { me: side(mine, kept.mine), other: side(theirs, kept.theirs) };
}

const ids = (cards: TradeCard[]) => cards.map((c) => `${c.identifier}${['', '+', '*'][c.shiny]}`);

describe('proposition d’échange', () => {
  it('donne une carte de même rareté pour chaque carte demandée, recherchée d’abord', () => {
    const t = trade([tc(2001), tc(2002, 0, true), tc(1001)], [tc(2005), tc(2006)]);
    const p = proposeTrade(t, { receive: [tc(2005).key], give: [] });
    expect(ids(p.receive)).toEqual(['2005']);
    expect(ids(p.give)).toEqual(['2002']);
    expect(p.added).toEqual([tc(2002).key]);
    expect(p.unmatched).toEqual([]);
  });

  it('équilibre dans les deux sens', () => {
    const t = trade([tc(1001), tc(2001), tc(2002)], [tc(1005), tc(2005)]);
    const p = proposeTrade(t, { receive: [tc(1005).key, tc(2005).key], give: [tc(2002).key] });
    expect(ids(p.receive)).toEqual(['2005', '1005']);
    expect(ids(p.give)).toEqual(['2002', '1001']);
    expect(p.added).toEqual([tc(1001).key]);
    expect(p.unmatched).toEqual([]);
  });

  it('échange entre elles les cartes choisies des deux côtés, même de catégories différentes', () => {
    // On me demande ma KallaX, et je choisis moi-même ce que je veux en échange.
    const kallax = { ...tc(2225), points: 5 };
    const t = trade(
      [kallax, { ...tc(1054, 2), points: 130 }],
      [
        { ...tc(1005, 2), points: 130 },
        { ...tc(3005), points: 20 },
      ],
    );
    const p = proposeTrade(t, { receive: [tc(1005, 2).key], give: [kallax.key] });
    expect(ids(p.receive)).toEqual(['1005*']);
    expect(ids(p.give)).toEqual(['2225']);
    expect(p.added).toEqual([]);
    expect(p.unmatched).toEqual([]);
  });

  it('signale une carte sans contrepartie de même rareté et brillance', () => {
    const t = trade([tc(1001), tc(3001)], [tc(1005, 1), tc(3005), tc(3006)]);
    const p = proposeTrade(t, { receive: [tc(1005, 1).key, tc(3005).key, tc(3006).key], give: [] });
    expect(ids(p.give)).toEqual(['3001']);
    expect(p.unmatched).toEqual([tc(3006).key, tc(1005, 1).key]);
  });

  it('cède une carte gardée quand on la choisit, sans jamais l’ajouter d’office', () => {
    const kallax = { ...tc(2225), spare: 0, keptFor: 'constellation' as const };
    const t = trade([tc(1001)], [tc(2005, 0, true), tc(2006)], { mine: [kallax] });
    // L'autre demande la KallaX : en échange, sa meilleure carte de même rareté.
    const asked = proposeTrade(t, { receive: [], give: [kallax.key] });
    expect(ids(asked.give)).toEqual(['2225']);
    expect(ids(asked.receive)).toEqual(['2005']);
    expect(asked.unmatched).toEqual([]);
    // Je demande une de ses cartes : ma KallaX gardée n'est pas proposée en échange.
    const wanted = proposeTrade(t, { receive: [tc(2006).key], give: [] });
    expect(ids(wanted.give)).toEqual([]);
    expect(wanted.unmatched).toEqual([tc(2006).key]);
  });

  it('sans carte de même rareté et brillance, propose les plus proches en points', () => {
    const kallax = { ...tc(2225), points: 5 };
    const t = trade(
      [kallax],
      [
        { ...tc(2006, 2), points: 200 },
        { ...tc(4005), points: 80 },
        { ...tc(1005), points: 1 },
        { ...tc(3005), points: 20 },
      ],
    );
    const p = proposeTrade(t, { receive: [], give: [kallax.key] });
    expect(p.unmatched).toEqual([kallax.key]);
    const [alternative] = tradeAlternatives(t, p);
    expect(alternative?.askExact).toBe(false);
    expect(ids(alternative!.ask)).toEqual(['1005', '3005', '4005', '2006*']);
    expect(alternative?.offer).toEqual([]);
  });

  it('liste tout ce qu’on peut demander ou proposer d’autre en échange', () => {
    const kallax = { ...tc(2225), spare: 0, keptFor: 'constellation' as const };
    const t = trade([tc(1001), tc(2001)], [tc(2005, 0, true), tc(2006), tc(2007), tc(1005)], {
      mine: [kallax],
    });
    const p = proposeTrade(t, { receive: [], give: [kallax.key] });
    expect(
      tradeAlternatives(t, p).map((a) => [a.rarity, a.shiny, ids(a.ask), ids(a.offer)]),
    ).toEqual([[2, 0, ['2006', '2007'], ['2001']]]);
    expect(tradeAlternatives(t, proposeTrade(t, { receive: [], give: [] }))).toEqual([]);
  });

  it('prépare le message et la liste des cartes', () => {
    const p = proposeTrade(trade([tc(1001)], [tc(1005, 1)]), { receive: [], give: [tc(1001).key] });
    expect(ids(p.receive)).toEqual([]);
    expect(tradeMessage('bob', p)).toBe(
      "Salut bob ! Je peux te donner 1001 Carte 1001, ça t'intéresse ?",
    );
    const both = proposeTrade(trade([tc(2001), tc(2002)], [tc(2005)]), {
      receive: [tc(2005).key],
      give: [tc(2001).key],
    });
    expect(tradeMessage('bob', both)).toBe(
      'Salut bob ! Je te propose un échange : 2001 Carte 2001 contre 2005 Carte 2005. Ça te va ?',
    );
    expect(tradeCardList([tc(1001), tc(2001, 1), tc(3001, 2)])).toBe('1001 + 2001+ + 3001*');
  });
});
