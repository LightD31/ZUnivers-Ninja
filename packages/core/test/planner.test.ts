import { describe, expect, it } from 'vitest';
import {
  buildContext,
  createPlan,
  commandLine,
  COMMAND_MAX_LENGTH,
  replay,
  resolveOptions,
  search,
  nodeSteps,
  type PlanResult,
} from '../src';
import { reserveFor, reserveTotal } from '../src/rules/reserve';
import { getCard } from '../src/engine/state';
import { regroup, type Step } from '../src/engine/planner';
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

describe('regroupement des commandes', () => {
  it('ne change ni les cartes ni les monnaies du plan, et réduit les changements de commande', () => {
    const ctx = buildContext(catalog, player, NOW, resolveOptions({}));
    const steps = nodeSteps(search(ctx).best);
    const regrouped = regroup(ctx, steps);
    const final = (list: Step[]) =>
      replay(
        ctx,
        list.map((s) => s.action),
      );
    const cards = (state: ReturnType<typeof final>) =>
      [...state.cards.entries().values()]
        .filter((c) => c.copies > 0 || c.constellation > 0)
        .map((c) => `${c.itemId}:${c.shiny}:${c.copies}:${c.constellation}`)
        .sort();
    const [before, after] = [final(steps), final(regrouped)];
    expect(after.points).toBe(before.points);
    expect(after.balances).toEqual(before.balances);
    expect(cards(after)).toEqual(cards(before));
    const runs = (list: Step[]) =>
      list.filter((s, i) => i === 0 || s.action.kind !== list[i - 1]!.action.kind).length;
    expect(runs(regrouped)).toBeLessThan(runs(steps));
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
      '/création carte:1002',
    ]);
    expect(plan.after.balances.loreDust).toBe(5);
    expect(plan.after.unique[0]).toBe(2);
  });

  it('découpe un gros recyclage en commandes que le jeu accepte', () => {
    // Le bot du jeu n'exécutait pas une commande de 3 962 caractères (562 cartes).
    const plain = { upgradable: false, goldable: false } as const;
    const a = makeItem(1001, plain);
    const b = makeItem(1002, plain);
    const plan = createPlan({
      catalog: makeCatalog([a, b]),
      player: makePlayer({
        inventory: Object.fromEntries([owned(a.id, 0, 301), owned(b.id, 0, 101)]),
      }),
      now: TEST_NOW,
    });
    const recycles = plan.commands.filter((c) => c.startsWith('/recyclage'));
    const cards = recycles.map((c) => c.slice('/recyclage carte:'.length).split(' + '));
    expect(recycles).toHaveLength(2);
    for (const c of recycles) expect(c.length).toBeLessThanOrEqual(COMMAND_MAX_LENGTH);
    // La première commande est pleine : une carte de plus (« + 1001 ») la rendrait trop longue.
    expect(recycles[0]!.length + ' + 1001'.length).toBeGreaterThan(COMMAND_MAX_LENGTH);
    expect(cards.flat()).toHaveLength(400);
    expect(new Set(cards[1])).toEqual(new Set(['1001', '1002']));
    expect(plan.after.balances.loreDust).toBe(400 * 5);
  });

  it('coupe une longue suite de créations en commandes que le jeu accepte', () => {
    const plain = { upgradable: false, goldable: false, recyclable: false } as const;
    const items = Array.from({ length: 300 }, (_, i) => makeItem(1001 + i, plain));
    const plan = createPlan({
      catalog: makeCatalog(items),
      player: makePlayer({
        balances: { balance: 0, loreDust: 300 * 50, loreFragment: 0, upgradeDust: 0 },
      }),
      now: TEST_NOW,
    });
    const crafts = plan.groups.filter((g) => g.kind === 'craft');
    expect(crafts.length).toBeGreaterThan(1);
    for (const g of crafts) expect(g.command.length).toBeLessThanOrEqual(COMMAND_MAX_LENGTH);
    expect(crafts.reduce((n, g) => n + g.size, 0)).toBe(300);
  });

  it('privilégie la constellation au recyclage', () => {
    const r3 = makeItem(3001, { goldable: false });
    const plan = createPlan({
      catalog: makeCatalog([r3]),
      player: makePlayer({ inventory: Object.fromEntries([owned(r3.id, 0, 6)]) }),
      now: TEST_NOW,
    });
    expect(plan.commands).toEqual([
      '/constellation carte:3001 + 3001 + 3001',
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
    expect(plan.commands).toEqual(['/création carte:2002', '/fusion carte:5001']);
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

  it('crée une carte pour l’enchanter quand elle ouvre une constellation dorée', () => {
    // Dorées ★★ possédées, dernier exemplaire normal déjà enchanté : création (100) +
    // enchantement (800) + constellation dorée = 160 points pour 900 poudres. Une création seule
    // ne rapporte que 5 points, et le faisceau dépensait la poudre en constellations ★★★★ :
    // 160 points pour 2 000 poudres.
    const golden = Array.from({ length: 5 }, (_, i) => makeItem(2001 + i, { recyclable: false }));
    const big = Array.from({ length: 2 }, (_, i) =>
      makeItem(4001 + i, { recyclable: false, goldable: false }),
    );
    const plan = createPlan({
      catalog: makeCatalog([...golden, ...big]),
      player: makePlayer({
        balances: { balance: 0, loreDust: 4500, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries([
          ...golden.map((i) => owned(i.id, 1, 1)),
          ...big.map((i) => owned(i.id, 0, 1)),
        ]),
      }),
      now: TEST_NOW,
    });
    expect(plan.gain.points).toBe(800);
    expect(plan.steps.filter((s) => s.kind === 'constellation')).toHaveLength(5);
    expect(plan.steps.some((s) => s.cards.some((c) => c.rarity === 4))).toBe(false);
  });

  it('regroupe les commandes : créations, puis enchantements, puis constellations', () => {
    // Cinq chaînes « créer, enchanter, constellation dorée » : la recherche les enchaîne carte par
    // carte, soit quinze commandes. Le plan les regroupe en trois.
    const golden = Array.from({ length: 5 }, (_, i) => makeItem(2001 + i, { recyclable: false }));
    const plan = createPlan({
      catalog: makeCatalog(golden),
      player: makePlayer({
        balances: { balance: 0, loreDust: 4500, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries(golden.map((i) => owned(i.id, 1, 1))),
      }),
      now: TEST_NOW,
    });
    expect(plan.commands.map((c) => c.split(':')[0])).toEqual([
      '/création carte',
      '/enchantement carte',
      '/constellation carte',
    ]);
    expect(plan.gain.points).toBe(800);
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
    expect(commandLine('invoke', 'chroma')).toBe('/im évènement:chroma');
    expect(commandLine('invoke', '')).toBe('/im');
    expect(commandLine('recycle', '1001 + 1002*')).toBe('/recyclage carte:1001 + 1002*');
    expect(commandLine('enchant', '1023')).toBe('/enchantement carte:1023');
    expect(commandLine('evolution', '1023')).toBe('/évolution carte:1023');
    expect(commandLine('daily', '')).toBe('/journa');
    // Invocation basique : pas d'option.
    for (const c of createPlan({ catalog, player, now: NOW }).commands.filter((c) =>
      c.startsWith('/im'),
    ))
      expect(c).toMatch(/^\/im( évènement:\S.*)?$/);
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
