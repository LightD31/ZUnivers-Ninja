import { describe, expect, it } from 'vitest';
import {
  createPlan,
  curveValue,
  reserveLabel,
  resolveOptions,
  withHorizon,
  type GameEvent,
  type Item,
  type Season,
  type TowerInfo,
} from '../src';
import { holdCurve } from '../src/engine/hold';
import { makeCatalog, makeContext, makeItem, makePlayer, owned, TEST_NOW } from './factory';
import { fixtureCatalog, fixturePlayer, NOW } from './helpers';

const TOWERS: TowerInfo[] = [
  { name: 'Manoir', group: 'Classique', packId: 'pack-classic' },
  { name: 'TMCUP', group: 'Autres', packId: 'pack-tmcup' },
  { name: 'ZLAN', group: 'ZLAN', packId: 'pack-zlan' },
  { name: 'ZEvent', group: 'ZEvent', packId: 'pack-zevent' },
];

/** Saison en cours le jour de TEST_NOW (11/10, 14 h) : du 05/10 au 19/10. */
const season = (group: string, overrides: Partial<Season> = {}): Season => {
  const tower = TOWERS.find((t) => t.group === group)!;
  return {
    id: 's',
    index: 118,
    begin: '2026-10-05',
    end: '2026-10-19',
    towerName: tower.name,
    group,
    packId: tower.packId,
    floors: [],
    ...overrides,
  };
};

/** Carte d'un pack d'évènement : forgeable seulement pendant le Vortex de son groupe. */
const eventItem = (identifier: number, packId: string, overrides: Partial<Item> = {}) =>
  makeItem(identifier, {
    packId,
    packSlug: packId,
    packName: packId,
    isClassic: false,
    ...overrides,
  });

const plain = { goldable: false, upgradable: false, recyclable: false } as const;
const cristaux = (loreFragment: number) => ({
  balance: 0,
  loreDust: 0,
  loreFragment,
  upgradeDust: 0,
});

describe('courbe de valeur de garde', () => {
  it('est concave, et le revenu à venir couvre les premières dépenses', () => {
    const curve = holdCurve(
      [
        { amount: 100, value: 0.1, source: 0 },
        { amount: 100, value: 0.3, source: 0 },
      ],
      0,
    )!;
    expect(curveValue(curve, 100)).toBeCloseTo(30);
    expect(curveValue(curve, 200)).toBeCloseTo(40);
    expect(curveValue(curve, 1000)).toBeCloseTo(40);
    // 50 unités gagnées d'ici là : les 100 premières unités gardées valent 50 × 0,3 + 50 × 0,1.
    const income = holdCurve(curve.steps, 50)!;
    expect(curveValue(income, 100)).toBeCloseTo(20);
    expect(holdCurve([{ amount: 10, value: -1, source: 0 }], 0)).toBeNull();
  });
});

describe('libellé des monnaies gardées', () => {
  it('donne la probabilité d’un Vortex incertain', () => {
    const vortex = {
      currency: 'loreFragment' as const,
      kind: 'vortex' as const,
      label: 'ZEvent',
      begin: '2026-11-16',
      end: '2026-11-30',
      probability: 0.84,
    };
    expect(reserveLabel(vortex)).toBe('Vortex « ZEvent » du 16/11 (prévu · 84 %)');
    expect(reserveLabel({ ...vortex, probability: 0.99 })).toBe(
      'Vortex « ZEvent » du 16/11 (prévu)',
    );
  });
});

