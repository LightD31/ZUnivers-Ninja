import { describe, expect, it } from 'vitest';
import {
  buildContext,
  createPlan,
  commandLine,
  replay,
  resolveOptions,
  search,
  nodeSteps,
  type PlanResult,
} from '../src';
import { reserveFor, reserveTotal } from '../src/rules/reserve';
import { getCard } from '../src/engine/state';
import { makeCatalog, makeItem, makePlayer, owned, TEST_NOW } from './factory';
import { fixtureCatalog, fixturePlayer, NOW } from './helpers';

const catalog = fixtureCatalog();
const player = fixturePlayer();

describe('plan sur un joueur réel (fixtures)', () => {
  const plan: PlanResult = createPlan({ catalog, player, now: NOW });

  it('produit des commandes et améliore la collection', () => {
    expect(plan.commands.length).toBeGreaterThan(0);
    expect(plan.commands[0]).toBe('/journa');
    expect(plan.gain.points).toBeGreaterThan(0);
    expect(plan.after.points).toBeGreaterThan(plan.before.points);
  });

  it('ne laisse aucune monnaie négative', () => {
    for (const v of Object.values(plan.after.balances)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('est déterministe', () => {
    const again = createPlan({ catalog, player, now: NOW });
    expect(again.commands).toEqual(plan.commands);
    expect(again.hash).toBe(plan.hash);
  });

  it('fait progresser les défis planifiables', () => {
    const craft = plan.challenges.find((c) => c.description === 'Créer une carte');
    expect(craft?.after).toBe(craft?.max);
    const trade = plan.challenges.find((c) => c.description.startsWith('Échanger'));
    expect(trade?.plannable).toBe(false);
    expect(trade?.after).toBe(trade?.before);
  });

  it('ne compte que les cartes réellement possédées', () => {
    expect(plan.before.unique[0]).toBe(
      Object.values(player.inventory).filter(
        (c) => c.shiny === 0 && c.copies > 0 && catalog.items[c.itemId],
      ).length,
    );
  });

  it('reste rapide', () => {
    expect(plan.stats.durationMs).toBeLessThan(15_000);
    expect(plan.stats.timedOut).toBe(false);
  });
});

describe('recherche', () => {
  const ctx = (beamWidth: number) =>
    buildContext(catalog, player, NOW, resolveOptions({ beamWidth }));

  it('le faisceau fait au moins aussi bien que le glouton', () => {
    const greedy = search(ctx(1)).best.value;
    const beam = search(ctx(16)).best.value;
    expect(beam).toBeGreaterThanOrEqual(greedy - 1e-6);
  });

  it('finit le plan en glouton une fois la limite de temps atteinte', () => {
    const limited = search(
      buildContext(catalog, player, NOW, resolveOptions({ beamWidth: 64, timeLimitMs: 1e-6 })),
    );
    const greedy = search(
      buildContext(catalog, player, NOW, resolveOptions({ beamWidth: 1, branching: 1 })),
    );
    expect(limited.timedOut).toBe(true);
    expect(greedy.timedOut).toBe(false);
    expect(limited.best.value).toBe(greedy.best.value);
    expect(nodeSteps(limited.best).map((s) => s.action)).toEqual(
      nodeSteps(greedy.best).map((s) => s.action),
    );
  });

  it('chaque plan se rejoue et ne touche jamais aux exemplaires réservés', () => {
    const c = ctx(8);
    const { best } = search(c);
    const steps = nodeSteps(best);
    const final = replay(
      c,
      steps.map((s) => s.action),
    );
    expect(final.points).toBeCloseTo(best.state.points);
    // Après le plan, chaque carte garde au moins un exemplaire si elle en avait un et n'a pas été
    // volontairement transformée (enchantement, fusion, évolution).
    for (const card of Object.values(player.inventory)) {
      if (card.copies === 0) continue;
      const after = getCard(final, card.itemId, card.shiny);
      const transformed = steps.some(
        (s) =>
          (s.action.kind === 'enchant' && s.action.itemId === card.itemId) ||
          s.action.kind === 'fusion' ||
          s.action.kind === 'evolution',
      );
      if (!transformed) expect(after.copies).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('cas synthétiques', () => {
  it('recycle exactement le surplus et utilise la poudre', () => {
    const a = makeItem(1001, { upgradable: false, goldable: false });
    const b = makeItem(1002, { upgradable: false, goldable: false });
    const plan = createPlan({
      catalog: makeCatalog([a, b]),
      player: makePlayer({ inventory: Object.fromEntries([owned(a.id, 0, 12)]) }),
      now: TEST_NOW,
    });
    // 11 doublons × 5 = 55 poudres → création de la carte manquante (50).
    expect(plan.commands).toEqual([
      `/recyclage carte:${Array(11).fill('1001').join(' + ')}`,
      '/création 1002',
    ]);
    expect(plan.after.balances.loreDust).toBe(5);
    expect(plan.after.unique[0]).toBe(2);
  });

  it('privilégie la constellation au recyclage', () => {
    const r3 = makeItem(3001, { goldable: false });
    const plan = createPlan({
      catalog: makeCatalog([r3]),
      player: makePlayer({ inventory: Object.fromEntries([owned(r3.id, 0, 6)]) }),
      now: TEST_NOW,
    });
    expect(plan.commands).toEqual([
      '/constellation 3001 + 3001 + 3001',
      '/recyclage carte:3001 + 3001',
    ]);
    expect(plan.groups[0]?.title).toBe('Constellations : 3 niveaux sur 1 carte');
  });

  it('complète une fusion en créant le composant manquant', () => {
    const a = makeItem(2001, { upgradable: false, goldable: false });
    const b = makeItem(2002, { upgradable: false, goldable: false });
    const result = makeItem(5001, {
      rarity: 5,
      isFusion: true,
      craftable: false,
      upgradable: false,
      goldable: false,
    });
    const plan = createPlan({
      catalog: makeCatalog([a, b, result], {
        fusions: [
          {
            resultId: result.id,
            inputs: [
              { itemId: a.id, quantity: 1 },
              { itemId: b.id, quantity: 1 },
            ],
          },
        ],
      }),
      player: makePlayer({
        balances: { balance: 0, loreDust: 200, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries([owned(a.id, 0, 2), owned(b.id, 0, 1)]),
      }),
      now: TEST_NOW,
    });
    expect(plan.commands).toEqual(['/création 2002', '/fusion 5001']);
  });

  it('préfère plusieurs petites dépenses rentables à une grosse qui épuise le budget', () => {
    // Fusion : +300 points pour 4 000 poudres. Enchantements : +60 points pour 400 poudres chacun.
    const plain = { recyclable: false, upgradable: false } as const;
    const cheap = Array.from({ length: 10 }, (_, i) => makeItem(1001 + i, plain));
    const a = makeItem(4001, { ...plain, goldable: false });
    const b = makeItem(4002, { ...plain, goldable: false });
    const result = makeItem(5001, {
      ...plain,
      rarity: 5,
      isFusion: true,
      craftable: false,
      goldable: false,
    });
    const input = {
      catalog: makeCatalog([...cheap, a, b, result], {
        fusions: [
          {
            resultId: result.id,
            inputs: [
              { itemId: a.id, quantity: 1 },
              { itemId: b.id, quantity: 1 },
            ],
          },
        ],
      }),
      player: makePlayer({
        balances: { balance: 0, loreDust: 4000, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries([
          ...cheap.map((i) => owned(i.id, 0, 2)),
          owned(a.id, 0, 1),
          owned(b.id, 0, 1),
        ]),
      }),
      now: TEST_NOW,
    };
    for (const beamWidth of [1, 16]) {
      const plan = createPlan({ ...input, options: { beamWidth } });
      expect(plan.commands.some((c) => c.startsWith('/fusion'))).toBe(false);
      expect(plan.gain.points).toBe(600);
    }
  });

  it('ignore les constellations quand le mode de jeu n’en a pas (régression Hardcore)', () => {
    // Le Hardcore n'annonce pas UPGRADE. Les paires « enchantement + constellation » proposées
    // quand même échouaient, gonflaient la valeur de la poudre et occupaient toutes les places
    // de candidats : le plan ne créait plus rien. Les doublons restaient aussi réservés à des
    // constellations impossibles, donc jamais recyclés.
    const known = Array.from({ length: 20 }, (_, i) => makeItem(2001 + i));
    const missing = Array.from({ length: 5 }, (_, i) => makeItem(3001 + i, { goldable: false }));
    const plan = createPlan({
      catalog: makeCatalog([...known, ...missing], {
        settings: {
          dailyReward: 1000,
          weeklyReward: 1000,
          dailyLoreDust: 10,
          features: ['LOOT', 'CRAFT', 'RECYCLE', 'FUSION', 'INVOKE'],
        },
      }),
      player: makePlayer({
        balances: { balance: 0, loreDust: 1000, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries(known.flatMap((c) => [owned(c.id, 0, 2), owned(c.id, 1, 1)])),
      }),
      now: TEST_NOW,
    });
    expect(plan.commands.some((c) => c.startsWith('/constellation'))).toBe(false);
    // 20 doublons normaux recyclés (20 × 20 poudres) : 1 400 poudres, soit 2 créations à 500.
    expect(plan.steps.filter((s) => s.kind === 'recycle').flatMap((s) => s.cards)).toHaveLength(20);
    expect(plan.steps.filter((s) => s.kind === 'craft')).toHaveLength(2);
  });

  it("n'invoque pas quand l'invocation n'apporte rien", () => {
    const a = makeItem(1001, {
      recyclable: false,
      upgradable: false,
      goldable: false,
      shinyAvailable: [true, false, false],
    });
    const plan = createPlan({
      catalog: makeCatalog([a]),
      player: makePlayer({
        balances: { balance: 10_000, loreDust: 0, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries([owned(a.id, 0, 1)]),
      }),
      now: TEST_NOW,
    });
    expect(plan.commands).toEqual([]);
  });

  it('invoque quand la collection est incomplète', () => {
    const items = Array.from({ length: 50 }, (_, i) => makeItem(1001 + i));
    const plan = createPlan({
      catalog: makeCatalog(items),
      player: makePlayer({
        balances: { balance: 2000, loreDust: 0, loreFragment: 0, upgradeDust: 0 },
      }),
      now: TEST_NOW,
    });
    expect(plan.commands.some((c) => c.startsWith('/im'))).toBe(true);
    expect(plan.gain.expected).toBeGreaterThan(0);
  });

  it("nomme l'option des invocations pour qu'un copier-coller dans Discord la remplisse", () => {
    expect(commandLine('invoke', 'chroma')).toBe('/im  évènement:chroma');
    expect(commandLine('invoke', '')).toBe('/im');
    expect(commandLine('recycle', '1001 + 1002*')).toBe('/recyclage carte:1001 + 1002*');
    // Invocation basique : pas d'option.
    for (const c of createPlan({ catalog, player, now: NOW }).commands.filter((c) =>
      c.startsWith('/im'),
    ))
      expect(c).toMatch(/^\/im( {2}évènement:\S.*)?$/);
  });

  it('respecte keepExtra pour les échanges', () => {
    const a = makeItem(1001, { upgradable: false, goldable: false });
    const catalogA = makeCatalog([a]);
    const playerA = makePlayer({ inventory: Object.fromEntries([owned(a.id, 0, 5)]) });
    const plan = createPlan({
      catalog: catalogA,
      player: playerA,
      now: TEST_NOW,
      options: { keepExtra: 2 },
    });
    expect(plan.commands).toEqual(['/recyclage carte:1001 + 1001']);
    const ctx = buildContext(catalogA, playerA, TEST_NOW, resolveOptions({ keepExtra: 2 }));
    const final = replay(
      ctx,
      nodeSteps(search(ctx).best).map((s) => s.action),
    );
    expect(getCard(final, a.id, 0).copies).toBe(reserveTotal(reserveFor(ctx, final, a.id, 0)));
  });
});
