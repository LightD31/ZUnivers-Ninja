import { describe, expect, it } from 'vitest';
import { boosterOptions, invocationEV, normalizePlayer, type GameEvent } from '../src';
import { initialState } from '../src/engine/state';
import { PITY_CARDS } from '../src/rules/constants';
import { pityStep } from '../src/rules/random';
import { makeCatalog, makeContext, makeItem, makePlayer, owned } from './factory';
import { rawPlayer } from './helpers';

const at = (d: number) => {
  const dist = new Float64Array(PITY_CARDS + 1);
  dist[d] = 1;
  return dist;
};

describe('bienveillance', () => {
  it('garantit la 4 ★ quand le compteur arrive au bout, puis repart à 210', () => {
    expect(pityStep(at(1), 1, 0.01)).toMatchObject({ triggers: 1 });
    expect(pityStep(at(1), 1, 0.01).next[PITY_CARDS]).toBe(1);

    // Garantie sur la 5ᵉ carte, puis 5 cartes de plus : 205 restantes.
    const { next, triggers } = pityStep(at(5), 10, 0);
    expect(triggers).toBe(1);
    expect(next[205]).toBe(1);
  });

  it('ne déclenche rien loin du seuil et garde une distribution de probabilité', () => {
    const { next, triggers } = pityStep(at(160), 10, 0.01);
    expect(triggers).toBe(0);
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // Aucune 4 ★ sur 10 cartes : 150 restantes. Sinon le compteur est reparti de 210 en route.
    expect(next[150]).toBeCloseTo(0.99 ** 10, 9);
    expect(next.slice(201).reduce((a, b) => a + b, 0)).toBeCloseTo(1 - 0.99 ** 10, 9);
  });

  it('augmente la valeur d’une invocation quand la garantie est proche', () => {
    const items = [...Array.from({ length: 20 }, (_, i) => makeItem(1001 + i)), makeItem(4001)];
    const catalog = makeCatalog(items);
    const ev = (invokeBeforePity: number | null) => {
      const ctx = makeContext(catalog, makePlayer({ invokeBeforePity }));
      const basic = boosterOptions(ctx).find((o) => o.key === 'basic')!;
      return invocationEV(ctx, initialState(ctx), basic).ev;
    };
    expect(ev(5)).toBeGreaterThan(ev(null) + 50);
    expect(ev(160)).toBeCloseTo(ev(null));
  });

  it('lit le compteur dans le résumé du joueur', () => {
    expect(
      normalizePlayer({ ...rawPlayer(), overview: { invokeBeforePity: 160 } }).invokeBeforePity,
    ).toBe(160);
    expect(normalizePlayer(rawPlayer()).invokeBeforePity).toBeNull();
  });
});

describe('cartes mises en avant par un évènement', () => {
  const featured = [makeItem(4001), makeItem(4002)];
  const others = Array.from({ length: 8 }, (_, i) => makeItem(4003 + i));
  const event: GameEvent = {
    id: 'zerator',
    name: 'zerator',
    packId: null,
    packSlug: 'classique',
    packName: 'Classique',
    balanceCost: 1000,
    loreDustCost: 0,
    oneTime: false,
    active: true,
    invokeCount: 10,
    begin: '2026-10-01T00:00:00',
    end: '2026-10-31T23:59:59',
    itemIds: featured.map((i) => i.id),
  };
  const catalog = makeCatalog([...featured, ...others], { events: [event] });
  const ownedAll = (items: typeof featured) =>
    Object.fromEntries(items.flatMap((i) => [0, 1, 2].map((s) => owned(i.id, s as 0 | 1 | 2, 1))));
  const evs = (inventory: ReturnType<typeof ownedAll>) => {
    const ctx = makeContext(catalog, makePlayer({ inventory }));
    const state = initialState(ctx);
    const options = boosterOptions(ctx);
    const value = (key: string) =>
      invocationEV(
        ctx,
        state,
        options.find((o) => o.key === key)!,
      ).ev;
    return { basic: value('basic'), event: value('event:zerator') };
  };

  it('ne tire ses 4 ★ que parmi les cartes mises en avant', () => {
    // Cartes mises en avant déjà possédées : l'évènement ne peut plus rien apporter en 4 ★.
    const allFeaturedOwned = evs(ownedAll(featured));
    expect(allFeaturedOwned.event).toBeLessThan(allFeaturedOwned.basic);
    // Seules les cartes mises en avant manquent : l'évènement les donne à coup sûr en 4 ★.
    const onlyFeaturedMissing = evs(ownedAll(others));
    expect(onlyFeaturedMissing.event).toBeGreaterThan(onlyFeaturedMissing.basic);
  });
});
