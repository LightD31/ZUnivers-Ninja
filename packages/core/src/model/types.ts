/**
 * Modèle normalisé, indépendant du format brut de l'API.
 * Tout est sérialisable en JSON (objets simples, pas de Map/Set) pour pouvoir être mis en cache
 * ou transféré vers un Web Worker.
 */

/** 0 = normale, 1 = dorée, 2 = chromatique. */
export type Shiny = 0 | 1 | 2;
export const SHINIES: readonly Shiny[] = [0, 1, 2];
export const SHINY_SUFFIX: Record<Shiny, string> = { 0: '', 1: '+', 2: '*' };
export const SHINY_LABEL: Record<Shiny, string> = { 0: 'Normale', 1: 'Dorée', 2: 'Chroma' };

export type Currency = 'balance' | 'loreDust' | 'loreFragment' | 'upgradeDust';
export const CURRENCIES: readonly Currency[] = [
  'balance',
  'loreDust',
  'loreFragment',
  'upgradeDust',
];
export const CURRENCY_LABEL: Record<Currency, string> = {
  balance: 'ZUMonnaie',
  loreDust: 'Poudre créatrice',
  loreFragment: "Cristaux d'histoire",
  upgradeDust: "Éclats d'étoile",
};
export type Balances = Record<Currency, number>;

export const CLASSIC_PACK_SLUG = 'classique';
export const STAR_RARITY = 6;

export interface Item {
  id: string;
  /** Numéro de la carte, utilisé dans les commandes Discord (ex : 4018). */
  identifier: number;
  name: string;
  slug: string;
  genre: string;
  rarity: number;
  packId: string;
  packName: string;
  packSlug: string;
  packYear: number | null;
  /** URLs des visuels : [normale, dorée, chroma pimpée, chroma]. */
  urls: string[];
  /** Points de collection pour chaque niveau de brillance. */
  scores: [number, number, number];
  /** Niveaux de brillance existants pour cette carte. */
  shinyAvailable: [boolean, boolean, boolean];
  recyclable: boolean;
  tradable: boolean;
  counting: boolean;
  craftable: boolean;
  invocable: boolean;
  goldable: boolean;
  upgradable: boolean;
  /** Carte résultat d'une fusion. */
  isFusion: boolean;
  isStar: boolean;
  isClassic: boolean;
}

export interface FusionInput {
  itemId: string;
  quantity: number;
}

export interface Fusion {
  resultId: string;
  inputs: FusionInput[];
}

export interface RarityConfig {
  recycle: number;
  craft: number;
}

export interface GameEvent {
  id: string;
  name: string;
  packId: string | null;
  packSlug: string | null;
  packName: string | null;
  balanceCost: number;
  loreDustCost: number;
  oneTime: boolean;
  active: boolean;
  invokeCount: number;
  begin: string;
  end: string;
  /** Cartes mises en avant par l'évènement. */
  itemIds: string[];
}

export interface TowerFloor {
  /** Chance de réussite, entre 0 et 1. */
  rate: number;
  /** Taux de drop de la carte en récompense, entre 0 et 1. */
  drops: { rarity: number; shiny: Shiny; rate: number }[];
}

export interface Season {
  id: string;
  index: number;
  /** Dates au format AAAA-MM-JJ. */
  begin: string;
  end: string;
  towerName: string;
  group: string;
  packId: string;
  floors: TowerFloor[];
}

export interface TowerInfo {
  name: string;
  group: string;
  packId: string;
}

export interface Settings {
  dailyReward: number;
  weeklyReward: number;
  dailyLoreDust: number;
  features: string[];
}

export interface Catalog {
  fetchedAt: string;
  ruleSet: string;
  settings: Settings;
  items: Record<string, Item>;
  fusions: Fusion[];
  /** config[rareté][brillance] */
  config: Record<number, Partial<Record<Shiny, RarityConfig>>>;
  events: GameEvent[];
  season: Season | null;
  towers: TowerInfo[];
}

export interface OwnedCard {
  itemId: string;
  shiny: Shiny;
  /** Exemplaires « vanilla » (hors carte Constellation). */
  copies: number;
  /** Niveau de la carte Constellation associée (0 = pas de constellation). */
  constellation: number;
}

/** Clé d'inventaire : `${itemId}:${shiny}`. */
export type CardKey = string;
export const cardKey = (itemId: string, shiny: Shiny): CardKey => `${itemId}:${shiny}`;

export type ChallengeAction =
  | 'loot'
  | 'weekly'
  | 'recycle'
  | 'craft'
  | 'enchant'
  | 'fusion'
  | 'constellation'
  | 'invoke'
  | 'invokeItems'
  | 'ascension'
  | 'evolution'
  | null;

export interface Challenge {
  id: string;
  type: string;
  description: string;
  rewardLoreDust: number;
  score: number;
  current: number;
  max: number;
  /** Action du planificateur qui fait progresser ce défi, `null` si non planifiable (échange…). */
  action: ChallengeAction;
}

export interface LootDay {
  date: string;
  daily: number;
  weekly: number;
}

export interface Player {
  id: string;
  discordId: string | null;
  name: string;
  displayName: string;
  avatar: string | null;
  ruleSet: string;
  balances: Balances;
  subscribed: boolean;
  corporation: { id: string; name: string; bonuses: Record<string, number> } | null;
  inventory: Record<CardKey, OwnedCard>;
  challenges: Challenge[];
  /** Historique des récompenses, trié par date croissante. */
  loot: LootDay[];
  lootStreak: number;
  /** Progression dans le Vortex de la saison en cours. */
  tower: { floorIndex: number; logCount: number } | null;
  evolution: {
    costs: number[];
    steps: { itemId: string; name: string; rarity: number; score: number; owned: boolean }[];
  } | null;
  tradesLeft: number;
  stats: { inventoryCount: number; uniqueCount: number; uniqueGoldenCount: number };
}
