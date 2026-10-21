/**
 * Constantes du jeu qui ne sont pas exposées par l'API.
 * Sources : https://zunivers.zerator.com/commandes, /boosters, /vortex, /constellations, /abonnement.
 */

export const GAME_TIMEZONE = 'Europe/Paris';

/**
 * /journa : ZUMonnaie supplémentaire pour les abonnés, 30 fois par abonnement (source : /abonnement,
 * « pour un total de 6 000 »). Pas sur /bonus : l'historique des récompenses l'indique à 0.
 */
export const SUBSCRIPTION_LOOT_BONUS = 200;
/** /bonus se débloque tous les 7 /journa (source : /commandes). */
export const WEEKLY_EVERY_DAILIES = 7;

/**
 * /as : coût en poudre, cristaux d'histoire reçus en cas d'échec, essais par jour crédités à midi
 * (source : /vortex).
 */
export const ASCENSION_COST = 20;
export const ASCENSION_FAIL_CRYSTALS = 4;
export const ASCENSIONS_PER_DAY = 2;
export const ASCENSION_CREDIT_HOUR = 12;

/** Une saison de Vortex dure deux semaines, du lundi au lundi (source : /public/tower/season). */
export const SEASON_DAYS = 14;

/**
 * Ordre des groupes de Vortex observé depuis la saison 93 (13/10/2025) : 16 transitions sur 18,
 * les deux autres à l'arrivée de la tour ZLAN 2026. L'API ne donne que la saison en cours : cet
 * ordre sert de règle par défaut quand l'historique du joueur ne suffit pas à prévoir la suite.
 */
export const VORTEX_ROTATION: readonly string[] = ['Classique', 'Autres', 'ZLAN', 'ZEvent'];

/** Réputation gagnée par tentative (non cumulable) : /as, /as réussie, étage 6 atteint (source : /vortex). */
export const REPUTATION_ATTEMPT = 50;
export const REPUTATION_SUCCESS = 300;
export const REPUTATION_TOP_FLOOR = 1000;
/** Réputation perdue à la fin d'une saison sans aucun étage gravi (source : /vortex). */
export const REPUTATION_NO_FLOOR = 1000;

/** /constellation : éclats d'étoile gagnés par niveau (source : /constellations). */
export const CONSTELLATION_UPGRADE_DUST = 1;
/** Points d'une constellation = points de la carte × niveau × 2 (source : /constellations). */
export const CONSTELLATION_POINTS_FACTOR = 2;

/**
 * Abonnement premium (source : /abonnement) : 2 000 poudres pour 30 jours, le premier mois offert.
 * Il donne trois `/im premium` gratuites (10 jours d'attente entre deux), une carte dorée ★
 * d'évènement, et chaque jour 200 ZUMonnaie au /journa et un ticket Lucky Rayou.
 */
export const SUBSCRIPTION_COST_LORE_DUST = 2000;
export const SUBSCRIPTION_DAYS = 30;
export const SUBSCRIPTION_PREMIUM_INVOCATIONS = 3;
export const SUBSCRIPTION_PREMIUM_DAYS = 10;
/** Paramètre de `/im` de l'invocation premium des abonnés. */
export const PREMIUM_BOOSTER = 'premium';
/** Un ticket Lucky Rayou s'achète 100 ZUMonnaie (source : /tickets) : sa valeur au plus bas. */
export const LUCKY_TICKET_COST = 100;

export type BoosterKind = 'basic' | 'golden' | 'chroma';

export interface BoosterSpec {
  kind: BoosterKind;
  /** Paramètre de la commande /im. */
  param: string;
  label: string;
  cost: number;
  /** Probabilité de chaque rareté 1 à 4. */
  rarity: [number, number, number, number];
  /** Probabilité, une fois la rareté tirée, d'obtenir la version dorée. */
  golden: [number, number, number, number];
  /** Probabilité, une fois la rareté tirée, d'obtenir la version chromatique (pack Classique uniquement). */
  chroma: [number, number, number, number];
}

const RARITY_RATES: [number, number, number, number] = [0.75, 0.18, 0.06, 0.01];
const BASIC_GOLDEN: [number, number, number, number] = [0.04, 0.03, 0.02, 0.01];
const BASIC_CHROMA: [number, number, number, number] = [0.019, 0.016, 0.01, 0.006];

export const BOOSTERS: Record<BoosterKind, BoosterSpec> = {
  basic: {
    kind: 'basic',
    param: '',
    label: 'Invocation basique',
    cost: 1000,
    rarity: RARITY_RATES,
    golden: BASIC_GOLDEN,
    chroma: BASIC_CHROMA,
  },
  golden: {
    kind: 'golden',
    param: 'dorée',
    label: 'Invocation dorée',
    cost: 1500,
    rarity: RARITY_RATES,
    golden: [0.13, 0.1, 0.08, 0.03],
    chroma: BASIC_CHROMA,
  },
  chroma: {
    kind: 'chroma',
    param: 'chroma',
    label: 'Invocation chroma',
    cost: 2000,
    rarity: RARITY_RATES,
    golden: BASIC_GOLDEN,
    chroma: [0.05, 0.042, 0.036, 0.02],
  },
};

export const CARDS_PER_INVOCATION = 10;

/**
 * Bienveillance : après 209 cartes invoquées sans 4 ★, la 210ᵉ est une 4 ★, puis le compteur
 * repart à 210. Commune à tous les packs, classique ou d'évènement (source : annonce ZUnivers).
 */
export const PITY_CARDS = 210;

/**
 * Bonus de corporation : multiplicateur par niveau (récompense = Σ niveaux × multiplicateur). Le
 * bonus de recyclage s'applique carte par carte, arrondi à l'entier le plus proche : +10 % sur une
 * carte à 5 poudres en donne 6 (source : /corporations/info).
 */
export const CORPORATION_BONUS_MULTIPLIER: Record<string, number> = {
  LOOT: 10,
  RECYCLE_LORE_DUST: 0.01,
  RECYCLE_LORE_FRAGMENT: 0.01,
};

/** Fonctionnalités annoncées par /app/settings. */
export const FEATURE = {
  loot: 'LOOT',
  recycle: 'RECYCLE',
  craft: 'CRAFT',
  fusion: 'FUSION',
  upgrade: 'UPGRADE',
  evolution: 'EVOLUTION',
  invoke: 'INVOKE',
  tower: 'TOWER',
  challenge: 'CHALLENGE',
  corporation: 'CORPORATION',
  subscription: 'SUBSCRIPTION',
} as const;
