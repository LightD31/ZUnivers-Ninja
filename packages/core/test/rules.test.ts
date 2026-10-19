import { describe, expect, it } from 'vitest';
import {
  applyAction,
  ascensionCredits,
  gameClock,
  initialState,
  reserveFor,
  type Action,
  type Season,
} from '../src';
import { recycleGain } from '../src/engine/context';
import { getCard, type State } from '../src/engine/state';
import { makeCatalog, makeContext, makeItem, makePlayer, owned } from './factory';

const r1 = makeItem(1001);
const r2 = makeItem(2001);
const r4 = makeItem(4001);
const event = makeItem(1501, {
  rarity: 1,
  packId: 'pack-zlan',
  packName: 'ZLAN',
  packSlug: 'zlan-2024',
  isClassic: false,
  id: 'item-event',
});

function apply(ctx: ReturnType<typeof makeContext>, state: State, action: Action) {
  const applied = applyAction(ctx, state, action);
  if (!applied) throw new Error(`action impossible : ${JSON.stringify(action)}`);
  return applied.state;
}

describe('heure du jeu', () => {
  it('bascule à minuit, heure de Paris', () => {
    expect(gameClock(new Date('2026-10-11T21:59:00Z')).date).toBe('2026-10-11');
    expect(gameClock(new Date('2026-10-11T22:01:00Z')).date).toBe('2026-10-12');
  });

  it('crédite deux ascensions par jour à midi, cumulables (source : /vortex)', () => {
    expect(ascensionCredits('2026-10-05', '2026-10-19', new Date('2026-10-05T09:00:00Z'))).toBe(0);
    expect(ascensionCredits('2026-10-05', '2026-10-19', new Date('2026-10-05T10:30:00Z'))).toBe(2);
    expect(ascensionCredits('2026-10-05', '2026-10-19', new Date('2026-10-11T12:00:00Z'))).toBe(14);
    expect(ascensionCredits('2026-10-05', '2026-10-19', new Date('2026-10-25T12:00:00Z'))).toBe(0);
  });
});

describe('/journa et /bonus', () => {
  it('applique les bonus de corporation et d’abonnement', () => {
    const ctx = makeContext(
      makeCatalog([r1]),
      makePlayer({
        loot: [{ date: '2026-10-10', daily: 1, weekly: 0 }],
        subscribed: true,
        corporation: { id: 'c', name: 'Corpo', bonuses: { LOOT: 4 } },
      }),
    );
    const s = apply(ctx, initialState(ctx), { kind: 'daily' });
    // 1000 + (4+3+2+1)×10 de corporation + 200 d'abonnement.
    expect(s.balances.balance).toBe(1300);
    expect(s.balances.loreDust).toBe(10);
    expect(applyAction(ctx, s, { kind: 'daily' })).toBeNull();
  });

  it('débloque /bonus tous les 7 /journa', () => {
    const loot = [
      { date: '2026-10-03', daily: 1, weekly: 1 },
      ...['04', '05', '06', '07', '08', '09'].map((d) => ({
        date: `2026-10-${d}`,
        daily: 1,
        weekly: 0,
      })),
    ];
    const ctx = makeContext(makeCatalog([r1]), makePlayer({ loot }));
    const s0 = initialState(ctx);
    expect(s0.dailiesSinceWeekly).toBe(6);
    expect(applyAction(ctx, s0, { kind: 'weekly' })).toBeNull();
    const s1 = apply(ctx, s0, { kind: 'daily' });
    const s2 = apply(ctx, s1, { kind: 'weekly' });
    expect(s2.balances.balance).toBe(2000);
    expect(s2.dailiesSinceWeekly).toBe(0);
  });
});

