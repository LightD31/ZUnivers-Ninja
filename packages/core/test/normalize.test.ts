import { describe, expect, it } from 'vitest';
import {
  challengeActionFor,
  constellationLevel,
  normalizeCatalog,
  normalizeFusion,
  normalizeInventory,
  normalizeLoot,
  normalizePlayer,
  UserTowerSchema,
  type ApiInventoryEntry,
} from '../src';
import { fixtureCatalog, fixturePlayer, rawCatalog, rawPlayer } from './helpers';

const item = { ...rawCatalog().items[0]!, rarity: 3 };
const entry = (quantity: number, shinyLevel: number, upgradeLevel: number): ApiInventoryEntry =>
  ({ item, quantity, shinyLevel, upgradeLevel }) as ApiInventoryEntry;

describe('saison Hardcore', () => {
  const settings = (done: boolean | undefined) => ({
    ...rawCatalog(),
    settings: { ...rawCatalog().settings, lastHardcoreSeasonDone: done },
  });

  it('ferme le mode Hardcore quand la dernière saison est terminée', () => {
    expect(normalizeCatalog(settings(true), 'HARDCORE').settings.closed).toBe(true);
    expect(normalizeCatalog(settings(false), 'HARDCORE').settings.closed).toBe(false);
    // Information absente : le mode reste ouvert.
    expect(normalizeCatalog(settings(undefined), 'HARDCORE').settings.closed).toBe(false);
  });

  it('ne ferme jamais le mode Normal', () => {
    expect(normalizeCatalog(settings(true), 'NORMAL').settings.closed).toBe(false);
  });
});

describe('inventaire', () => {
  it('sépare les cartes Constellation des exemplaires utilisables', () => {
    // Rareté 3, `upgradeLevel` 3 : premier niveau de constellation sur 3.
    const inventory = normalizeInventory([entry(3, 0, 0), entry(1, 0, 3), entry(1, 1, 0)]);
    expect(inventory[`${item.id}:0`]).toEqual({
      itemId: item.id,
      shiny: 0,
      copies: 3,
      constellation: 1,
    });
    expect(inventory[`${item.id}:1`]).toEqual({
      itemId: item.id,
      shiny: 1,
      copies: 1,
      constellation: 0,
    });
  });

  it('lit le niveau de constellation à rebours, comme le site ZUnivers (régression)', () => {
    // Joueur réel : la carte #2099 (rareté 2) avec `upgradeLevel` 1 est déjà au niveau 2/2, le
    // planificateur proposait une constellation de plus que le jeu refusait.
    expect([1, 2, 3].map((u) => constellationLevel(u, 3))).toEqual([3, 2, 1]);
    expect(constellationLevel(1, 2)).toBe(2);
    expect(constellationLevel(2, 2)).toBe(1);
    expect(constellationLevel(1, 1)).toBe(1);
    expect(constellationLevel(0, 4)).toBe(0);
    // Valeur hors bornes : au moins le premier niveau, jamais au-delà de la rareté.
    expect(constellationLevel(9, 2)).toBe(1);
    const inventory = normalizeInventory([entry(2, 0, 0), entry(1, 0, 1)]);
    expect(inventory[`${item.id}:0`]?.constellation).toBe(3);
  });

  it("gère l'ancien format isGolden", () => {
    const inventory = normalizeInventory([
      { item, quantity: 2, isGolden: true } as ApiInventoryEntry,
    ]);
    expect(inventory[`${item.id}:1`]?.copies).toBe(2);
  });

  it('ne crée aucune entrée fantôme', () => {
    const player = fixturePlayer();
    expect(Object.values(player.inventory).every((c) => c.copies > 0 || c.constellation > 0)).toBe(
      true,
    );
  });
});

describe('fusions', () => {
  it('compte les composants répétés', () => {
    const raw = rawCatalog().fusions[0]!;
    const doubled = { ...raw, items: [raw.items[0]!, raw.items[0]!, ...raw.items.slice(1)] };
    const fusion = normalizeFusion(doubled);
    expect(fusion.inputs.find((i) => i.itemId === raw.items[0]!.id)?.quantity).toBe(2);
  });

  it('marque les cartes fusion dans le catalogue', () => {
    const catalog = fixtureCatalog();
    for (const f of catalog.fusions) expect(catalog.items[f.resultId]?.isFusion).toBe(true);
  });
});

describe('historique des récompenses', () => {
  it('trie les jours chronologiquement (régression : HashMap non ordonnée)', () => {
    const loot = normalizeLoot({
      '2026-10-03': [{ amount: 1000, type: 'DAILY' }],
      '2026-09-28': [
        { amount: 1000, type: 'WEEKLY' },
        { amount: 1000, type: 'DAILY' },
      ],
      '2026-10-01': [{ amount: 1000, type: 'DAILY' }],
    });
    expect(loot.map((d) => d.date)).toEqual(['2026-09-28', '2026-10-01', '2026-10-03']);
    expect(loot[0]).toEqual({ date: '2026-09-28', daily: 1, weekly: 1 });
  });
});

describe('défis', () => {
  it.each([
    ['CRAFT', 'Créer une carte', 'craft'],
    ['RECYCLE', 'Recycler pour 200 poudres et/ou cristaux', 'recycle'],
    ['TRADE', 'Échanger 2 fois', null],
    ['UPGRADE', 'Améliorer 3 constellations', 'constellation'],
    ['UPGRADE', 'Enchanter une carte', 'enchant'],
    ['FUSE', 'Faire une fusion', 'fusion'],
    ['ASCEND', 'Faire 2 ascensions', 'ascension'],
  ])('%s « %s » → %s', (type, description, expected) => {
    expect(challengeActionFor(type, description)).toBe(expected);
  });
});

describe('joueur', () => {
  it('lit les bonus de corporation et la saison de Vortex', () => {
    const player = fixturePlayer();
    expect(player.corporation?.bonuses.LOOT).toBe(4);
    expect(player.evolution?.steps).toHaveLength(5);
    expect(player.loot.length).toBeGreaterThan(10);
    const catalog = fixtureCatalog();
    expect(catalog.season?.group).toBe('Classique');
    expect(catalog.config[4]?.[1]).toEqual({ recycle: 2000, craft: 4000 });
  });
});

describe('Vortex', () => {
  const tower = (stat: Record<string, unknown>) =>
    normalizePlayer({
      ...rawPlayer(),
      tower: UserTowerSchema.parse({
        towerStats: [
          {
            towerLogCount: 7,
            isCurrentTowerSeason: true,
            towerSeasonBeginDate: '2026-10-05',
            towerSeasonEndDate: '2026-10-19',
            ...stat,
          },
        ],
      }),
    }).tower;

  it('compte les étages gravis : maxFloorIndex est le dernier étage atteint', () => {
    // Comme le site ZUnivers : maxFloorIndex 0 = étage 1 atteint, 5 = sommet.
    expect(tower({ maxFloorIndex: 0 })).toEqual({ floorsClimbed: 1, logCount: 7 });
    expect(tower({ maxFloorIndex: 5 })).toEqual({ floorsClimbed: 6, logCount: 7 });
    // Pas encore entré (« Dehors »).
    expect(tower({ maxFloorIndex: null })).toEqual({ floorsClimbed: 0, logCount: 7 });
    expect(tower({})).toEqual({ floorsClimbed: 0, logCount: 7 });
  });
});
