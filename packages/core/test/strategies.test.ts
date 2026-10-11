import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTIONS,
  STRATEGIES,
  STRATEGY_IDS,
  buildContext,
  createPlan,
  nodeSteps,
  replay,
  resolveOptions,
  search,
  type PlanResult,
  type StrategyId,
} from '../src';
import { makeCatalog, makeItem, makePlayer, TEST_NOW } from './factory';
import { fixtureCatalog, fixturePlayer, NOW } from './helpers';

describe('résolution des options', () => {
  it('applique le préréglage de la stratégie', () => {
    const options = resolveOptions({ strategy: 'echangeur' });
    expect(options.strategy).toBe('echangeur');
    expect(options.keepExtra).toBe(2);
    expect(options.weights).toEqual(DEFAULT_OPTIONS.weights);
  });

  it('complète les poids partiels du préréglage avec ceux par défaut', () => {
    const options = resolveOptions({ strategy: 'vortex' });
    expect(options.weights.loreDust).toBe(0.005);
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

  it('Prudent fait moins d’actions aléatoires', () => {
    const random = (p: PlanResult) => count(p, 'invoke') + count(p, 'ascension');
    expect(random(plans.prudent)).toBeLessThan(random(equilibre));
  });

  it('Épargne garde plus de poudre', () => {
    expect(plans.epargne.after.balances.loreDust).toBeGreaterThan(
      equilibre.after.balances.loreDust,
    );
  });

  it('Vortex tente plus d’ascensions', () => {
    expect(count(plans.vortex, 'ascension')).toBeGreaterThan(count(equilibre, 'ascension'));
  });

  it('Collectionneur obtient plus de cartes différentes', () => {
    expect(unique(plans.collectionneur)).toBeGreaterThan(unique(equilibre));
  });

  it('Échangeur recycle moins', () => {
    expect(recycled(plans.echangeur)).toBeLessThan(recycled(equilibre));
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
  it("n'invoque pas quand les tirages ne comptent pas", () => {
    const items = Array.from({ length: 50 }, (_, i) => makeItem(1001 + i));
    const input = {
      catalog: makeCatalog(items),
      player: makePlayer({
        balances: { balance: 2000, loreDust: 0, loreFragment: 0, upgradeDust: 0 },
      }),
      now: TEST_NOW,
    };
    expect(createPlan(input).commands.some((c) => c.startsWith('/im'))).toBe(true);
    const cautious = createPlan({ ...input, options: { strategy: 'prudent', evFactor: 0 } });
    expect(cautious.commands.some((c) => c.startsWith('/im'))).toBe(false);
  });
});