describe('recyclage', () => {
  it('rapporte la valeur de la config, bonus de corporation compris', () => {
    const ctx = makeContext(
      makeCatalog([r4]),
      makePlayer({ corporation: { id: 'c', name: 'Corpo', bonuses: { RECYCLE_LORE_DUST: 4 } } }),
    );
    expect(recycleGain(ctx, r4, 0)).toEqual({ loreDust: 440 });
    expect(recycleGain(ctx, r4, 1)).toEqual({ loreDust: 2200 });
  });

  it("paie les cartes d'évènement en cristaux", () => {
    const ctx = makeContext(makeCatalog([event]), makePlayer());
    expect(recycleGain(ctx, event, 0)).toEqual({ loreFragment: 5 });
  });

  it('rembourse une carte fusion au prix de ses composants (source : /forge)', () => {
    const fusionCard = makeItem(5001, { rarity: 5, isFusion: true, upgradable: false });
    const catalog = makeCatalog([r1, r2, fusionCard], {
      fusions: [
        {
          resultId: fusionCard.id,
          inputs: [
            { itemId: r1.id, quantity: 2 },
            { itemId: r2.id, quantity: 1 },
          ],
        },
      ],
    });
    const ctx = makeContext(catalog, makePlayer());
    expect(recycleGain(ctx, fusionCard, 0)).toEqual({ loreDust: 2 * 5 + 20 });
  });

  it('refuse de recycler une carte encore utile', () => {
    const ctx = makeContext(
      makeCatalog([r1]),
      makePlayer({ inventory: Object.fromEntries([owned(r1.id, 0, 2)]) }),
    );
    // 2 exemplaires : 1 gardé + 1 réservé à la constellation (rareté 1) → aucun surplus.
    expect(
      applyAction(ctx, initialState(ctx), {
        kind: 'recycle',
        cards: [{ itemId: r1.id, shiny: 0, count: 1 }],
      }),
    ).toBeNull();
  });
});

describe('réserve', () => {
  it('protège les exemplaires utiles aux fusions, constellations et enchantements', () => {
    const fusionCard = makeItem(5001, { rarity: 5, isFusion: true });
    const catalog = makeCatalog([r4, fusionCard], {
      fusions: [{ resultId: fusionCard.id, inputs: [{ itemId: r4.id, quantity: 2 }] }],
    });
    const ctx = makeContext(
      catalog,
      makePlayer({ inventory: Object.fromEntries([owned(r4.id, 0, 3, 1)]) }),
    );
    expect(reserveFor(ctx, initialState(ctx), r4.id, 0)).toEqual({
      keep: 1,
      fusion: 2,
      // La dorée, puis 4 dorées pour sa constellation (rareté 4) et 2 pour la fusion dorée.
      enchant: 7,
      constellation: 3,
    });
  });

  it('garde les normaux à enchanter pour une fusion dorée, même avec la fusion normale', () => {
    // Le puzzle : 100 pièces (sans constellation) pour la fusion, déjà faite en normal.
    const piece = makeItem(1139, { upgradable: false });
    const puzzle = makeItem(2129, { isFusion: true, upgradable: false });
    const catalog = makeCatalog([piece, puzzle], {
      fusions: [{ resultId: puzzle.id, inputs: [{ itemId: piece.id, quantity: 100 }] }],
    });
    const player = makePlayer({
      inventory: Object.fromEntries([
        owned(piece.id, 0, 18),
        owned(piece.id, 1, 1),
        owned(puzzle.id, 0, 1),
      ]),
    });
    const ctx = makeContext(catalog, player);
    // La dorée gardée + 100 pour la fusion dorée, moins celle possédée : rien n'est recyclable.
    expect(reserveFor(ctx, initialState(ctx), piece.id, 0)).toEqual({
      keep: 1,
      fusion: 0,
      enchant: 100,
      constellation: 0,
    });
    // Chaque case ne garde que pour son propre usage.
    const noConstellation = makeContext(catalog, player, { keepForGolden: false });
    expect(reserveFor(noConstellation, initialState(noConstellation), piece.id, 0).enchant).toBe(
      100,
    );
    const noFusion = makeContext(catalog, player, { keepForGoldenFusions: false });
    expect(reserveFor(noFusion, initialState(noFusion), piece.id, 0).enchant).toBe(0);
  });

  it('garde les normaux à enchanter pour la constellation dorée, même avec la dorée', () => {
    const ctx = makeContext(
      makeCatalog([r2]),
      makePlayer({
        inventory: Object.fromEntries([owned(r2.id, 0, 6, 2), owned(r2.id, 1, 1, 0)]),
      }),
    );
    // Dorée possédée, constellation dorée à 0 : 2 dorées à obtenir, donc 2 normaux à garder.
    expect(reserveFor(ctx, initialState(ctx), r2.id, 0)).toEqual({
      keep: 1,
      fusion: 0,
      enchant: 2,
      constellation: 0,
    });
    // Option désactivée : la dorée est déjà là, plus rien n'est gardé pour l'enchantement.
    const without = makeContext(makeCatalog([r2]), ctx.player, {
      keepForGolden: false,
    });
    expect(reserveFor(without, initialState(without), r2.id, 0).enchant).toBe(0);
  });
});

