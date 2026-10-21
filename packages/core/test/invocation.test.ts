import { describe, expect, it } from 'vitest';
import {
  ascensionEV,
  boosterOptions,
  buildContext,
  createPlan,
  invocationEV,
  nodeSteps,
  normalizePlayer,
  premiumAvailable,
  resolveOptions,
  search,
  sortInvocations,
  withDuplicateValue,
  type GameEvent,
} from '../src';
import { applyAction } from '../src/engine/actions';
import { initialState, stateValue } from '../src/engine/state';
import { PITY_CARDS } from '../src/rules/constants';
import { pityStep } from '../src/rules/random';
import { makeCatalog, makeContext, makeItem, makePlayer, owned, TEST_NOW } from './factory';
import { fixtureCatalog, fixturePlayer, NOW, rawPlayer } from './helpers';
import type { Action } from '../src/engine/actions';

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

  it('ne fait qu’une basique pour la 4 ★ garantie, sans en enchaîner un lot', () => {
    // Chromas 1 ★ manquantes : la chroma est le pack le plus rentable. La 4 ★ garantie tombe dans
    // l'invocation suivante : une basique la prend pour moitié prix. Avant, avec un gros solde, un
    // lot de quatre basiques comptait la 4 ★ garantie à chacune.
    const ones = Array.from({ length: 20 }, (_, i) => makeItem(1001 + i));
    const fours = Array.from({ length: 10 }, (_, i) => makeItem(4001 + i));
    const ctx = makeContext(
      makeCatalog([...ones, ...fours]),
      makePlayer({
        balances: { balance: 200_000, loreDust: 0, loreFragment: 0, upgradeDust: 0 },
        invokeBeforePity: 5,
        inventory: Object.fromEntries(
          ones.flatMap((i) => [owned(i.id, 0, 1, 1), owned(i.id, 1, 1, 1)]),
        ),
      }),
    );
    const invocations = nodeSteps(search(ctx).best).flatMap((s) =>
      s.action.kind === 'invoke' ? [s.action.booster] : [],
    );
    expect(invocations.slice(0, 2)).toEqual(['basic', 'chroma']);
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
  // Constellations au maximum : un doublon ne peut plus que se recycler.
  const ownedAll = (items: typeof featured) =>
    Object.fromEntries(
      items.flatMap((i) => [0, 1, 2].map((s) => owned(i.id, s as 0 | 1 | 2, 1, i.rarity))),
    );
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

describe('choix du pack', () => {
  // 300 cartes 1 ★ jamais vues : au début, chaque carte tirée est nouvelle. La classique en donne
  // 10 pour 1 000 ZUMonnaie, la chroma 10 pour 2 000 : plus de valeur par invocation pour la
  // chroma (variantes chromas), plus par ZUMonnaie pour la classique.
  const items = Array.from({ length: 300 }, (_, i) => makeItem(1001 + i));
  const catalog = makeCatalog(items);
  const player = makePlayer({
    balances: { balance: 600_000, loreDust: 0, loreFragment: 0, upgradeDust: 0 },
  });

  it('compare les packs par ZUMonnaie et dépense tout le solde', () => {
    const ctx = makeContext(catalog, player, { strategy: 'collectionneur' });
    const actions = nodeSteps(search(ctx).best).map((s) => s.action);
    const invokes = actions.flatMap((a) => (a.kind === 'invoke' ? [a.booster] : []));
    expect(invokes[0]).toBe('basic');
    // 600 invocations classiques : bien au-delà de la profondeur de recherche une par une.
    const spent = invokes.reduce(
      (sum, key) => sum + (boosterOptions(ctx).find((o) => o.key === key)!.cost.balance ?? 0),
      0,
    );
    expect(spent).toBe(600_000);
  });
});

describe('ordre des invocations', () => {
  const step = (action: Action) => ({ action, gain: 1, balanceDelta: {}, auto: false });
  const im = (booster: string) => step({ kind: 'invoke', booster });

  it('regroupe chaque suite continue d’invocations par pack, sans traverser les autres actions', () => {
    const steps = [
      im('basic'),
      im('chroma'),
      im('basic'),
      im('golden'),
      im('chroma'),
      step({ kind: 'craft', itemId: 'item-1001' }),
      im('chroma'),
      im('basic'),
      im('chroma'),
    ];
    expect(
      sortInvocations(steps).map((s) => (s.action.kind === 'invoke' ? s.action.booster : 'craft')),
    ).toEqual([
      'basic',
      'basic',
      'chroma',
      'chroma',
      'golden',
      'craft',
      'chroma',
      'chroma',
      'basic',
    ]);
  });
});

describe('valeur des doublons', () => {
  const catalog = fixtureCatalog();
  const fixture = fixturePlayer();
  const withBalances = (balances: Partial<typeof fixture.balances>) => ({
    ...fixture,
    balances: { ...fixture.balances, ...balances },
  });
  const context = (player = fixture) => buildContext(catalog, player, NOW, resolveOptions({}));

  it('compte la poudre des doublons d’invocation à ce qu’elle achète', () => {
    // Joueur réel : peu de poudre et des constellations à monter. Une poudre de plus en rapporte
    // bien plus que son poids.
    const ctx = context();
    expect(withDuplicateValue(ctx).duplicateWeights!.loreDust).toBeGreaterThan(
      10 * ctx.options.weights.loreDust,
    );
    // Poudre en abondance : plus rien à acheter avec, elle ne vaut que son poids.
    const rich = context(withBalances({ loreDust: 10_000_000 }));
    expect(withDuplicateValue(rich).duplicateWeights!.loreDust).toBe(rich.options.weights.loreDust);
  });

  it('préfère les packs qui donnent le plus de cartes à recycler', () => {
    // Avant, la chroma passait devant : plus de cartes nouvelles par ZUMonnaie, mais deux fois moins
    // de cartes, donc de doublons à recycler en poudre, que les packs à 1 000.
    const plan = createPlan({ catalog, player: withBalances({ balance: 20_000 }), now: NOW });
    const invocations = plan.groups.filter((g) => g.kind === 'invoke').map((g) => g.command);
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations).not.toContain('/im évènement:chroma');
  });

  it('dit de relancer le plan après les invocations, et seulement quand il en a', () => {
    // Les doublons tirés ne peuvent servir qu'au plan suivant.
    const rerun = (strategy: 'equilibre' | 'prudent') =>
      createPlan({
        catalog,
        player: withBalances({ balance: 20_000 }),
        now: NOW,
        options: { strategy },
      }).advice.some((a) => a.startsWith('Après tes invocations, relance le plan'));
    expect(rerun('equilibre')).toBe(true);
    // Prudent : aucune invocation.
    expect(rerun('prudent')).toBe(false);
  });

  it('garde les doublons d’ascension au poids de la poudre', () => {
    // L'ascension se paie en poudre comptée à son poids : ses doublons aussi, sinon elle semblait
    // rendre plus de poudre qu'elle n'en coûte.
    const ctx = context();
    const state = initialState(ctx);
    expect(ascensionEV(withDuplicateValue(ctx), state).ev).toBe(ascensionEV(ctx, state).ev);
  });
});

describe('doublons qui montent une constellation', () => {
  // 20 cartes 1 ★, normales et dorées possédées : un niveau de constellation chacune (dorée :
  // 2 × 60 points), ouvert ou déjà monté.
  const items = Array.from({ length: 20 }, (_, i) => makeItem(1001 + i));
  const catalog = makeCatalog(items);
  const context = (constellation: number, copies = 1) =>
    makeContext(
      catalog,
      makePlayer({
        balances: { balance: 100_000, loreDust: 0, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries(
          items.flatMap((i) => [
            owned(i.id, 0, copies, constellation),
            owned(i.id, 1, copies, constellation),
          ]),
        ),
      }),
    );
  const golden: Action = { kind: 'invoke', booster: 'golden' };
  const ev = (ctx: ReturnType<typeof context>, actions: Action[]) => {
    let state = initialState(ctx);
    for (const action of actions) state = applyAction(ctx, state, action)!.state;
    return state.ev;
  };

  it('compte le niveau qu’un doublon monte au lieu de son recyclage', () => {
    // Une dorée tirée sur dix est une dorée 1 ★ : presque une sur vingt monte un niveau de 120.
    expect(ev(context(0), [golden])).toBeGreaterThan(ev(context(1), [golden]) + 100);
  });

  it('ne monte pas plus de niveaux qu’il n’en reste', () => {
    // 50 dorées tirent chaque dorée 1 ★ 2,4 fois en moyenne : 91 % des niveaux montés, jamais plus.
    const many = Array<Action>(50).fill(golden);
    const levels = ev(context(0), many) - ev(context(1), many);
    const all = 20 * (2 * 60) + 20 * (2 * 1);
    expect(levels).toBeLessThan(all);
    expect(levels).toBeGreaterThan(0.85 * 20 * (2 * 60 - 1));
  });

  it('ne fait pas forger une carte que les invocations donneront de toute façon', () => {
    // Dorées non possédées, tirées 2,4 fois chacune en moyenne par 50 dorées : la première donne
    // la carte, les suivantes montent son niveau. L'enchanter après ne rapporte que les tirages
    // où elle ne serait pas venue (9 %) ou pas deux fois (22 %), pas le niveau que ses doublons
    // monteront de toute façon (avant : ~110 points sur 120).
    const ctx = makeContext(
      catalog,
      makePlayer({
        balances: { balance: 100_000, loreDust: 10_000, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries(items.map((i) => owned(i.id, 0, 2))),
      }),
    );
    const many = Array<Action>(50).fill(golden);
    const enchant: Action = { kind: 'enchant', itemId: items[0]!.id };
    const value = (actions: Action[]) => {
      let state = initialState(ctx);
      for (const action of actions) state = applyAction(ctx, state, action)!.state;
      return stateValue(ctx, state);
    };
    const marginal = value([...many, enchant]) - value(many);
    expect(marginal).toBeGreaterThan(0);
    expect(marginal).toBeLessThan(0.09 * 60 + 0.22 * 120 + 5);
  });

  it('ne compte pas deux fois un niveau monté après les invocations', () => {
    // Le niveau monté à coup sûr ne peut plus l'être par un doublon tiré : l'ordre ne change rien.
    const ctx = context(0, 3);
    const constellation: Action = { kind: 'constellation', itemId: items[0]!.id, shiny: 1 };
    const invocations = Array<Action>(10).fill(golden);
    const gain = (actions: Action[]) => {
      let state = initialState(ctx);
      for (const action of actions) state = applyAction(ctx, state, action)!.state;
      return stateValue(ctx, state);
    };
    expect(gain([...invocations, constellation])).toBeCloseTo(
      gain([constellation, ...invocations]),
      6,
    );
  });
});

describe('cartes obtenues après des invocations', () => {
  it('ne compte pas deux fois une carte que les invocations donnaient déjà', () => {
    // Avant, une carte créée après des invocations rapportait aussi la part de l'espérance qui la
    // comptait comme nouvelle : invoquer avant de créer paraissait plus rentable.
    const items = Array.from({ length: 50 }, (_, i) => makeItem(1001 + i));
    const ctx = makeContext(
      makeCatalog(items),
      makePlayer({
        balances: { balance: 20_000, loreDust: 1000, loreFragment: 0, upgradeDust: 0 },
      }),
    );
    const gain = (actions: Action[]) => {
      let state = initialState(ctx);
      for (const action of actions) state = applyAction(ctx, state, action)!.state;
      return stateValue(ctx, state) - stateValue(ctx, initialState(ctx));
    };
    const invocations: Action[] = Array(10).fill({ kind: 'invoke', booster: 'basic' });
    const craft: Action = { kind: 'craft', itemId: items[0]!.id };
    expect(gain([...invocations, craft])).toBeCloseTo(gain([craft, ...invocations]), 6);
  });
});

describe('bonus des cartes nouvelles', () => {
  it('ne compte pas comme nouvelle une carte retirée de la collection pendant le plan', () => {
    // Enchanter le dernier exemplaire normal retire la carte : les invocations peuvent la redonner
    // (ses points comptent), mais ce n'est pas une carte jamais possédée.
    const items = Array.from({ length: 50 }, (_, i) => makeItem(1001 + i));
    const card = items[0]!;
    const ctx = makeContext(
      makeCatalog(items),
      makePlayer({
        balances: { balance: 0, loreDust: 1000, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries([owned(card.id, 0, 1)]),
      }),
      { strategy: 'collectionneur' },
    );
    const basic = boosterOptions(ctx).find((o) => o.key === 'basic')!;
    const before = initialState(ctx);
    const after = applyAction(ctx, before, { kind: 'enchant', itemId: card.id })!.state;
    expect(after.owned).toBe(before.owned);
    // La dorée obtenue n'est plus à tirer ; la normale perdue ne redevient pas « nouvelle ».
    expect(invocationEV(ctx, after, basic).newCards).toBeLessThan(
      invocationEV(ctx, before, basic).newCards,
    );
    expect(invocationEV(ctx, after, basic).ev).toBeGreaterThan(0);
  });
});

describe('invocations gratuites', () => {
  const classic = Array.from({ length: 20 }, (_, i) => makeItem(1001 + i));
  const events = Array.from({ length: 20 }, (_, i) =>
    makeItem(1101 + i, { packId: 'pack-zlan', packName: 'ZLAN', isClassic: false }),
  );
  const catalog = makeCatalog([...classic, ...events]);
  const free = (name: string, overrides = {}) => ({
    name,
    count: 2,
    cards: 5,
    packId: null,
    inverse: false,
    golden: false,
    ...overrides,
  });

  it('fait les bons du profil d’office, même en stratégie Prudent', () => {
    const player = makePlayer({ freeInvocations: [free('classique5dorée', { golden: true })] });
    for (const strategy of ['equilibre', 'prudent'] as const) {
      const plan = createPlan({ catalog, player, now: TEST_NOW, options: { strategy } });
      expect(plan.commands).toEqual([
        '/im évènement:classique5dorée',
        '/im évènement:classique5dorée',
      ]);
      expect(plan.steps.every((s) => s.auto)).toBe(true);
    }
    const skipped = createPlan({
      catalog,
      player,
      now: TEST_NOW,
      options: { allow: { invoke: false } },
    });
    expect(skipped.commands).toEqual([]);
  });

  it('tire les bons « …dorée » en dorées, et les bons inversés hors du Classique', () => {
    const player = makePlayer({
      freeInvocations: [
        free('classique5'),
        free('classique5dorée', { golden: true }),
        free('pack10', { inverse: true }),
      ],
    });
    const ctx = makeContext(catalog, player);
    const state = initialState(ctx);
    const option = (key: string) => boosterOptions(ctx).find((o) => o.key === key)!;
    const golden = invocationEV(ctx, state, option('free:classique5dorée'));
    expect(Object.keys(golden.expectedNew).every((k) => k.endsWith('|1'))).toBe(true);
    // Une dorée ★ vaut 60 points, une normale 1 : le bon doré vaut bien plus que le bon basique.
    expect(golden.ev).toBeGreaterThan(5 * invocationEV(ctx, state, option('free:classique5')).ev);
    const inverse = invocationEV(ctx, state, option('free:pack10'));
    expect(Object.keys(inverse.expectedNew).every((k) => k.startsWith('classic!|'))).toBe(true);
    expect(option('free:pack10').chroma).toBe(false);
  });
});

describe('invocation premium des abonnés', () => {
  const subscription = (premiumDates: string[] | null) => ({
    subscription: { begin: '2026-10-02T00:11:33', end: '2026-11-01T00:11:33', premiumDates },
  });
  // TEST_NOW : 11/10 à 14 h, heure française.
  it('suit les trois invocations de l’abonnement et les 10 jours d’attente', () => {
    expect(premiumAvailable(subscription([]), TEST_NOW)).toBe(true);
    expect(premiumAvailable(subscription(['2026-10-02T09:00:00']), TEST_NOW)).toBe(false);
    expect(premiumAvailable(subscription(['2026-10-01T13:59:00']), TEST_NOW)).toBe(true);
    const three = ['2026-09-10T00:00:00', '2026-09-20T00:00:00', '2026-09-30T00:00:00'];
    expect(premiumAvailable(subscription(three), TEST_NOW)).toBe(false);
    // Historique inconnu ou abonnement terminé : rien n'est conseillé.
    expect(premiumAvailable(subscription(null), TEST_NOW)).toBe(false);
    expect(premiumAvailable(subscription([]), new Date('2026-11-02T12:00:00Z'))).toBe(false);
    expect(premiumAvailable({ subscription: null }, TEST_NOW)).toBe(false);
  });

  it("propose l'invocation premium, tirée dans les packs d'évènement", () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      makeItem(1101 + i, { packId: 'pack-zlan', packName: 'ZLAN', isClassic: false }),
    );
    const plan = createPlan({
      catalog: makeCatalog([makeItem(1001), ...events]),
      player: makePlayer({ subscribed: true, ...subscription([]) }),
      now: TEST_NOW,
    });
    expect(plan.commands).toEqual(['/im évènement:premium']);
  });

  it('dit quand revient la prochaine, et rappelle le Lucky Rayou du jour', () => {
    const plan = createPlan({
      catalog: makeCatalog([makeItem(1001)]),
      player: makePlayer({
        subscribed: true,
        ...subscription(['2026-10-03T10:34:12']),
        loot: [{ date: '2026-10-10', daily: 1, weekly: 1 }],
      }),
      now: TEST_NOW,
    });
    expect(plan.commands[0]).toBe('/journa');
    expect(plan.commands).not.toContain('/im évènement:premium');
    expect(plan.steps[0]!.detail).toMatch(/Lucky Rayou.*\/ticketlien/);
    expect(plan.advice).toContain(
      'Prochaine /im premium de ton abonnement disponible le 13/10/2026 à 10:34.',
    );
  });

  it('signale le premier mois offert à qui n’a jamais fait d’/im premium', () => {
    const advice = (everPremium: boolean | null) =>
      createPlan({
        catalog: makeCatalog([makeItem(1001)]),
        player: makePlayer({ everPremium }),
        now: TEST_NOW,
      }).advice.some((a) => a.includes("ton premier mois d'abonnement est offert"));
    expect(advice(false)).toBe(true);
    expect(advice(true)).toBe(false);
    expect(advice(null)).toBe(false);
  });
});
