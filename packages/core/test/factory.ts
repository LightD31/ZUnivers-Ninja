import {
  buildContext,
  resolveOptions,
  type Catalog,
  type Item,
  type OwnedCard,
  type Player,
  type PlannerOptionsInput,
  type Shiny,
} from '../src';

/** Scores officiels par rareté (normale, dorée, chroma). */
const SCORES: Record<number, [number, number, number]> = {
  1: [1, 60, 130],
  2: [5, 80, 200],
  3: [20, 100, 300],
  4: [80, 200, 500],
  5: [300, 900, 2000],
};

export function makeItem(identifier: number, overrides: Partial<Item> = {}): Item {
  const rarity = overrides.rarity ?? Math.max(1, Math.floor(identifier / 1000));
  return {
    id: `item-${identifier}`,
    identifier,
    name: `Carte ${identifier}`,
    slug: String(identifier),
    genre: 'Objet',
    rarity,
    packId: 'pack-classic',
    packName: 'Classique',
    packSlug: 'classique',
    packYear: null,
    urls: [],
    scores: SCORES[rarity] ?? [0, 0, 0],
    shinyAvailable: [true, true, true],
    recyclable: true,
    tradable: true,
    counting: true,
    craftable: true,
    invocable: true,
    goldable: true,
    upgradable: true,
    isFusion: false,
    isStar: false,
    isClassic: true,
    ...overrides,
  };
}

export function makeCatalog(items: Item[], overrides: Partial<Catalog> = {}): Catalog {
  return {
    fetchedAt: '2026-10-11T00:00:00.000Z',
    ruleSet: 'NORMAL',
    settings: { dailyReward: 1000, weeklyReward: 1000, dailyLoreDust: 10, features: [] },
    items: Object.fromEntries(items.map((i) => [i.id, i])),
    fusions: [],
    config: {
      1: {
        0: { recycle: 5, craft: 50 },
        1: { recycle: 100, craft: 400 },
        2: { recycle: 250, craft: 0 },
      },
      2: {
        0: { recycle: 20, craft: 100 },
        1: { recycle: 200, craft: 800 },
        2: { recycle: 500, craft: 0 },
      },
      3: {
        0: { recycle: 100, craft: 500 },
        1: { recycle: 600, craft: 1600 },
        2: { recycle: 1337, craft: 0 },
      },
      4: {
        0: { recycle: 400, craft: 2000 },
        1: { recycle: 2000, craft: 4000 },
        2: { recycle: 5000, craft: 0 },
      },
    },
    events: [],
    season: null,
    towers: [],
    ...overrides,
  };
}

export function owned(
  itemId: string,
  shiny: Shiny,
  copies: number,
  constellation = 0,
): [string, OwnedCard] {
  return [`${itemId}:${shiny}`, { itemId, shiny, copies, constellation }];
}

export function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 'player',
    discordId: null,
    name: 'testeur',
    displayName: 'Testeur',
    avatar: null,
    ruleSet: 'NORMAL',
    balances: { balance: 0, loreDust: 0, loreFragment: 0, upgradeDust: 0 },
    subscribed: false,
    corporation: null,
    inventory: {},
    challenges: [],
    // Journa déjà fait aujourd'hui, bonus récent : aucune récompense automatique par défaut.
    loot: [{ date: '2026-10-11', daily: 1, weekly: 1 }],
    lootStreak: 1,
    tower: null,
    evolution: null,
    tradesLeft: 2,
    invokeBeforePity: null,
    stats: { inventoryCount: 0, uniqueCount: 0, uniqueGoldenCount: 0 },
    ...overrides,
  };
}

/** 14 h à Paris. */
export const TEST_NOW = new Date('2026-10-11T12:00:00Z');

export function makeContext(catalog: Catalog, player: Player, options: PlannerOptionsInput = {}) {
  return buildContext(catalog, player, TEST_NOW, resolveOptions(options));
}
