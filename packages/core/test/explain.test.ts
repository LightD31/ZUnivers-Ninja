import { describe, expect, it } from 'vitest';
import {
  cardKey,
  compareForTrade,
  explainTrade,
  type Item,
  type TradeCard,
  type TradeResult,
} from '../src';
import { makeCatalog, makeItem, makePlayer, owned, TEST_NOW } from './factory';

const simple = (identifier: number, overrides: Partial<Item> = {}) =>
  makeItem(identifier, { upgradable: false, goldable: false, ...overrides });

function compare(
  items: Item[],
  alice: ReturnType<typeof owned>[],
  bob: ReturnType<typeof owned>[],
  fusions: Parameters<typeof makeCatalog>[1] = {},
) {
  return compareForTrade({
    catalog: makeCatalog(items, fusions),
    me: makePlayer({ name: 'alice', displayName: 'Alice', inventory: Object.fromEntries(alice) }),
    other: makePlayer({ name: 'bob', displayName: 'Bob', inventory: Object.fromEntries(bob) }),
    now: TEST_NOW,
  });
}

const find = (trade: TradeResult, side: 'me' | 'other', identifier: number): TradeCard => {
  const s = trade[side];
  const card = [...s.gives, ...s.kept, ...s.extra].find((c) => c.identifier === identifier);
  if (!card) throw new Error(`carte ${identifier} introuvable`);
  return card;
};

describe('échange expliqué aux deux joueurs', () => {
  it('dit ce que chaque carte apporte à l’un et coûte à l’autre, sans préférer personne', () => {
    const [a, b] = [simple(2001), simple(2002)];
    const trade = compare([a, b], [owned(a.id, 0, 3)], [owned(b.id, 0, 2)]);
    const shared = explainTrade(trade, [{ [cardKey(a.id, 0)]: 1 }, { [cardKey(b.id, 0)]: 1 }]);
    for (const [i, side] of shared.sides.entries()) {
      expect(side).toMatchObject({ gain: 5, loss: 0, indirect: 0 });
      expect(side.gives[0]).toMatchObject({
        receiver: { parts: [{ kind: 'missing', copies: 1, points: 5 }], points: 5 },
        giver: { parts: [{ kind: 'spare', copies: 1, points: 0 }], points: 0 },
      });
      expect(side.player.name).toBe(i === 0 ? 'alice' : 'bob');
    }
    expect(shared.issues).toEqual([]);
    expect(shared.categories).toMatchObject([{ rarity: 2, shiny: 0, gives: [[{}], [{}]] }]);
    // Chacun peut lancer l'échange : la même commande, vue de son côté.
    expect(shared.commands).toEqual([
      '/échange joueur:@bob cartes-données:2001 cartes-prises:2002',
      '/échange joueur:@alice cartes-données:2002 cartes-prises:2001',
    ]);
  });

  it('compte une carte gardée : son niveau de constellation, puis son dernier exemplaire', () => {
    // KallaX ★★ : alice en a 2 et garde le second pour sa constellation ; bob n'en a aucune.
    const kallax = makeItem(2225, { goldable: false });
    const plain = simple(2001);
    const trade = compare([kallax, plain], [owned(kallax.id, 0, 2)], [owned(plain.id, 0, 3)]);
    expect(find(trade, 'me', 2225).held).toEqual([
      { kind: 'constellation', copies: 1, points: 10 },
      { kind: 'last', copies: 1, points: 5 },
    ]);
    const shared = explainTrade(trade, [
      { [cardKey(kallax.id, 0)]: 2 },
      { [cardKey(plain.id, 0)]: 2 },
    ]);
    const [worth] = shared.sides[0].gives;
    expect(worth!.giver).toMatchObject({
      parts: [
        { kind: 'constellation', copies: 1, points: 10 },
        { kind: 'last', copies: 1, points: 5 },
      ],
      points: 15,
    });
    expect(worth!.receiver).toMatchObject({
      parts: [
        { kind: 'missing', copies: 1, points: 5 },
        { kind: 'constellation', copies: 1, points: 10 },
      ],
      points: 15,
    });
    expect(shared.sides[0]).toMatchObject({ loss: 15, gain: 5 });
    // Le second exemplaire de la 2001 ne sert pas à alice : rien de gagné, rien de perdu pour bob.
    expect(shared.sides[1].gives[0]!.receiver.parts).toEqual([
      { kind: 'missing', copies: 1, points: 5 },
      { kind: 'none', copies: 1, points: 0 },
    ]);
  });

  it('nomme les fusions qu’une carte sert, pour chacun', () => {
    const piece = simple(1139);
    const puzzle = simple(2129, { isFusion: true, name: 'Puzzle' });
    const other = simple(1001);
    const fusions = {
      fusions: [{ resultId: puzzle.id, inputs: [{ itemId: piece.id, quantity: 1 }] }],
    };
    const trade = compare(
      [piece, puzzle, other],
      [owned(piece.id, 0, 3)],
      [owned(other.id, 0, 2)],
      fusions,
    );
    const card = find(trade, 'me', 1139);
    // Alice garde un composant pour son Puzzle ; bob en veut un pour le sien, après la carte.
    expect(card.fusions).toEqual({ receiver: ['Puzzle'], giver: ['Puzzle'] });
    const shared = explainTrade(trade, [{ [card.key]: 1 }, { [cardKey(other.id, 0)]: 1 }]);
    expect(shared.sides[0].gives[0]!.receiver.fusions).toEqual(['Puzzle']);
  });

  it('n’ajoute rien pour équilibrer : le jeu refuserait, c’est dit', () => {
    const [a, b] = [simple(2001), simple(3001)];
    const trade = compare([a, b], [owned(a.id, 0, 2)], [owned(b.id, 0, 2)]);
    const shared = explainTrade(trade, [{ [cardKey(a.id, 0)]: 1 }, { [cardKey(b.id, 0)]: 1 }]);
    expect(shared.issues).toEqual([{ kind: 'unmatched', cards: 2 }]);
    expect(shared.sides.map((s) => s.gives.length)).toEqual([1, 1]);
    expect(shared.categories.map((c) => [c.rarity, c.gives[0].length, c.gives[1].length])).toEqual([
      [3, 0, 1],
      [2, 1, 0],
    ]);
  });
});
