import { describe, expect, it, vi } from 'vitest';
import {
  AchievementEntriesSchema,
  applyAction,
  buildContext,
  createClient,
  createPlan,
  fetchAchievements,
  initialState,
  normalizeAchievements,
  replay,
  resolveOptions,
  search,
  nodeSteps,
  stateValue,
  type Achievement,
  type Season,
} from '../src';
import { makeCatalog, makeContext, makeItem, makePlayer, owned, TEST_NOW } from './factory';
import { fixtureCatalog, fixturePlayer, NOW } from './helpers';

const achievement = (description: string, current: number, max: number, score = 50) =>
  ({
    id: description,
    name: description,
    description,
    score,
    rewardLoreDust: 0,
    current,
    max,
  }) satisfies Achievement;

describe('chargement des succès', () => {
  it('ne charge que les catégories pas encore terminées', async () => {
    const entry = { achievement: { id: 'a', description: 'Faire toutes les fusions classiques' } };
    const responses: Record<string, unknown> = {
      '/public/achievement/alex/category': [
        { id: 'done', name: 'Score', doneCount: 13, totalCount: 13 },
        { id: 'forge', name: 'La Forge', doneCount: 11, totalCount: 12 },
      ],
      '/public/achievement/alex/forge': [entry],
    };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const body = responses[String(url).replace('https://api.test', '')];
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status: body === undefined ? 404 : 200,
      });
    });
    const client = createClient({
      baseUrl: 'https://api.test',
      fetch: fetch as typeof globalThis.fetch,
    });
    const entries = await fetchAchievements(client, 'alex');
    expect(entries?.map((e) => e.achievement.id)).toEqual(['a']);
    expect(fetch).toHaveBeenCalledTimes(2);
    // API sans succès : le plan se calcule sans eux.
    await expect(
      fetchAchievements(
        createClient({
          baseUrl: 'https://api.test',
          fetch: (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch,
        }),
        'bob',
      ),
    ).resolves.toBeNull();
  });
});

describe('normalisation des succès', () => {
  it('ne garde que les succès pas encore obtenus', () => {
    const raw = AchievementEntriesSchema.parse([
      {
        id: 'log',
        date: '2022-03-13T03:25:20',
        achievement: {
          id: 'a',
          name: 'Première fusion',
          description: 'Faire une fusion',
          score: 10,
        },
      },
      {
        achievement: {
          id: 'b',
          name: 'FU-SION !',
          description: 'Faire toutes les fusions',
          score: 100,
        },
        progress: { type: 'PERCENT', current: 10, max: 12 },
      },
      {
        achievement: {
          id: 'c',
          name: 'Streamers harmonisés',
          description: 'Obtenir la carte légendaire "Streamers harmonisés"',
          score: 100,
          rewardLoreDust: 30,
        },
      },
    ]);
    expect(normalizeAchievements(raw)).toEqual([
      expect.objectContaining({ id: 'b', current: 10, max: 12, rewardLoreDust: 0 }),
      expect.objectContaining({ id: 'c', current: 0, max: 1, rewardLoreDust: 30 }),
    ]);
  });
});

describe('objectifs des succès', () => {
  const r1 = [1001, 1002, 1003].map((n) => makeItem(n));
  const r2 = [2001, 2002].map((n) => makeItem(n));
  const notCounting = makeItem(1004, { counting: false });
  const pack = [9001, 9002].map((n) =>
    makeItem(n, {
      rarity: 1,
      isClassic: false,
      packId: 'zlan',
      packName: 'ZLAN',
      packSlug: 'zlan-2024',
      packYear: 2024,
    }),
  );
  const catalog = makeCatalog([...r1, ...r2, notCounting, ...pack]);
  const inventory = Object.fromEntries([
    owned(r1[0]!.id, 0, 1),
    owned(r1[1]!.id, 1, 1),
    owned(r2[0]!.id, 1, 1),
    owned(r2[0]!.id, 0, 0, 2),
    owned(pack[0]!.id, 1, 1),
  ]);
  const goals = (achievements: Achievement[]) =>
    makeContext(catalog, makePlayer({ inventory, achievements })).achievements;

  it('reconnaît les collections et vérifie la progression affichée par l’API', () => {
    const [all1, golden2, constellation2, zlan] = goals([
      // Une carte normale compte dans n'importe quelle brillance ; 1004 ne compte pas.
      achievement('Obtenir toutes les cartes ★ classiques', 2, 3),
      achievement('Obtenir toutes les cartes ★★ dorées classiques', 1, 2),
      achievement('Compléter toutes les cartes constellation ★★ classiques', 1, 2),
      achievement('Obtenir toutes les cartes du pack ZLAN 2024', 1, 2),
    ]);
    expect(all1?.cards).toEqual(r1.map((i) => ({ itemId: i.id, shiny: null })));
    expect(golden2?.cards).toEqual(r2.map((i) => ({ itemId: i.id, shiny: 1 })));
    expect(constellation2?.constellation).toBe(true);
    expect(zlan?.cards?.map((c) => c.itemId)).toEqual(pack.map((i) => i.id));
  });

  it('ignore un succès dont la progression ne correspond pas aux cartes trouvées', () => {
    expect(goals([achievement('Obtenir toutes les cartes ★ classiques', 1, 3)])).toEqual([]);
    expect(goals([achievement('Obtenir toutes les cartes ★ classiques', 2, 4)])).toEqual([]);
    expect(goals([achievement('Gratter 100 Rayou Official', 48, 100)])).toEqual([]);
  });

  it('reconnaît les compteurs de recyclages, de fusions et l’ascension en cours', () => {
    const season: Season = {
      id: 's',
      index: 1,
      begin: '2026-10-01',
      end: '2026-10-31',
      towerName: 'Ascension du ZEvent 2026',
      group: 'ZEvent',
      packId: 'zevent',
      floors: [],
    };
    const ctx = makeContext(
      makeCatalog(r1, { season }),
      makePlayer({
        achievements: [
          achievement('Recycler 1 000 cartes avec la commande /recycler', 120, 1000),
          achievement('Faire une fusion de cartes avec la commande /fusion', 0, 1),
          achievement("Participer à l'Ascension du ZEvent 2026", 0, 1),
          achievement("Participer à l'Ascension de la ZLAN 2026", 0, 1),
        ],
      }),
    );
    expect(ctx.achievements.map((a) => [a.counter, a.current, a.max])).toEqual([
      ['recycle', 120, 1000],
      ['fusion', 0, 1],
      ['ascension', 0, 1],
    ]);
  });
});