describe('forge', () => {
  it('crée et enchante en payant la bonne monnaie', () => {
    const ctx = makeContext(
      makeCatalog([r2]),
      makePlayer({ balances: { balance: 0, loreDust: 1000, loreFragment: 0, upgradeDust: 0 } }),
    );
    let s = apply(ctx, initialState(ctx), { kind: 'craft', itemId: r2.id });
    expect(s.balances.loreDust).toBe(900);
    s = apply(ctx, s, { kind: 'enchant', itemId: r2.id });
    expect(s.balances.loreDust).toBe(100);
    expect(getCard(s, r2.id, 0).copies).toBe(0);
    expect(getCard(s, r2.id, 1).copies).toBe(1);
  });

  it("n'autorise les cartes d'évènement que pendant le Vortex de leur groupe", () => {
    const season: Season = {
      id: 's',
      index: 1,
      begin: '2026-10-05',
      end: '2026-10-19',
      towerName: 'Ascension de la ZLAN 2021',
      group: 'ZLAN',
      packId: 'pack-zlan-2021',
      floors: [],
    };
    const balances = { balance: 0, loreDust: 0, loreFragment: 1000, upgradeDust: 0 };
    const closed = makeContext(makeCatalog([event]), makePlayer({ balances }));
    expect(
      applyAction(closed, initialState(closed), { kind: 'craft', itemId: event.id }),
    ).toBeNull();

    // Le groupe « ZLAN » ouvre la forge à toutes les ZLAN, pas seulement au pack de la tour.
    const open = makeContext(
      makeCatalog([event], {
        season,
        towers: [
          { name: 'ZLAN 2021', group: 'ZLAN', packId: 'pack-zlan-2021' },
          { name: 'ZLAN 2024', group: 'ZLAN', packId: 'pack-zlan' },
        ],
      }),
      makePlayer({ balances }),
    );
    expect(
      apply(open, initialState(open), { kind: 'craft', itemId: event.id }).balances.loreFragment,
    ).toBe(950);
  });

  it('ne crée ni fusion ni STAR', () => {
    const star = makeItem(6001, { rarity: 6, isStar: true });
    const ctx = makeContext(
      makeCatalog([star]),
      makePlayer({ balances: { balance: 0, loreDust: 1e6, loreFragment: 0, upgradeDust: 0 } }),
    );
    expect(applyAction(ctx, initialState(ctx), { kind: 'craft', itemId: star.id })).toBeNull();
  });
});

describe('constellation', () => {
  it('consomme un doublon, monte d’un niveau, rapporte 1 éclat et des points', () => {
    const ctx = makeContext(
      makeCatalog([r4]),
      makePlayer({ inventory: Object.fromEntries([owned(r4.id, 0, 5)]) }),
    );
    let s = initialState(ctx);
    const before = s.points;
    for (let level = 1; level <= 4; level++)
      s = apply(ctx, s, { kind: 'constellation', itemId: r4.id, shiny: 0 });
    expect(getCard(s, r4.id, 0)).toMatchObject({ copies: 1, constellation: 4 });
    expect(s.balances.upgradeDust).toBe(4);
    // Points = points de base × niveau × 2 (source : /constellations).
    expect(s.points - before).toBe(80 * 4 * 2);
    // Niveau maximum = rareté.
    expect(applyAction(ctx, s, { kind: 'constellation', itemId: r4.id, shiny: 0 })).toBeNull();
  });

  it('ne consomme jamais le dernier exemplaire', () => {
    const ctx = makeContext(
      makeCatalog([r1]),
      makePlayer({ inventory: Object.fromEntries([owned(r1.id, 0, 1)]) }),
    );
    expect(
      applyAction(ctx, initialState(ctx), { kind: 'constellation', itemId: r1.id, shiny: 0 }),
    ).toBeNull();
  });
});

describe('fusion', () => {
  it('consomme les composants en gardant un exemplaire de chacun', () => {
    const result = makeItem(5001, { rarity: 5, isFusion: true });
    const catalog = makeCatalog([r1, r2, result], {
      fusions: [
        {
          resultId: result.id,
          inputs: [
            { itemId: r1.id, quantity: 1 },
            { itemId: r2.id, quantity: 1 },
          ],
        },
      ],
    });
    const short = makeContext(
      catalog,
      makePlayer({ inventory: Object.fromEntries([owned(r1.id, 0, 2), owned(r2.id, 0, 1)]) }),
    );
    expect(
      applyAction(short, initialState(short), { kind: 'fusion', itemId: result.id, shiny: 0 }),
    ).toBeNull();

    const ctx = makeContext(
      catalog,
      makePlayer({ inventory: Object.fromEntries([owned(r1.id, 1, 2), owned(r2.id, 1, 2)]) }),
    );
    const s = apply(ctx, initialState(ctx), { kind: 'fusion', itemId: result.id, shiny: 1 });
    expect(getCard(s, result.id, 1).copies).toBe(1);
    expect(getCard(s, r1.id, 1).copies).toBe(1);
  });
});

