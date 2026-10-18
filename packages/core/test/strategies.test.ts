import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTIONS,
  STRATEGIES,
  STRATEGY_IDS,
  buildContext,
  cardKey,
  createPlan,
  nodeSteps,
  replay,
  resolveOptions,
  search,
  type PlanResult,
  type StrategyId,
} from '../src';
import { makeCatalog, makeItem, makePlayer, owned, TEST_NOW } from './factory';
import { fixtureCatalog, fixturePlayer, NOW } from './helpers';

describe('résolution des options', () => {
  it('applique le préréglage de la stratégie', () => {
    const options = resolveOptions({ strategy: 'collectionneur' });
    expect(options.strategy).toBe('collectionneur');
    expect(options.newCardBonus).toBe(1000);
    expect(options.weights).toEqual(DEFAULT_OPTIONS.weights);
  });

  it('complète les poids partiels du préréglage avec ceux par défaut', () => {
    const options = resolveOptions({ strategy: 'vortex' });
    expect(options.weights.loreDust).toBe(STRATEGIES.vortex.options.weights!.loreDust);
    expect(options.weights.balance).toBe(DEFAULT_OPTIONS.weights.balance);
    expect(options.reputationWeight).toBeGreaterThan(DEFAULT_OPTIONS.reputationWeight);
  });

  it('donne la priorité aux options explicites', () => {
    const options = resolveOptions({
      strategy: 'epargne',
      keepExtra: 1,
      weights: { balance: 0.001 },
    });
    expect(options.keepExtra).toBe(1);
    expect(options.weights.balance).toBe(0.001);
    expect(options.weights.loreDust).toBe(STRATEGIES.epargne.options.weights!.loreDust);
  });

  it('revient à la stratégie par défaut quand elle est inconnue', () => {
    const options = resolveOptions({ strategy: 'inconnue' as StrategyId });
    expect(options.strategy).toBe('equilibre');
    expect(options.evFactor).toBe(1);
    expect(options.newCardBonus).toBe(0);
  });

  it('borne evFactor et newCardBonus', () => {
    expect(resolveOptions({ evFactor: 3 }).evFactor).toBe(1);
    expect(resolveOptions({ evFactor: -1 }).evFactor).toBe(0);
    expect(resolveOptions({ newCardBonus: -5 }).newCardBonus).toBe(0);
  });
});

