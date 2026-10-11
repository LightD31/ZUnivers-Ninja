import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChallengesSchema,
  CorporationSchema,
  EventsSchema,
  EvolutionSchema,
  FusionSchema,
  InventorySchema,
  ItemSchema,
  LootSchema,
  RecycleConfigSchema,
  SettingsSchema,
  TowerSeasonSchema,
  TowersSchema,
  UserSchema,
  UserTowerSchema,
  normalizeCatalog,
  normalizePlayer,
  type RawCatalog,
  type RawPlayer,
} from '../src';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));

/** Fixtures validées par les schémas, exactement comme une réponse de l'API. */
export function rawCatalog(): RawCatalog {
  const c = read('catalog.json');
  return {
    settings: SettingsSchema.parse(c.settings),
    items: ItemSchema.array().parse(c.items),
    fusions: FusionSchema.array().parse(c.fusions),
    config: RecycleConfigSchema.parse(c.config),
    events: EventsSchema.parse(c.events),
    season: c.season ? TowerSeasonSchema.parse(c.season) : null,
    towers: TowersSchema.parse(c.towers),
  };
}

export function rawPlayer(): RawPlayer {
  const p = read('player.json');
  return {
    user: UserSchema.parse(p.user),
    inventory: InventorySchema.parse(p.inventory),
    challenges: ChallengesSchema.parse(p.challenges),
    loot: LootSchema.parse(p.loot),
    tower: UserTowerSchema.parse(p.tower),
    evolution: p.evolution ? EvolutionSchema.parse(p.evolution) : null,
    corporation: p.corporation ? CorporationSchema.parse(p.corporation) : null,
  };
}

/** Instant de référence : le jour de l'enregistrement des fixtures, à 14 h (heure de Paris). */
export const NOW = new Date('2026-10-11T12:00:00Z');

export const fixtureCatalog = () => normalizeCatalog(rawCatalog(), 'NORMAL', NOW);
export const fixturePlayer = () => normalizePlayer(rawPlayer());