describe('évolution', () => {
  it('remplace la carte Évolution par la suivante contre des éclats', () => {
    const steps = [makeItem(1138, { rarity: 1 }), makeItem(2138, { rarity: 2 })];
    const ctx = makeContext(
      makeCatalog(steps),
      makePlayer({
        balances: { balance: 0, loreDust: 0, loreFragment: 0, upgradeDust: 50 },
        inventory: Object.fromEntries([owned(steps[0]!.id, 0, 1)]),
        evolution: {
          costs: [40],
          steps: steps.map((i, n) => ({
            itemId: i.id,
            name: i.name,
            rarity: i.rarity,
            score: i.scores[0],
            owned: n === 0,
          })),
        },
      }),
    );
    const s = apply(ctx, initialState(ctx), {
      kind: 'evolution',
      fromItemId: steps[0]!.id,
      toItemId: steps[1]!.id,
    });
    expect(s.balances.upgradeDust).toBe(10);
    expect(getCard(s, steps[0]!.id, 0).copies).toBe(0);
    expect(getCard(s, steps[1]!.id, 0).copies).toBe(1);
  });
});

describe('défis', () => {
  it('encaisse la récompense une seule fois', () => {
    const ctx = makeContext(
      makeCatalog([r1]),
      makePlayer({
        balances: { balance: 0, loreDust: 200, loreFragment: 0, upgradeDust: 0 },
        challenges: [
          {
            id: 'c',
            type: 'CRAFT',
            description: 'Créer une carte',
            rewardLoreDust: 50,
            score: 10,
            current: 0,
            max: 1,
            action: 'craft',
          },
        ],
      }),
    );
    let s = apply(ctx, initialState(ctx), { kind: 'craft', itemId: r1.id });
    expect(s.balances.loreDust).toBe(200 - 50 + 50);
    s = apply(ctx, s, { kind: 'craft', itemId: r1.id });
    expect(s.balances.loreDust).toBe(150);
  });
});

describe('immutabilité', () => {
  it("n'altère ni l'état de départ ni le joueur (régression : cache mémoire global)", () => {
    const player = makePlayer({
      balances: { balance: 5000, loreDust: 1000, loreFragment: 0, upgradeDust: 0 },
      inventory: Object.fromEntries([owned(r1.id, 0, 3)]),
    });
    const snapshot = JSON.stringify(player);
    const ctx = makeContext(makeCatalog([r1]), player);
    const s0 = initialState(ctx);
    apply(ctx, s0, { kind: 'invoke', booster: 'basic' });
    apply(ctx, s0, { kind: 'constellation', itemId: r1.id, shiny: 0 });
    expect(s0.balances.balance).toBe(5000);
    expect(getCard(s0, r1.id, 0).copies).toBe(3);
    expect(JSON.stringify(player)).toBe(snapshot);
  });
});

describe('ascension', () => {
  const season: Season = {
    id: 's',
    index: 1,
    begin: '2026-10-05',
    end: '2026-10-19',
    towerName: 'Ascension du Manoir Nougaret',
    group: 'Classique',
    packId: 'pack-classic',
    floors: Array.from({ length: 6 }, () => ({ rate: 0.5, drops: [] })),
  };
  const ctx = (floorsClimbed: number) =>
    makeContext(
      makeCatalog([], { season }),
      makePlayer({
        balances: { balance: 0, loreDust: 1000, loreFragment: 0, upgradeDust: 0 },
        tower: { floorsClimbed, logCount: 7 },
      }),
    );

  it("tente l'étage suivant le dernier atteint", () => {
    const c = ctx(5);
    expect(applyAction(c, initialState(c), { kind: 'ascension' })?.note).toMatch(/^étage 6,/);
  });

  it("ne propose plus d'ascension une fois le sommet atteint", () => {
    const c = ctx(6);
    expect(applyAction(c, initialState(c), { kind: 'ascension' })).toBeNull();
  });
});
