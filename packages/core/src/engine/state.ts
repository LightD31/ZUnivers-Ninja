import { CONSTELLATION_POINTS_FACTOR, PITY_CARDS } from '../rules/constants';
import { ascensionCredits, gameClock } from '../rules/time';
import {
  CURRENCIES,
  cardKey,
  type Balances,
  type CardKey,
  type ChallengeAction,
  type Currency,
  type OwnedCard,
  type Shiny,
} from '../model/types';
import { goalCardMet, type AchievementCounter } from './achievements';
import type { Context } from './context';
import { OverlayMap } from './overlay';

export interface ChallengeProgress {
  id: string;
  description: string;
  action: ChallengeAction;
  current: number;
  max: number;
  reward: number;
}

/** État simulé du joueur. Immuable : chaque action produit un nouvel état via `fork`. */
export interface State {
  cards: OverlayMap<CardKey, OwnedCard>;
  balances: Balances;
  challenges: ChallengeProgress[];
  dailyDone: boolean;
  weeklyDone: boolean;
  dailiesSinceWeekly: number;
  ascensionsLeft: number;
  /** Étages du Vortex gravis, en espérance (fractionnaire) : l'index de l'étage à tenter. */
  towerFloor: number;
  /** Index de l'étape d'évolution possédée, -1 si aucune. */
  evolutionIndex: number;
  /** Invocations d'évènement déjà simulées (pour les évènements à usage unique). */
  eventInvocations: Record<string, number>;
  /** Cartes nouvelles attendues des invocations simulées, par réserve de tirage. */
  expectedNew: Record<string, number>;
  /**
   * Cartes attendues des actions aléatoires simulées (invocations, ascensions) que le joueur n'avait
   * pas au début du plan : une carte retirée de la collection puis retirée ne compte pas.
   */
  expectedNewCards: number;
  /**
   * Bienveillance : probabilité que la carte 4 ★ garantie soit la d-ième prochaine carte invoquée
   * (indice d de 1 à 210). `null` quand le compteur du joueur est inconnu.
   */
  pity: Float64Array | null;
  /** Cartes du catalogue possédées, chaque brillance comptant à part. */
  owned: number;
  /** Points de collection certains (cartes + constellations). */
  points: number;
  /** Points espérés des actions aléatoires (invocations, ascensions). */
  ev: number;
  /** Progression de chaque succès de `ctx.achievements`. Remplacé, jamais muté en place. */
  achievements: number[];
  /** Points des succès obtenus pendant le plan. */
  achievementPoints: number;
}

export const EMPTY_CARD = (itemId: string, shiny: Shiny): OwnedCard => ({
  itemId,
  shiny,
  copies: 0,
  constellation: 0,
});

export function cardPoints(ctx: Context, card: OwnedCard): number {
  const item = ctx.items[card.itemId];
  if (!item) return 0;
  const score = item.scores[card.shiny];
  return (card.copies > 0 ? score : 0) + card.constellation * score * CONSTELLATION_POINTS_FACTOR;
}

const isOwned = (ctx: Context, card: OwnedCard) => card.copies > 0 && !!ctx.items[card.itemId];

function initialPity(invokeBeforePity: number | null | undefined): Float64Array | null {
  if (invokeBeforePity == null) return null;
  const dist = new Float64Array(PITY_CARDS + 1);
  dist[Math.min(PITY_CARDS, Math.max(1, Math.round(invokeBeforePity)))] = 1;
  return dist;
}

export function initialState(ctx: Context): State {
  const { player, catalog, now } = ctx;
  const cards = OverlayMap.from(Object.entries(player.inventory));
  let points = 0;
  let owned = 0;
  for (const card of Object.values(player.inventory)) {
    points += cardPoints(ctx, card);
    if (isOwned(ctx, card)) owned++;
  }

  const today = gameClock(now).date;
  const todayLoot = player.loot.find((d) => d.date === today);
  let dailiesSinceWeekly = 0;
  for (let i = player.loot.length - 1; i >= 0; i--) {
    const day = player.loot[i]!;
    if (day.weekly > 0) break;
    dailiesSinceWeekly += day.daily;
  }

  const season = catalog.season;
  const credits = season ? ascensionCredits(season.begin, season.end, now) : 0;
  const tower = player.tower ?? { floorsClimbed: 0, logCount: 0 };

  const evolution = player.evolution;
  const evolutionIndex = evolution ? evolution.steps.findLastIndex((s) => s.owned) : -1;

  return {
    cards,
    balances: { ...player.balances },
    challenges: player.challenges
      .filter((c) => c.current < c.max)
      .map((c) => ({
        id: c.id,
        description: c.description,
        action: c.action,
        current: c.current,
        max: c.max,
        reward: c.rewardLoreDust,
      })),
    dailyDone: (todayLoot?.daily ?? 0) > 0,
    weeklyDone: (todayLoot?.weekly ?? 0) > 0,
    dailiesSinceWeekly,
    ascensionsLeft: Math.max(0, credits - tower.logCount),
    towerFloor: tower.floorsClimbed,
    evolutionIndex,
    eventInvocations: {},
    expectedNew: {},
    expectedNewCards: 0,
    pity: initialPity(player.invokeBeforePity),
    owned,
    points,
    ev: 0,
    achievements: ctx.achievements.map((a) => a.current),
    achievementPoints: 0,
  };
}