describe('cristaux et prochain Vortex', () => {
  // Vortex Autres en cours : trois cartes ★ de la TMCUP à créer, 1 point pour 50 cristaux.
  const tmcup = [1001, 1002, 1003].map((id) => eventItem(id, 'pack-tmcup', plain));
  // ZLAN : dorée possédée, constellation dorée à monter en enchantant une normale (400 cristaux
  // pour 120 points). Le Vortex ZLAN est le prochain.
  const zlan = eventItem(1101, 'pack-zlan', { recyclable: false });
  const input = (loreFragment: number, horizon: boolean, group = 'Autres') => ({
    catalog: makeCatalog([...tmcup, zlan], { season: season(group), towers: TOWERS }),
    player: makePlayer({
      balances: cristaux(loreFragment),
      inventory: Object.fromEntries([owned(zlan.id, 0, 2, 1), owned(zlan.id, 1, 1, 0)]),
    }),
    now: TEST_NOW,
    options: { horizon },
  });
  const crafts = (plan: ReturnType<typeof createPlan>) =>
    plan.steps.filter((s) => s.kind === 'craft').length;

  it('sans anticipation, dépense tout de suite les cristaux en petites créations', () => {
    const plan = createPlan(input(400, false));
    expect(crafts(plan)).toBe(3);
    expect(plan.after.balances.loreFragment).toBe(250);
    expect(plan.horizon).toBeNull();
  });

  it('avec anticipation, les garde pour la constellation dorée du Vortex ZLAN', () => {
    const plan = createPlan(input(400, true));
    expect(crafts(plan)).toBe(0);
    expect(plan.after.balances.loreFragment).toBe(400);
    expect(plan.horizon?.seasons[0]).toMatchObject({ group: 'ZLAN', begin: '2026-10-19' });
    expect(plan.horizon?.reserves).toEqual([
      expect.objectContaining({
        currency: 'loreFragment',
        kind: 'vortex',
        label: 'ZLAN',
        amount: 400,
      }),
    ]);
    expect(reserveLabel(plan.horizon!.reserves[0]!)).toBe('Vortex « ZLAN » du 19/10 (prévu)');
    // Ce que le Vortex ZLAN fera de ces cristaux : enchanter la normale, monter la constellation dorée.
    expect(plan.horizon!.reserves[0]!.preview.map((g) => g.command)).toEqual([
      '/enchantement carte:1101',
      '/constellation carte:1101+',
    ]);
    // Affiché en tête du plan, pas répété dans les conseils.
    expect(plan.advice.some((a) => a.startsWith('Garde'))).toBe(false);
  });

  it('ne garde que ce que le prochain Vortex dépensera', () => {
    // 550 cristaux : 400 pour le Vortex ZLAN, les 150 autres servent aujourd'hui.
    const plan = createPlan(input(550, true));
    expect(crafts(plan)).toBe(3);
    expect(plan.after.balances.loreFragment).toBe(400);
  });

  it("dépense aujourd'hui quand le Vortex en cours est le plus rentable", () => {
    // Vortex ZLAN en cours : la constellation dorée se fait tout de suite.
    const plan = createPlan(input(400, true, 'ZLAN'));
    expect(plan.steps.some((s) => s.kind === 'enchant')).toBe(true);
    expect(plan.after.balances.loreFragment).toBe(0);
  });

  it("ne garde rien quand l'avenir ne vaut rien (horizonDiscount : 0)", () => {
    const plan = createPlan({
      ...input(400, true),
      options: { horizon: true, horizonDiscount: 0 },
    });
    expect(crafts(plan)).toBe(3);
    expect(plan.horizon?.reserves).toEqual([]);
  });
});

