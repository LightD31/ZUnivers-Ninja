import { describe, expect, it } from 'vitest';
import {
  bestTrade,
  cardKey,
  compareForTrade,
  findTradePartners,
  OWNER_CANDIDATES,
  ownerLookups,
  proposeTrade,
  rankHolders,
  TRADE_MAX_CARDS,
  tradeCandidates,
  tradeIssues,
  tradeNeeds,
  type Item,
  type ItemOwner,
  type Player,
  type TradeCandidate,
} from '../src';
import { makeCatalog, makeItem, makePlayer, owned, TEST_NOW } from './factory';

/** Cartes sans constellation ni dorée : seul le premier exemplaire sert à celui qui la reçoit. */
const simple = (identifier: number) => makeItem(identifier, { upgradable: false, goldable: false });

function compare(
  items: Item[],
  mine: ReturnType<typeof owned>[],
  theirs: ReturnType<typeof owned>[],
  fusions: Parameters<typeof makeCatalog>[1] = {},
) {
  return compareForTrade({
    catalog: makeCatalog(items, fusions),
    me: makePlayer({ name: 'alice', inventory: Object.fromEntries(mine) }),
    other: makePlayer({ name: 'bob', inventory: Object.fromEntries(theirs) }),
    now: TEST_NOW,
  });
}

describe('cartes cherchées', () => {
  // Je n'ai que des ★ et des ★★★ normales en trop à donner en face.
  const [a, b, c, d, e] = [simple(1001), simple(1002), simple(2001), simple(3001), simple(3002)];
  const catalog = makeCatalog([a, b, c, d, e]);
  const me = makePlayer({
    inventory: Object.fromEntries([owned(a.id, 0, 3), owned(d.id, 0, 2), owned(e.id, 1, 1)]),
  });

  it('liste les cartes échangeables dont j’ai l’usage, et les catégories où j’ai du surplus', () => {
    const { wants, spare } = tradeNeeds(catalog, me, {}, TEST_NOW);
    expect([...spare].sort()).toEqual(['1:0', '3:0']);
    expect(wants.find((w) => w.itemId === b.id && w.shiny === 0)).toEqual({
      itemId: b.id,
      shiny: 0,
      need: 'missing',
      gains: [1],
    });
    // Ma 3002 dorée est là, la normale manque toujours.
    expect(wants.some((w) => w.itemId === e.id && w.shiny === 1)).toBe(false);
    expect(wants.some((w) => w.itemId === e.id && w.shiny === 0)).toBe(true);
  });

  it('cherche les possesseurs des plus rentables, dans les catégories où je peux payer', () => {
    const lookups = ownerLookups(catalog, me, {}, TEST_NOW);
    expect(lookups.map((l) => [l.item.identifier, l.wants])).toEqual([
      [3002, [{ shiny: 0, points: 20 }]],
      [1002, [{ shiny: 0, points: 1 }]],
    ]);
    expect(ownerLookups(catalog, me, {}, TEST_NOW, 1)).toHaveLength(1);
  });

  it('classe les possesseurs qui ont des doubles, les plus rentables d’abord', () => {
    const lookups = ownerLookups(catalog, me, {}, TEST_NOW);
    const owner = (name: string, shiny: 0 | 1 | 2, quantity: number): ItemOwner => ({
      name,
      shiny,
      quantity,
    });
    const holders = rankHolders(lookups, [
      // Un seul exemplaire : il garde le sien. Une dorée : je cherche la normale.
      [owner('bob', 0, 4), owner('carol', 0, 1), owner('dave', 1, 9)],
      [owner('erin', 0, 30), owner('Bob', 0, 2)],
    ]);
    expect(holders).toEqual([
      { name: 'bob', holding: 2, points: 21 },
      { name: 'erin', holding: 1, points: 1 },
    ]);
  });
});

describe('joueurs à comparer', () => {
  const me = makePlayer({
    name: 'Alice',
    corporation: { id: 'c', name: 'Corpo', bonuses: {}, members: ['alice', 'Bob', 'carol'] },
  });

  it('les partenaires choisis, les possesseurs, la corporation, le marché, sans doublon', () => {
    const candidates = tradeCandidates(me, {
      names: ['dave', 'bob', ' '],
      holders: [
        { name: 'frank', holding: 3, points: 60 },
        { name: 'carol', holding: 1, points: 20 },
      ],
      market: [
        { name: 'erin', date: '2026-10-20T00:00:00' },
        { name: 'CAROL', date: '2026-10-01T00:00:00' },
        { name: 'ALICE', date: '2026-09-01T00:00:00' },
      ],
    });
    expect(candidates).toEqual<TradeCandidate[]>([
      { name: 'dave', sources: ['named'], listedAt: null, holding: 0 },
      { name: 'bob', sources: ['named', 'corporation'], listedAt: null, holding: 0 },
      { name: 'frank', sources: ['owner'], listedAt: null, holding: 3 },
      {
        name: 'carol',
        sources: ['owner', 'corporation', 'market'],
        listedAt: '2026-10-01T00:00:00',
        holding: 1,
      },
      { name: 'erin', sources: ['market'], listedAt: '2026-10-20T00:00:00', holding: 0 },
    ]);
  });

  it(`s’arrête à la limite, et à ${OWNER_CANDIDATES} possesseurs`, () => {
    const market = [{ name: 'erin', date: '2026-10-20T00:00:00' }];
    expect(tradeCandidates(me, { names: ['dave'], market }, 2).map((c) => c.name)).toEqual([
      'dave',
      'Bob',
    ]);
    const holders = Array.from({ length: 20 }, (_, i) => ({
      name: `h${i}`,
      holding: 1,
      points: 1,
    }));
    const many = tradeCandidates(makePlayer(), { holders });
    expect(many).toHaveLength(OWNER_CANDIDATES);
    expect(tradeCandidates(makePlayer(), {})).toEqual([]);
  });
});

