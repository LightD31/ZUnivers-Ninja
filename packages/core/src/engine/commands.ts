import { SHINY_SUFFIX, type Shiny } from '../model/types';
import type { ActionKind } from './actions';

/**
 * Longueur maximale d'une ligne de commande. Au-delà, le bot du jeu ne l'exécute pas et répond
 * « Je ne suis pas sûre d'avoir pris en compte ton action » : une commande de 3 962 caractères a
 * échoué, une de 2 020 est passée (vérifié en jeu le 12/10/2026).
 */
export const COMMAND_MAX_LENGTH = 2000;

/** Séparateur des cartes d'une commande (`/recyclage carte:1001 + 1002`). */
export const CARD_SEPARATOR = ' + ';

const COMMAND: Record<ActionKind, string> = {
  daily: 'journa',
  weekly: 'bonus',
  recycle: 'recyclage',
  craft: 'création',
  enchant: 'enchantement',
  fusion: 'fusion',
  constellation: 'constellation',
  invoke: 'im',
  ascension: 'as',
  evolution: 'évolution',
};

/**
 * Option nommée de chaque commande Discord : collée telle quelle (`/im évènement:chroma`,
 * `/recyclage carte:1001 + 1002`), une commande remplit directement son option. `/journa`,
 * `/bonus` et `/as` n'en ont pas.
 */
const OPTION: Partial<Record<ActionKind, string>> = {
  invoke: 'évènement',
  recycle: 'carte',
  craft: 'carte',
  enchant: 'carte',
  fusion: 'carte',
  constellation: 'carte',
  evolution: 'carte',
};

/** Début d'une commande avant ses arguments (`/recyclage carte:`). */
export function commandPrefix(kind: ActionKind): string {
  const option = OPTION[kind];
  return `/${COMMAND[kind]} ${option ? `${option}:` : ''}`;
}

/** Ligne de commande Discord (`/commande option:valeur`), ou `/commande` seule sans argument. */
export function commandLine(kind: ActionKind, args: string): string {
  return args ? `${commandPrefix(kind)}${args}` : `/${COMMAND[kind]}`;
}

/**
 * Référence d'une carte dans une commande : numéro + suffixe de brillance (`+` dorée, `*` chroma).
 * /enchantement prend la carte normale à transformer. Les quantités sont écrites en répétant la
 * carte, pour éviter toute ambiguïté avec `*`.
 */
export function cardToken(identifier: number, shiny: Shiny, kind?: ActionKind): string {
  return `${identifier}${kind === 'enchant' ? '' : SHINY_SUFFIX[shiny]}`;
}
