/**
 * Enregistre un instantané de l'API pour les tests :
 *   pnpm fixtures [pseudo]
 * Les champs lourds et inutiles aux tests (descriptions, visuels…) sont retirés.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../src/api/client';
import { fetchRawCatalog, fetchRawPlayer } from '../src/model/fetch';

const name = process.argv[2] ?? 'alexpresso';
const dir = join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures');
mkdirSync(dir, { recursive: true });

const HEAVY = new Set(['corporationLogs', 'userCorporations']);
/** Champs lourds des fiches de cartes (on garde la première URL de visuel). */
const ITEM_HEAVY = new Set(['description', 'reference']);
function strip(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    // Les statistiques de Vortex embarquent la liste complète des cartes de chaque saison.
    if (key === 'items' && value.length > 0 && (value[0] as { towerName?: string }).towerName)
      return [];
    return value.map((v) => strip(v));
  }
  if (value && typeof value === 'object') {
    const isItem = 'identifier' in value && 'rarity' in value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !HEAVY.has(k) && !(isItem && ITEM_HEAVY.has(k)))
        .map(([k, v]) => [k, isItem && k === 'urls' ? (v as string[]).slice(0, 1) : v] as const)
        .map(([k, v]) => [
          k,
          k === 'towerStats' ? (v as object[]).map((s) => ({ ...s, items: [] })) : strip(v, k),
        ]),
    );
  }
  return value;
}

const client = createClient({ userAgent: 'github.com/alexpresso/zunivers-ninja (fixtures)' });
const catalog = await fetchRawCatalog(client);
const player = await fetchRawPlayer(client, name);
const write = (file: string, data: unknown) =>
  writeFileSync(join(dir, file), JSON.stringify(strip(data)) + '\n');
write('catalog.json', catalog);
write('player.json', player);
console.log(`Fixtures enregistrées dans ${dir} (joueur : ${name}).`);