describe('poudre et ascensions à venir', () => {
  // Vortex Classique : 14 essais encore à venir d'ici le 18/10 (deux par midi), aucun aujourd'hui.
  // Une ascension rapporte bien plus par poudre qu'une création ★.
  const r1 = [1001, 1002].map((id) => makeItem(id, plain));
  const r4 = Array.from({ length: 10 }, (_, i) => makeItem(4001 + i, plain));
  const floors = Array.from({ length: 6 }, () => ({
    rate: 0.2,
    drops: [{ rarity: 4, shiny: 0 as const, rate: 1 }],
  }));
  const input = (horizon: boolean) => ({
    catalog: makeCatalog([...r1, ...r4], {
      season: season('Classique', { floors }),
      towers: TOWERS,
    }),
    player: makePlayer({
      balances: { balance: 0, loreDust: 100, loreFragment: 0, upgradeDust: 0 },
      tower: { floorsClimbed: 0, logCount: 14 },
    }),
    now: TEST_NOW,
    options: { horizon },
  });

  it('sans anticipation, dépense la poudre en créations', () => {
    expect(createPlan(input(false)).steps.filter((s) => s.kind === 'craft')).toHaveLength(2);
  });

  it('avec anticipation, la garde pour les essais à venir', () => {
    const plan = createPlan(input(true));
    expect(plan.steps.filter((s) => s.kind === 'craft')).toHaveLength(0);
    expect(plan.horizon?.reserves).toEqual([
      expect.objectContaining({ currency: 'loreDust', kind: 'ascension', amount: 100, count: 14 }),
    ]);
    expect(reserveLabel(plan.horizon!.reserves[0]!)).toBe("14 essais d'ascension d'ici le 18/10");
    const preview = plan.horizon!.reserves[0]!.preview;
    expect(preview).toHaveLength(14);
    expect(new Set(preview.map((g) => g.command))).toEqual(new Set(['/as']));
  });
});

describe('évènement annoncé', () => {
  // Les cartes ★ sont toutes possédées : une invocation basique rapporte surtout des dorées et des
  // chromas. L'évènement, annoncé pour le 13/10, garantit qu'une ★★★★ tirée est l'une des quatre
  // qui manquent.
  const r1 = Array.from({ length: 20 }, (_, i) => makeItem(1001 + i));
  const featured = Array.from({ length: 4 }, (_, i) => makeItem(4001 + i));
  const r4 = Array.from({ length: 20 }, (_, i) => makeItem(4101 + i));
  const event: GameEvent = {
    id: 'evt',
    name: 'zerator',
    packId: null,
    packSlug: null,
    packName: null,
    balanceCost: 1000,
    loreDustCost: 0,
    oneTime: false,
    active: true,
    invokeCount: 10,
    begin: '2026-10-13T00:00:00',
    end: '2026-10-19T23:59:59',
    itemIds: featured.map((i) => i.id),
  };
  const input = (horizon: boolean) => ({
    catalog: makeCatalog([...r1, ...featured, ...r4], {
      events: [event],
      // Sans /journa : seule la ZUMonnaie déjà gagnée paie l'invocation de l'évènement.
      settings: {
        dailyReward: 1000,
        weeklyReward: 1000,
        dailyLoreDust: 10,
        features: ['INVOKE', 'CRAFT', 'RECYCLE', 'UPGRADE', 'FUSION'],
      },
    }),
    player: makePlayer({
      balances: { balance: 1000, loreDust: 0, loreFragment: 0, upgradeDust: 0 },
      inventory: Object.fromEntries([...r1, ...r4].map((i) => owned(i.id, 0, 1, i.rarity))),
    }),
    now: TEST_NOW,
    options: { horizon },
  });

  it('sans anticipation, invoque tout de suite', () => {
    expect(createPlan(input(false)).commands).toContain('/im');
  });

  it("avec anticipation, garde la ZUMonnaie pour l'évènement", () => {
    const plan = createPlan(input(true));
    expect(plan.commands.some((c) => c.startsWith('/im'))).toBe(false);
    expect(plan.horizon?.reserves).toEqual([
      expect.objectContaining({
        currency: 'balance',
        kind: 'event',
        label: 'zerator',
        amount: 1000,
      }),
    ]);
    expect(reserveLabel(plan.horizon!.reserves[0]!)).toBe('évènement « zerator » du 13/10');
    expect(plan.horizon!.reserves[0]!.preview[0]).toMatchObject({
      command: '/im évènement:zerator',
      title: 'Invocation « zerator »',
    });
  });

  it("n'attend pas un évènement annoncé au-delà de horizonEventDays", () => {
    const plan = createPlan({ ...input(true), options: { horizon: true, horizonEventDays: 1 } });
    expect(plan.commands).toContain('/im');
    expect(plan.stats.horizon).toMatchObject({ windows: 0, skipped: 1 });
  });
});