describe('stratégies sur un joueur réel (fixtures)', () => {
  const catalog = fixtureCatalog();
  const player = fixturePlayer();
  const plans = Object.fromEntries(
    STRATEGY_IDS.map((strategy) => [
      strategy,
      createPlan({ catalog, player, now: NOW, options: { strategy } }),
    ]),
  ) as Record<StrategyId, PlanResult>;
  const count = (plan: PlanResult, kind: string) =>
    plan.steps.filter((s) => s.kind === kind).length;
  const recycled = (plan: PlanResult) =>
    plan.steps
      .filter((s) => s.kind === 'recycle')
      .reduce((sum, s) => sum + s.cards.reduce((n, c) => n + c.count, 0), 0);
  const unique = (plan: PlanResult) => plan.after.unique.reduce((a, b) => a + b, 0);
  const equilibre = plans.equilibre;

  it('indique la stratégie utilisée et ne laisse aucune monnaie négative', () => {
    for (const id of STRATEGY_IDS) {
      expect(plans[id].strategy).toEqual({ id, label: STRATEGIES[id].label });
      for (const v of Object.values(plans[id].after.balances)) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('Prudent ne fait aucun tirage', () => {
    const draws = (p: PlanResult) => count(p, 'invoke') + count(p, 'ascension');
    expect(draws(equilibre)).toBeGreaterThan(0);
    expect(draws(plans.prudent)).toBe(0);
  });

  it('Épargne garde plus de poudre, sans dépenser plus de ZUMonnaie', () => {
    // Régression : les invocations convertissaient la ZUMonnaie en poudre (doublons recyclés).
    expect(plans.epargne.after.balances.loreDust).toBeGreaterThan(
      equilibre.after.balances.loreDust,
    );
    expect(plans.epargne.after.balances.balance).toBeGreaterThanOrEqual(
      equilibre.after.balances.balance,
    );
    expect(count(plans.epargne, 'invoke')).toBeLessThanOrEqual(count(equilibre, 'invoke'));
  });

  it('Vortex tente plus d’ascensions quand la poudre manque', () => {
    // Avec la poudre du joueur (et celle de ses recyclages), Équilibré fait déjà toutes ses
    // ascensions : on la limite pour qu'elles soient en concurrence avec les créations et
    // enchantements.
    const poor = { ...player, balances: { ...player.balances, loreDust: 500 } };
    const ascensions = (strategy: StrategyId) =>
      count(
        createPlan({
          catalog,
          player: poor,
          now: NOW,
          options: { strategy, allow: { recycle: false } },
        }),
        'ascension',
      );
    expect(ascensions('vortex')).toBeGreaterThan(ascensions('equilibre'));
  }, 30_000);

  it('Collectionneur obtient plus de cartes différentes', () => {
    expect(unique(plans.collectionneur)).toBeGreaterThan(unique(equilibre));
  });

  it('Collectionneur ne retire aucune carte de la collection', () => {
    // L'évolution remplace sa carte par la suivante, sans en retirer une de la collection.
    const evolution = new Set(player.evolution?.steps.map((s) => s.itemId) ?? []);
    const lost = (strategy: StrategyId) => {
      const ctx = buildContext(catalog, player, NOW, resolveOptions({ strategy }));
      const final = replay(
        ctx,
        nodeSteps(search(ctx).best).map((s) => s.action),
      );
      return Object.values(player.inventory).filter(
        (c) =>
          c.copies > 0 &&
          catalog.items[c.itemId] &&
          !evolution.has(c.itemId) &&
          (final.cards.get(cardKey(c.itemId, c.shiny))?.copies ?? 0) === 0,
      ).length;
    };
    expect(lost('collectionneur')).toBe(0);
  }, 60_000);

  it("recycle moins en gardant des doublons pour l'échange", () => {
    const trader = createPlan({ catalog, player, now: NOW, options: { keepExtra: 2 } });
    expect(recycled(trader)).toBeLessThan(recycled(equilibre));
  });

  it('tient à jour le nombre de cartes possédées', () => {
    const ctx = buildContext(catalog, player, NOW, resolveOptions({ strategy: 'collectionneur' }));
    const final = replay(
      ctx,
      nodeSteps(search(ctx).best).map((s) => s.action),
    );
    let owned = 0;
    for (const card of final.cards.entries().values())
      if (card.copies > 0 && catalog.items[card.itemId]) owned++;
    expect(final.owned).toBe(owned);
  });
});

describe('stratégies sur des cas synthétiques', () => {
  it('Prudent préfère un enchantement garanti à une invocation plus rentable en espérance', () => {
    // 500 poudres : soit l'invocation d'évènement (20 cartes, ~87 points espérés), soit
    // l'enchantement d'une carte (+59 points garantis).
    const pool = Array.from({ length: 50 }, (_, i) => makeItem(1001 + i));
    const owned1 = makeItem(1100, { recyclable: false, upgradable: false });
    const input = {
      catalog: makeCatalog([...pool, owned1], {
        events: [
          {
            id: 'event',
            name: 'Évènement',
            packId: null,
            packSlug: 'classique',
            packName: null,
            balanceCost: 0,
            loreDustCost: 500,
            oneTime: true,
            active: true,
            invokeCount: 20,
            begin: '2026-10-01T00:00:00',
            end: '2026-10-31T23:59:59',
            itemIds: [],
          },
        ],
      }),
      player: makePlayer({
        balances: { balance: 0, loreDust: 500, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries([owned(owned1.id, 0, 1)]),
      }),
      now: TEST_NOW,
    };
    const invokes = (strategy: StrategyId) =>
      createPlan({ ...input, options: { strategy } }).steps.some((s) => s.kind === 'invoke');
    expect(invokes('equilibre')).toBe(true);
    expect(invokes('prudent')).toBe(false);
  });

  it("Prudent n'invoque pas, même quand l'invocation est rentable", () => {
    const items = Array.from({ length: 50 }, (_, i) => makeItem(1001 + i));
    const input = {
      catalog: makeCatalog(items),
      player: makePlayer({
        balances: { balance: 2000, loreDust: 0, loreFragment: 0, upgradeDust: 0 },
      }),
      now: TEST_NOW,
    };
    expect(createPlan(input).commands.some((c) => c.startsWith('/im'))).toBe(true);
    const cautious = createPlan({ ...input, options: { strategy: 'prudent' } });
    expect(cautious.commands.some((c) => c.startsWith('/im'))).toBe(false);
  });
});
