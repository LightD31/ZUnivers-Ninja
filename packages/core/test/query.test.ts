import { describe, expect, it } from 'vitest';
import {
  createPlan,
  DEFAULT_TRADE_KEEP,
  parsePlannerQuery,
  parseTradeKeep,
  plannerQuery,
  queryOptions,
  resolveOptions,
  STRATEGY_IDS,
  TRADE_KEEP_KEYS,
  tradeKeepQuery,
  type PlannerOptionsInput,
  type TradeKeep,
} from '../src';
import { fixtureCatalog, fixturePlayer, NOW } from './helpers';

/** Options d'un plan, telles qu'un lien les reproduit. */
const linked = (input: PlannerOptionsInput) => queryOptions(resolveOptions(input));

describe('paramètres du planificateur', () => {
  it('reproduisent exactement les options, quelle que soit la stratégie', () => {
    for (const strategy of STRATEGY_IDS) {
      const options = linked({
        strategy,
        beamWidth: 12,
        branching: 3,
        keepExtra: 2,
        keepForGolden: false,
        keepForGoldenFusions: false,
        horizon: true,
        horizonDiscount: 0.75,
        horizonSeasons: 2,
        allow: { recycle: false, invoke: false },
        weights: { balance: 0.0035, upgradeDust: 1.25 },
      });
      const query = plannerQuery(options);
      expect(linked(parsePlannerQuery(query))).toEqual(options);
    }
  });

  it('ne gardent que la stratégie et ce qui s’écarte de son préréglage', () => {
    expect(plannerQuery(linked({ strategy: 'epargne' }))).toEqual({ strategy: 'epargne' });
    expect(plannerQuery(linked({}))).toEqual({ strategy: 'equilibre' });
    expect(
      plannerQuery(linked({ strategy: 'vortex', keepExtra: 1, allow: { ascension: false } })),
    ).toEqual({ strategy: 'vortex', keepExtra: '1', skip: 'ascension' });
    // Les poids de la stratégie Épargne sont son préréglage : ceux par défaut s'en écartent.
    const defaults = resolveOptions({}).weights;
    expect(plannerQuery(linked({ strategy: 'epargne', weights: defaults }))).toMatchObject({
      wBalance: String(defaults.balance),
    });
  });

  it('bornent les valeurs lues, comme l’API', () => {
    expect(
      parsePlannerQuery({
        beamWidth: '999',
        horizonDiscount: '2',
        wBalance: '-1',
        wLoreDust: 'beaucoup',
        strategy: 'yolo',
      }),
    ).toEqual({ beamWidth: 64, horizonDiscount: 1, weights: { balance: 0 } });
  });
});

describe('réserve d’un échange', () => {
  it('s’écrit et se relit à l’identique', () => {
    for (let mask = 0; mask < 2 ** TRADE_KEEP_KEYS.length; mask++) {
      const keep = Object.fromEntries(
        TRADE_KEEP_KEYS.map((k, i) => [k, Boolean(mask & (1 << i))]),
      ) as unknown as TradeKeep;
      expect(parseTradeKeep(tradeKeepQuery(keep))).toEqual(keep);
    }
    expect(tradeKeepQuery(DEFAULT_TRADE_KEEP)).toBe('golden,goldenFusions,constellation');
  });
});

describe('options d’un plan', () => {
  it('sont celles avec lesquelles il a été calculé', () => {
    const plan = createPlan({
      catalog: fixtureCatalog(),
      player: fixturePlayer(),
      options: { strategy: 'vortex', beamWidth: 1, keepExtra: 1, allow: { recycle: false } },
      now: NOW,
    });
    expect(plan.options).toEqual(
      linked({ strategy: 'vortex', beamWidth: 1, keepExtra: 1, allow: { recycle: false } }),
    );
    expect(plannerQuery(plan.options)).toEqual({
      strategy: 'vortex',
      beamWidth: '1',
      keepExtra: '1',
      skip: 'recycle',
    });
  });
});