describe('heuristiques', () => {
  const zlan = eventItem(1101, 'pack-zlan');
  const zevent = eventItem(1201, 'pack-zevent');
  const boss = eventItem(1301, 'pack-boss');
  const towers = [...TOWERS, { name: 'Boss', group: 'Boss', packId: 'pack-boss' }];

  it('ne simule ni le Classique, ni un groupe improbable, ni un Vortex sans monnaie à y dépenser', () => {
    const ctx = (loreFragment: number, horizonSeasons?: number) =>
      withHorizon(
        makeContext(
          makeCatalog([zlan, zevent, boss], { season: season('Autres'), towers }),
          makePlayer({ balances: cristaux(loreFragment) }),
          { horizon: true, ...(horizonSeasons ? { horizonSeasons } : {}) },
        ),
      );
    // Classique (rien de nouveau à forger), Boss (absent de la rotation), ZLAN et ZEvent sans
    // cristaux : aucune simulation.
    expect(ctx(0).horizon?.stats).toMatchObject({ windows: 0, skipped: 4 });
    // Avec des cristaux : ZLAN et ZEvent sont simulés, pas le Classique ni Boss.
    expect(ctx(1000).horizon?.stats).toMatchObject({ windows: 2, skipped: 2 });
    expect(ctx(1000).horizon?.sources.map((s) => s.label)).toEqual(['ZLAN', 'ZEvent']);
    // Une seule saison examinée : le Vortex ZLAN (le prochain), pas le ZEvent (dans deux saisons).
    expect(ctx(1000, 1).horizon?.stats).toMatchObject({ windows: 1, skipped: 3 });
    expect(ctx(1000, 1).horizon?.sources.map((s) => s.label)).toEqual(['ZLAN']);
    expect(ctx(1000, 1).horizon?.forecasts).toHaveLength(1);
  });

  it('borne les réglages de l’anticipation', () => {
    expect(resolveOptions({})).toMatchObject({
      horizonDiscount: 0.9,
      horizonSeasons: 4,
      horizonEventDays: 28,
    });
    expect(
      resolveOptions({ horizonDiscount: 2, horizonSeasons: 0, horizonEventDays: 1000 }),
    ).toMatchObject({ horizonDiscount: 1, horizonSeasons: 1, horizonEventDays: 56 });
    expect(
      resolveOptions({ horizonDiscount: -1, horizonSeasons: 3.7, horizonEventDays: NaN }),
    ).toMatchObject({ horizonDiscount: 0, horizonSeasons: 3, horizonEventDays: 28 });
  });

  it("n'est calculée qu'avec l'option", () => {
    const ctx = makeContext(
      makeCatalog([zlan], { season: season('Autres'), towers }),
      makePlayer(),
    );
    expect(withHorizon(ctx)).toBe(ctx);
  });
});

describe('joueur réel (fixtures)', () => {
  const catalog = fixtureCatalog();
  const player = fixturePlayer();

  it("ne change rien sans l'option", () => {
    const plan = createPlan({ catalog, player, now: NOW });
    const off = createPlan({ catalog, player, now: NOW, options: { horizon: false } });
    expect(off.hash).toBe(plan.hash);
    expect(plan.horizon).toBeNull();
    expect(plan.stats.horizon).toBeUndefined();
  });

  it('reste valide, déterministe et rapide avec l’option', () => {
    const plan = createPlan({ catalog, player, now: NOW, options: { horizon: true } });
    for (const v of Object.values(plan.after.balances)) expect(v).toBeGreaterThanOrEqual(0);
    expect(createPlan({ catalog, player, now: NOW, options: { horizon: true } }).hash).toBe(
      plan.hash,
    );
    // Vortex Classique en cours : la TMCUP (Autres) était bien la suivante.
    expect(plan.horizon?.seasons.map((s) => s.group)).toEqual(['Autres', 'ZLAN', 'ZEvent']);
    expect(plan.stats.horizon?.durationMs).toBeLessThan(2000);
    expect(plan.stats.durationMs).toBeLessThan(15_000);
  });
});
