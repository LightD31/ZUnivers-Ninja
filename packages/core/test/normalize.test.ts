import { describe, expect, it } from 'vitest';
import {
  challengeActionFor,
  normalizeFusion,
  normalizeInventory,
  normalizeLoot,
  type ApiInventoryEntry,
} from '../src';
import { fixtureCatalog, fixturePlayer, rawCatalog } from './helpers';

const item = rawCatalog().items[0]!;
const entry = (quantity: number, shinyLevel: number, upgradeLevel: number): ApiInventoryEntry =>
  ({ item, quantity, shinyLevel, upgradeLevel }) as ApiInventoryEntry;

describe('inventaire', () => {
  it('sépare les cartes Constellation des exemplaires utilisables (régression)', () => {
    // L'ancienne version rangeait toute ligne `upgradeLevel > 0` dans un inventaire à part et
    // lisait le niveau comme « niveaux restants ».
    const inventory = normalizeInventory([entry(3, 0, 0), entry(1, 0, 2), entry(1, 1, 0)]);
    expect(inventory[`${item.id}:0`]).toEqual({
      itemId: item.id,
      shiny: 0,
      copies: 3,
      constellation: 2,
    });
    expect(inventory[`${item.id}:1`]).toEqual({
      itemId: item.id,
      shiny: 1,
      copies: 1,
      constellation: 0,
    });
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