describe('meilleur échange', () => {
  it('échange le surplus de chacun, de même rareté et brillance, le plus rentable d’abord', () => {
    const [a, b, c, d] = [simple(1001), simple(1002), simple(3001), simple(3002)];
    const trade = compare(
      [a, b, c, d],
      [owned(a.id, 0, 2), owned(c.id, 0, 2)],
      [owned(b.id, 0, 2), owned(d.id, 0, 2)],
    );
    const best = bestTrade(trade);
    expect(best.copies).toBe(2);
    expect(best.picks).toEqual({
      receive: { [cardKey(b.id, 0)]: 1, [cardKey(d.id, 0)]: 1 },
      give: { [cardKey(a.id, 0)]: 1, [cardKey(c.id, 0)]: 1 },
    });
    expect(best.points).toEqual({ receive: 21, give: 21 });
    expect(best.receive.map((card) => card.identifier)).toEqual([3002, 1002]);
    // Exactement ce que la comparaison proposerait avec ces cartes, et le jeu l'accepte.
    const proposal = proposeTrade(trade, best.picks);
    expect(proposal).toMatchObject({ added: [], unmatched: [] });
    expect(tradeIssues(proposal)).toEqual([]);
  });

  it(`n’échange pas plus de ${TRADE_MAX_CARDS} cartes, et garde les plus rares`, () => {
    const mine = Array.from({ length: 7 }, (_, i) => simple(1001 + i));
    const theirs = Array.from({ length: 7 }, (_, i) => simple(1101 + i));
    const [rareMine, rareTheirs] = [simple(3001), simple(3002)];
    const trade = compare(
      [...mine, ...theirs, rareMine, rareTheirs],
      [...mine, rareMine].map((i) => owned(i.id, 0, 2)),
      [...theirs, rareTheirs].map((i) => owned(i.id, 0, 2)),
    );
    const best = bestTrade(trade);
    expect(best.copies).toBe(TRADE_MAX_CARDS);
    expect(best.points.receive).toBe(20 + 5);
    expect(best.picks.receive[cardKey(rareTheirs.id, 0)]).toBe(1);
    expect(tradeIssues(proposeTrade(trade, best.picks))).toEqual([]);
  });

  it('prend les exemplaires d’une carte dans l’ordre, même quand un composant passe avant', () => {
    // Pour moi, la ★★ X vaut : 5 (elle me manque), 0 (composant de fusion), 10 et 10 (constellation).
    const x = makeItem(2001, { goldable: false });
    const y = simple(2002);
    const fusion = makeItem(2900, { isFusion: true, upgradable: false });
    const gifts = [simple(2011), simple(2012), simple(2013), simple(2014)];
    const items = [x, y, fusion, ...gifts];
    const fusions = { fusions: [{ resultId: fusion.id, inputs: [{ itemId: x.id, quantity: 1 }] }] };
    const theirs = [owned(x.id, 0, 8, 2), owned(fusion.id, 0, 1), owned(y.id, 0, 2)];
    const giving = (n: number) => gifts.slice(0, n).map((g) => owned(g.id, 0, 2));

    const trade = compare(items, giving(4), theirs, fusions);
    expect(trade.other.gives.find((c) => c.identifier === 2001)?.gains).toEqual([5, 0, 10, 10]);
    // Prendre une carte puis la suivante la plus rentable donnerait X, Y, X, X : 20 points.
    const best = bestTrade(trade);
    expect(best.picks.receive).toEqual({ [cardKey(x.id, 0)]: 4 });
    expect(best.points.receive).toBe(25);

    // Deux exemplaires seulement : X et Y valent mieux que deux X (le second ne rapporte rien).
    const short = bestTrade(compare(items, giving(2), theirs, fusions));
    expect(short.picks.receive).toEqual({ [cardKey(x.id, 0)]: 1, [cardKey(y.id, 0)]: 1 });
    expect(short.points.receive).toBe(10);
  });

  it('ne propose rien sans contrepartie de même rareté et brillance, ni une carte gardée', () => {
    const [a, b, c] = [simple(1001), simple(1002), simple(3001)];
    const none = bestTrade(compare([a, b, c], [owned(a.id, 0, 2)], [owned(b.id, 1, 2)]));
    expect(none).toMatchObject({ copies: 0, receive: [], give: [], points: { receive: 0 } });
    // Son dernier exemplaire de la 3001 m'intéresse, mais il le garde.
    const kept = compare([a, c], [owned(a.id, 0, 2)], [owned(c.id, 0, 1)]);
    expect(kept.other.kept).toHaveLength(1);
    expect(bestTrade(kept).copies).toBe(0);
  });
});