/** Copie superficielle : les champs modifiés doivent être réassignés (jamais mutés en place). */
export function fork(state: State): State {
  return { ...state, cards: state.cards.fork(), balances: { ...state.balances } };
}

export function getCard(state: State, itemId: string, shiny: Shiny): OwnedCard {
  return state.cards.get(cardKey(itemId, shiny)) ?? EMPTY_CARD(itemId, shiny);
}

/** La carte remplit-elle sa part du succès `index` ? */
function achievementCardMet(
  ctx: Context,
  state: State,
  index: number,
  itemId: string,
  shiny: Shiny | null,
): boolean {
  const goal = ctx.achievements[index]!;
  return goalCardMet(
    (s) => state.cards.get(cardKey(itemId, s)),
    ctx.items[itemId]?.rarity ?? 0,
    shiny,
    goal.constellation,
  );
}

/** Fait progresser un succès ; une fois obtenu, il est acquis et rapporte ses points. */
function advanceAchievement(ctx: Context, state: State, index: number, delta: number): void {
  const goal = ctx.achievements[index]!;
  const current = state.achievements[index]!;
  if (current >= goal.max || delta === 0) return;
  const next = Math.max(0, Math.min(goal.max, current + delta));
  state.achievements = state.achievements.slice();
  state.achievements[index] = next;
  if (next >= goal.max) {
    state.achievementPoints += goal.score;
    state.balances.loreDust += goal.rewardLoreDust;
  }
}

/** Fait progresser les succès à compteur liés à une action. */
export function progressAchievements(
  ctx: Context,
  state: State,
  counter: AchievementCounter,
  amount: number,
): void {
  ctx.achievements.forEach((goal, index) => {
    if (goal.counter === counter) advanceAchievement(ctx, state, index, amount);
  });
}

/** Met à jour une carte (sur un état issu de `fork`) en maintenant le total de points. */
export function putCard(ctx: Context, state: State, card: OwnedCard): void {
  const previous = getCard(state, card.itemId, card.shiny);
  state.points += cardPoints(ctx, card) - cardPoints(ctx, previous);
  state.owned += Number(isOwned(ctx, card)) - Number(isOwned(ctx, previous));
  const goals = ctx.achievementsByItem.get(card.itemId);
  const before = goals?.map((g) => achievementCardMet(ctx, state, g.index, card.itemId, g.shiny));
  state.cards.set(cardKey(card.itemId, card.shiny), card);
  goals?.forEach((g, i) => {
    const after = achievementCardMet(ctx, state, g.index, card.itemId, g.shiny);
    if (after !== before![i]) advanceAchievement(ctx, state, g.index, after ? 1 : -1);
  });
}

export function addCopies(
  ctx: Context,
  state: State,
  itemId: string,
  shiny: Shiny,
  delta: number,
): void {
  const card = getCard(state, itemId, shiny);
  putCard(ctx, state, { ...card, copies: card.copies + delta });
}

export function canAfford(state: State, cost: Partial<Balances>): boolean {
  return (Object.entries(cost) as [Currency, number][]).every(([c, v]) => state.balances[c] >= v);
}

export function pay(state: State, cost: Partial<Balances>): void {
  for (const [c, v] of Object.entries(cost) as [Currency, number][]) state.balances[c] -= v;
}

export function earn(state: State, gain: Partial<Balances>): void {
  for (const [c, v] of Object.entries(gain) as [Currency, number][]) state.balances[c] += v;
}

/** Fait progresser les défis liés à une action et encaisse leurs récompenses. */
export function progressChallenges(
  ctx: Context,
  state: State,
  action: ChallengeAction,
  amount: number,
): void {
  if (amount <= 0 || !state.challenges.some((c) => c.action === action && c.current < c.max))
    return;
  let completed = 0;
  state.challenges = state.challenges.map((c) => {
    if (c.action !== action || c.current >= c.max) return c;
    const current = Math.min(c.max, c.current + amount);
    if (current >= c.max) {
      state.balances.loreDust += c.reward;
      completed++;
    }
    return { ...c, current };
  });
  if (completed === 0) return;
  // Un défi terminé fait progresser les défis « Compléter N défis » et les succès de défis.
  progressAchievements(ctx, state, 'challenge', completed);
  if (state.challenges.every((c) => c.current >= c.max))
    progressAchievements(ctx, state, 'weekChallenges', 1);
  progressChallenges(ctx, state, 'challenge', completed);
}

/**
 * Valeur d'un état pour le planificateur : points (collection et succès) + espérance (réduite
 * selon `evFactor`) + bonus des cartes nouvelles + monnaies pondérées.
 */
export function stateValue(ctx: Context, state: State): number {
  const { evFactor, newCardBonus, weights } = ctx.options;
  let value = state.points + state.achievementPoints + state.ev * evFactor;
  if (newCardBonus > 0) value += newCardBonus * (state.owned + state.expectedNewCards * evFactor);
  for (const c of CURRENCIES) value += state.balances[c] * weights[c];
  return value;
}