describe('progression simulée', () => {
  it('rapporte les points et la poudre du succès quand la dernière carte arrive', () => {
    const items = [1001, 1002].map((n) => makeItem(n));
    const ctx = makeContext(
      makeCatalog(items),
      makePlayer({
        balances: { balance: 0, loreDust: 50, loreFragment: 0, upgradeDust: 0 },
        inventory: Object.fromEntries([owned(items[0]!.id, 0, 1)]),
        achievements: [
          {
            ...achievement('Obtenir toutes les cartes ★ classiques', 1, 2, 70),
            rewardLoreDust: 30,
          },
        ],
      }),
    );
    const before = initialState(ctx);
    const after = applyAction(ctx, before, { kind: 'craft', itemId: items[1]!.id })!;
    expect(after.state.achievements).toEqual([2]);
    expect(after.state.achievementPoints).toBe(70);
    expect(after.state.balances.loreDust).toBe(30);
    expect(after.balanceDelta.loreDust).toBe(-20);
    expect(before.achievements).toEqual([1]);
  });

  it('compte les cartes recyclées', () => {
    const item = makeItem(1001, { upgradable: false, goldable: false });
    const ctx = makeContext(
      makeCatalog([item]),
      makePlayer({
        inventory: Object.fromEntries([owned(item.id, 0, 12)]),
        achievements: [
          achievement('Recycler 10 cartes avec la commande /recycler', 3, 10, 20),
          achievement('Recycler 100 cartes avec la commande /recycler', 3, 100, 30),
        ],
      }),
    );
    const applied = applyAction(ctx, initialState(ctx), {
      kind: 'recycle',
      cards: [{ itemId: item.id, shiny: 0, count: 11 }],
    })!;
    expect(applied.state.achievements).toEqual([10, 14]);
    expect(applied.state.achievementPoints).toBe(20);
  });
});

describe('planification', () => {
  const items = [1001, 1002, 1003].map((n) => makeItem(n, { goldable: false }));
  const player = (achievements: Achievement[]) =>
    makePlayer({
      balances: { balance: 0, loreDust: 100, loreFragment: 0, upgradeDust: 0 },
      inventory: Object.fromEntries([owned(items[0]!.id, 0, 1)]),
      achievements,
    });
  // La poudre vaut plus que les points d'une carte ★ : créer une carte seule ne vaut pas le coût.
  const options = { weights: { loreDust: 0.05 } };

  it('termine un succès de collection quand ses points valent la dépense', () => {
    const plan = createPlan({
      catalog: makeCatalog(items),
      player: player([achievement('Obtenir toutes les cartes ★ classiques', 1, 3, 20)]),
      options,
      now: TEST_NOW,
    });
    expect(plan.commands).toEqual(['/création carte:1002 + 1003']);
    expect(plan.gain.achievements).toBe(20);
    expect(plan.achievements).toEqual([
      expect.objectContaining({ before: 1, after: 3, max: 3, score: 20 }),
    ]);
    // Le succès est signalé sur la commande qui l'obtient (la seconde création).
    expect(plan.steps.map((s) => s.achievements)).toEqual([
      [],
      ['Obtenir toutes les cartes ★ classiques'],
    ]);
    expect(plan.groups[0]?.achievements).toEqual(['Obtenir toutes les cartes ★ classiques']);
  });

  it('ne dépense rien sans succès à la clé', () => {
    const plan = createPlan({
      catalog: makeCatalog(items),
      player: player([]),
      options,
      now: TEST_NOW,
    });
    expect(plan.commands).toEqual([]);
    expect(plan.achievements).toEqual([]);
  });

  it('tenir compte des succès ne donne jamais un plan moins bon (fixtures)', () => {
    const catalog = fixtureCatalog();
    const base = fixturePlayer();
    const golden2 = Object.values(catalog.items).filter(
      (i) => i.isClassic && i.counting && i.rarity === 2 && i.shinyAvailable[1],
    );
    const have = golden2.filter((i) => (base.inventory[`${i.id}:1`]?.copies ?? 0) > 0).length;
    const withGoal = {
      ...base,
      achievements: [
        achievement('Obtenir toutes les cartes ★★ dorées classiques', have, golden2.length, 400),
      ],
    };
    const ctx = buildContext(catalog, withGoal, NOW, resolveOptions());
    expect(ctx.achievements).toHaveLength(1);
    const blind = buildContext(catalog, base, NOW, resolveOptions());
    const blindActions = nodeSteps(search(blind).best).map((s) => s.action);
    const blindValue = stateValue(ctx, replay(ctx, blindActions));
    expect(search(ctx).best.value).toBeGreaterThanOrEqual(blindValue - 1e-6);
  });
});