describe('meilleurs partenaires', () => {
  const [a, b, c, d] = [simple(1001), simple(1002), simple(3001), simple(3002)];
  const catalog = makeCatalog([a, b, c, d]);
  const me = makePlayer({
    name: 'alice',
    inventory: Object.fromEntries([owned(a.id, 0, 2), owned(c.id, 0, 2)]),
  });
  const players: Record<string, Player> = {
    bob: makePlayer({ name: 'bob', inventory: Object.fromEntries([owned(b.id, 0, 3)]) }),
    carol: makePlayer({
      name: 'carol',
      displayName: 'Carol',
      inventory: Object.fromEntries([owned(d.id, 0, 2)]),
    }),
    // A déjà tout ce que je pourrais lui donner : rien à échanger.
    dave: makePlayer({
      name: 'dave',
      inventory: Object.fromEntries([owned(a.id, 0, 1), owned(c.id, 0, 1), owned(b.id, 0, 2)]),
    }),
    erin: makePlayer({ name: 'erin', inventory: Object.fromEntries([owned(d.id, 0, 9)]) }),
  };
  const load = async ({ name }: TradeCandidate) => {
    const player = players[name];
    if (!player) throw new Error(`introuvable : ${name}`);
    return { player, market: name === 'carol' ? { offers: [], wants: [c.id] } : null };
  };
  const noOwners = async () => [];

  it('classe les joueurs selon le meilleur échange, et signale ceux qui ne se chargent pas', async () => {
    const result = await findTradePartners({
      catalog,
      me,
      names: ['bob', 'fantome', 'dave'],
      listings: [{ name: 'carol', date: '2026-10-20T00:00:00' }],
      owners: noOwners,
      load,
      now: TEST_NOW,
    });
    expect(result.partners.map((p) => p.player.name)).toEqual(['carol', 'bob']);
    expect(result).toMatchObject({ checked: 3, failed: ['fantome'], me: { name: 'alice' } });
    expect(result.partners[0]).toMatchObject({
      player: { displayName: 'Carol', tradesLeft: 2 },
      sources: ['market'],
      listedAt: '2026-10-20T00:00:00',
      points: { receive: 20, give: 20 },
      copies: 1,
      // Mes deux cartes en trop lui manquent, mais seule la ★★★ a une contrepartie chez elle.
      useful: { receive: 1, give: 2 },
    });
    // La carte qu'elle recherche sur le marché est signalée dans l'échange.
    expect(result.partners[0]!.give).toMatchObject([{ identifier: 3001, wanted: true }]);
  });

  it('trouve les plus gros possesseurs des cartes qui me manquent', async () => {
    const searched: number[] = [];
    const result = await findTradePartners({
      catalog,
      me,
      owners: async (item) => {
        searched.push(item.identifier);
        if (item.id !== d.id) return [];
        // Carol n'a qu'un exemplaire : elle le garde.
        return [
          { name: 'erin', shiny: 0, quantity: 9 },
          { name: 'carol', shiny: 0, quantity: 1 },
        ];
      },
      load,
      now: TEST_NOW,
    });
    expect(searched).toEqual([3002, 1002]);
    expect(result).toMatchObject({ searchedCards: 2, checked: 1, failed: [] });
    expect(result.partners).toMatchObject([
      { player: { name: 'erin' }, sources: ['owner'], holding: 1, points: { receive: 20 } },
    ]);
  });

  it('cherche sans les possesseurs quand leurs fiches ne répondent pas', async () => {
    const result = await findTradePartners({
      catalog,
      me,
      names: ['bob'],
      owners: async () => {
        throw new Error('fiche indisponible');
      },
      load,
      now: TEST_NOW,
    });
    expect(result.partners.map((p) => p.player.name)).toEqual(['bob']);
  });

  it('ne charge que quelques collections à la fois', async () => {
    let loading = 0;
    let most = 0;
    const result = await findTradePartners({
      catalog,
      me,
      names: Array.from({ length: 9 }, (_, i) => `bob${i}`),
      owners: noOwners,
      concurrency: 2,
      load: async () => {
        most = Math.max(most, ++loading);
        await new Promise((resolve) => setTimeout(resolve, 1));
        loading--;
        return { player: players.bob!, market: null };
      },
      now: TEST_NOW,
    });
    expect(most).toBe(2);
    expect(result.checked).toBe(9);
  });
});
