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
  /** Étage du Vortex en espérance (fractionnaire). */
  towerFloor: number;
  /** Index de l'étape d'évolution possédée, -1 si aucune. */
  evolutionIndex: number;
  /** Invocations d'évènement déjà simulées (pour les évènements à usage unique). */
  eventInvocations: Record<string, number>;
  /** Cartes nouvelles attendues des invocations simulées, par réserve de tirage. */
  expectedNew: Record<string, number>;
  /** Cartes nouvelles attendues de toutes les actions aléatoires simulées (invocations, ascensions). */
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
  const tower = player.tower ?? { floorIndex: 0, logCount: 0 };

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
    towerFloor: tower.floorIndex,
    evolutionIndex,
    eventInvocations: {},
    expectedNew: {},
    expectedNewCards: 0,
    pity: initialPity(player.invokeBeforePity),
    owned,
    points,
    ev: 0,
  };
}

/** Copie superficielle : les champs modifiés doivent être réassignés (jamais mutés en place). */
export function fork(state: State): State {
  return { ...state, cards: state.cards.fork(), balances: { ...state.balances } };
}

export function getCard(state: State, itemId: string, shiny: Shiny): OwnedCard {
  return state.cards.get(cardKey(itemId, shiny)) ?? EMPTY_CARD(itemId, shiny);
}

/** Met à jour une carte (sur un état issu de `fork`) en maintenant le total de points. */
export function putCard(ctx: Context, state: State, card: OwnedCard): void {
  const previous = getCard(state, card.itemId, card.shiny);
  state.points += cardPoints(ctx, card) - cardPoints(ctx, previous);
  state.owned += Number(isOwned(ctx, card)) - Number(isOwned(ctx, previous));
  state.cards.set(cardKey(card.itemId, card.shiny), card);
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
export function progressChallenges(state: State, action: ChallengeAction, amount: number): void {
  if (amount <= 0 || !state.challenges.some((c) => c.action === action && c.current < c.max))
    return;
  state.challenges = state.challenges.map((c) => {
    if (c.action !== action || c.current >= c.max) return c;
    const current = Math.min(c.max, c.current + amount);
    if (current >= c.max) state.balances.loreDust += c.reward;
    return { ...c, current };
  });
}

/**
 * Valeur d'un état pour le planificateur : points + espérance (réduite selon `evFactor`)
 * + bonus des cartes nouvelles + monnaies pondérées.
 */
export function stateValue(ctx: Context, state: State): number {
  const { evFactor, newCardBonus, weights } = ctx.options;
  let value = state.points + state.ev * evFactor;
  if (newCardBonus > 0) value += newCardBonus * (state.owned + state.expectedNewCards * evFactor);
  for (const c of CURRENCIES) value += state.balances[c] * weights[c];
  return value;
}
