import {
  ASCENSION_COST,
  CONSTELLATION_UPGRADE_DUST,
  FEATURE,
  SUBSCRIPTION_LOOT_BONUS,
  WEEKLY_EVERY_DAILIES,
} from '../rules/constants';
import {
  ascensionEV,
  boosterOptions,
  creditExpectedLevels,
  invocationEV,
  releaseExpectedLevels,
  settleExpectedLevels,
  settleExpectedNew,
  type BoosterOption,
} from '../rules/random';
import { reserveBeforeConstellation, reserveFor, reserveTotal } from '../rules/reserve';
import type { Balances, Item, Shiny } from '../model/types';
import {
  canRecycle,
  craftCost,
  enchantCost,
  forgeCurrency,
  recycleGain,
  type Context,
} from './context';
import {
  addCopies,
  canAfford,
  earn,
  fork,
  getCard,
  pay,
  progressAchievements,
  progressChallenges,
  putCard,
  summitChance,
  type State,
} from './state';

export interface RecycleEntry {
  itemId: string;
  shiny: Shiny;
  count: number;
}

export type Action =
  | { kind: 'daily' }
  | { kind: 'weekly' }
  | { kind: 'recycle'; cards: RecycleEntry[] }
  | { kind: 'craft'; itemId: string }
  | { kind: 'enchant'; itemId: string }
  | { kind: 'fusion'; itemId: string; shiny: Shiny }
  | { kind: 'constellation'; itemId: string; shiny: Shiny }
  | { kind: 'invoke'; booster: string }
  | { kind: 'ascension' }
  | { kind: 'evolution'; fromItemId: string | null; toItemId: string };

export type ActionKind = Action['kind'];

export interface Applied {
  state: State;
  /** Cartes dont la réserve a pu changer. */
  touched: string[];
  /** Variation de monnaies (récompenses de défis comprises). */
  balanceDelta: Partial<Balances>;
  /** Pour les actions aléatoires : points espérés. */
  ev?: number;
  note?: string;
}

/** Identifiant stable d'une action (déduplication, déterminisme). */
export function actionKey(action: Action): string {
  switch (action.kind) {
    case 'recycle':
      return `recycle:${action.cards.map((c) => `${c.itemId}:${c.shiny}x${c.count}`).join(',')}`;
    case 'craft':
    case 'enchant':
      return `${action.kind}:${action.itemId}`;
    case 'fusion':
    case 'constellation':
      return `${action.kind}:${action.itemId}:${action.shiny}`;
    case 'invoke':
      return `invoke:${action.booster}`;
    case 'evolution':
      return `evolution:${action.toItemId}`;
    default:
      return action.kind;
  }
}

function diff(before: Balances, after: Balances): Partial<Balances> {
  const delta: Partial<Balances> = {};
  for (const k of Object.keys(before) as (keyof Balances)[]) {
    if (after[k] !== before[k]) delta[k] = after[k] - before[k];
  }
  return delta;
}

/** Récompense de /journa ou /bonus : base + bonus de corporation, + bonus d'abonnement au /journa. */
function lootReward(ctx: Context, base: number, daily: boolean): Partial<Balances> {
  const subscription = daily && ctx.player.subscribed ? SUBSCRIPTION_LOOT_BONUS : 0;
  return {
    balance: base + ctx.corporation.loot + subscription,
    loreDust: ctx.catalog.settings.dailyLoreDust,
  };
}

type Result = Omit<Applied, 'balanceDelta'> | null;

/** Invocations encore possibles d'un pack : une pour un évènement à usage unique, ses bons… */
export function invocationsLeft(state: State, option: BoosterOption): number {
  const used = state.eventInvocations[option.key] ?? 0;
  const limit = option.oneTime ? 1 : (option.limit ?? Infinity);
  return limit - used;
}

/** En deçà de cette chance de ne pas être au sommet, plus aucune ascension n'est proposée. */
const SUMMIT_EPSILON = 1e-6;

/**
 * Étage d'une ascension et sa chance de réussite : « étage 3, 65 % de réussite ». Quand les essais
 * précédents du plan peuvent avoir échoué, l'étage le plus probable et la chance de monter, tous
 * étages possibles confondus : « étage 3 le plus probable (70 %), 58 % de chances de monter ».
 */
function ascensionNote(state: State, successRate: number): string {
  const attempted = state.tower.slice(0, -1);
  const floor = attempted.reduce((best, p, f) => (p > attempted[best]! ? f : best), 0);
  const chance = attempted[floor]! / Math.max(1e-9, 1 - summitChance(state));
  const rate = Math.round(successRate * 100);
  return chance >= 0.99
    ? `étage ${floor + 1}, ${rate} % de réussite`
    : `étage ${floor + 1} le plus probable (${Math.round(chance * 100)} %), ${rate} % de chances de monter`;
}

/** Ajoute un exemplaire obtenu à coup sûr, en soldant les tirages espérés de cette carte. */
function obtain(ctx: Context, s: State, item: Item, shiny: Shiny): void {
  if (getCard(s, item.id, shiny).copies === 0) {
    settleExpectedNew(ctx, s, item, shiny);
    creditExpectedLevels(ctx, s, item, shiny);
  }
  addCopies(ctx, s, item.id, shiny, 1);
}

/** Retire des exemplaires ; le dernier qui part change ce que les invocations simulées montent. */
function remove(ctx: Context, s: State, itemId: string, shiny: Shiny, count: number): void {
  const item = ctx.items[itemId];
  if (item && getCard(s, itemId, shiny).copies <= count) releaseExpectedLevels(ctx, s, item, shiny);
  addCopies(ctx, s, itemId, shiny, -count);
}

function applyInner(ctx: Context, s0: State, action: Action): Result {
  const { allow } = ctx.options;
  switch (action.kind) {
    case 'daily': {
      if (s0.dailyDone || !ctx.features.has(FEATURE.loot)) return null;
      const s = fork(s0);
      earn(s, lootReward(ctx, ctx.catalog.settings.dailyReward, true));
      s.dailyDone = true;
      s.dailiesSinceWeekly += 1;
      progressChallenges(ctx, s, 'loot', 1);
      // Le ticket du jour des abonnés est perdu s'il n'est pas gratté sous 24 h (source : /tickets).
      return {
        state: s,
        touched: [],
        ...(ctx.player.subscribed
          ? { note: 'Abonné : gratte ton Lucky Rayou du jour sous 24 h (lien : /ticketlien).' }
          : {}),
      };
    }

    case 'weekly': {
      if (s0.weeklyDone || s0.dailiesSinceWeekly < WEEKLY_EVERY_DAILIES) return null;
      if (!ctx.features.has(FEATURE.loot)) return null;
      const s = fork(s0);
      earn(s, lootReward(ctx, ctx.catalog.settings.weeklyReward, false));
      s.weeklyDone = true;
      s.dailiesSinceWeekly = 0;
      progressChallenges(ctx, s, 'weekly', 1);
      return { state: s, touched: [] };
    }

    case 'recycle': {
      if (!allow.recycle || !ctx.features.has(FEATURE.recycle) || action.cards.length === 0)
        return null;
      const s = fork(s0);
      let recycled = 0;
      for (const entry of action.cards) {
        const item = ctx.items[entry.itemId];
        if (!item || entry.count <= 0 || !canRecycle(ctx, item, entry.shiny)) return null;
        const card = getCard(s, entry.itemId, entry.shiny);
        const surplus = card.copies - reserveTotal(reserveFor(ctx, s, entry.itemId, entry.shiny));
        if (entry.count > surplus) return null;
        addCopies(ctx, s, entry.itemId, entry.shiny, -entry.count);
        const gain = recycleGain(ctx, item, entry.shiny);
        for (const [c, v] of Object.entries(gain) as [keyof Balances, number][]) {
          s.balances[c] += v * entry.count;
          recycled += v * entry.count;
        }
      }
      progressChallenges(ctx, s, 'recycle', recycled);
      progressAchievements(
        ctx,
        s,
        'recycle',
        action.cards.reduce((n, c) => n + c.count, 0),
      );
      return { state: s, touched: action.cards.map((c) => c.itemId) };
    }

    case 'craft': {
      const item = ctx.items[action.itemId];
      if (!allow.craft || !item || !ctx.features.has(FEATURE.craft)) return null;
      const cost = craftCost(ctx, item);
      if (cost === undefined) return null;
      const price = { [forgeCurrency(item)]: cost };
      if (!canAfford(s0, price)) return null;
      const s = fork(s0);
      pay(s, price);
      obtain(ctx, s, item, 0);
      progressChallenges(ctx, s, 'craft', 1);
      return { state: s, touched: [item.id] };
    }

    case 'enchant': {
      const item = ctx.items[action.itemId];
      if (!allow.enchant || !item || !ctx.features.has(FEATURE.craft)) return null;
      const cost = enchantCost(ctx, item);
      if (cost === undefined || getCard(s0, item.id, 0).copies < 1) return null;
      const price = { [forgeCurrency(item)]: cost };
      if (!canAfford(s0, price)) return null;
      const s = fork(s0);
      pay(s, price);
      const lastNormal = getCard(s0, item.id, 0).copies === 1;
      remove(ctx, s, item.id, 0, 1);
      obtain(ctx, s, item, 1);
      progressChallenges(ctx, s, 'enchant', 1);
      return {
        state: s,
        touched: [item.id],
        ...(lastNormal
          ? { note: 'Utilise ta dernière version normale : la dorée rapporte plus de points.' }
          : {}),
      };
    }

    case 'fusion': {
      const fusion = ctx.fusionsByResult.get(action.itemId);
      const result = ctx.items[action.itemId];
      if (!allow.fusion || !fusion || !result || !ctx.features.has(FEATURE.fusion)) return null;
      if (!result.shinyAvailable[action.shiny]) return null;
      if (getCard(s0, result.id, action.shiny).copies > 0) return null;
      const keep = 1 + ctx.options.keepExtra;
      for (const input of fusion.inputs) {
        if (getCard(s0, input.itemId, action.shiny).copies < input.quantity + keep) return null;
      }
      const s = fork(s0);
      for (const input of fusion.inputs) remove(ctx, s, input.itemId, action.shiny, input.quantity);
      obtain(ctx, s, result, action.shiny);
      progressChallenges(ctx, s, 'fusion', 1);
      progressAchievements(ctx, s, 'fusion', 1);
      return { state: s, touched: [result.id, ...fusion.inputs.map((i) => i.itemId)] };
    }

    case 'constellation': {
      const item = ctx.items[action.itemId];
      if (!allow.constellation || !item || !ctx.features.has(FEATURE.upgrade)) return null;
      if (!item.upgradable || action.shiny > 1 || !item.shinyAvailable[action.shiny]) return null;
      const card = getCard(s0, item.id, action.shiny);
      if (card.constellation >= item.rarity) return null;
      // Consomme un doublon : on garde toujours un exemplaire et ceux réservés aux fusions.
      if (card.copies <= reserveBeforeConstellation(reserveFor(ctx, s0, item.id, action.shiny)))
        return null;
      const s = fork(s0);
      settleExpectedLevels(ctx, s, item, action.shiny);
      putCard(ctx, s, { ...card, copies: card.copies - 1, constellation: card.constellation + 1 });
      s.balances.upgradeDust += CONSTELLATION_UPGRADE_DUST;
      progressChallenges(ctx, s, 'constellation', 1);
      return { state: s, touched: [item.id] };
    }

    case 'invoke': {
      if (!allow.invoke) return null;
      const option = boosterOptions(ctx).find((o) => o.key === action.booster);
      if (!option || !canAfford(s0, option.cost) || invocationsLeft(s0, option) <= 0) return null;
      const { ev, newCards, expectedNew, draws, pity } = invocationEV(ctx, s0, option);
      const s = fork(s0);
      pay(s, option.cost);
      s.ev += ev;
      s.expectedNewCards += newCards;
      s.pity = pity;
      s.expectedNew = { ...s.expectedNew };
      for (const [k, v] of Object.entries(expectedNew))
        s.expectedNew[k] = (s.expectedNew[k] ?? 0) + v;
      s.drawsPerCard = { ...s.drawsPerCard };
      for (const [k, v] of Object.entries(draws)) s.drawsPerCard[k] = (s.drawsPerCard[k] ?? 0) + v;
      if (option.oneTime || option.limit !== undefined) {
        s.eventInvocations = {
          ...s.eventInvocations,
          [option.key]: (s.eventInvocations[option.key] ?? 0) + 1,
        };
      }
      progressChallenges(ctx, s, 'invoke', 1);
      progressChallenges(ctx, s, 'invokeItems', option.cards);
      return { state: s, touched: [], ev };
    }

    case 'ascension': {
      const season = ctx.catalog.season;
      if (!allow.ascension || !season || !ctx.features.has(FEATURE.tower)) return null;
      if (s0.ascensionsLeft <= 0 || s0.balances.loreDust < ASCENSION_COST) return null;
      if (summitChance(s0) >= 1 - SUMMIT_EPSILON) return null;
      const { ev, successRate, newCards, next } = ascensionEV(ctx, s0);
      const s = fork(s0);
      s.balances.loreDust -= ASCENSION_COST;
      s.ascensionsLeft -= 1;
      s.tower = next;
      s.ev += ev;
      s.expectedNewCards += newCards;
      progressChallenges(ctx, s, 'ascension', 1);
      progressAchievements(ctx, s, 'ascension', 1);
      return { state: s, touched: [], ev, note: ascensionNote(s0, successRate) };
    }

    case 'evolution': {
      const evolution = ctx.player.evolution;
      if (!allow.evolution || !evolution || !ctx.features.has(FEATURE.evolution)) return null;
      const index = s0.evolutionIndex;
      const next = evolution.steps[index + 1];
      const cost = evolution.costs[index];
      if (index < 0 || !next || next.itemId !== action.toItemId || cost === undefined) return null;
      if (s0.balances.upgradeDust < cost) return null;
      const s = fork(s0);
      s.balances.upgradeDust -= cost;
      const current = evolution.steps[index]!;
      if (getCard(s, current.itemId, 0).copies > 0) remove(ctx, s, current.itemId, 0, 1);
      const nextItem = ctx.items[next.itemId];
      if (nextItem) obtain(ctx, s, nextItem, 0);
      else addCopies(ctx, s, next.itemId, 0, 1);
      s.evolutionIndex = index + 1;
      progressChallenges(ctx, s, 'evolution', 1);
      return { state: s, touched: [] };
    }
  }
}

/** Applique une action. Renvoie `null` si elle est impossible dans cet état. */
export function applyAction(ctx: Context, state: State, action: Action): Applied | null {
  const result = applyInner(ctx, state, action);
  if (!result) return null;
  return { ...result, balanceDelta: diff(state.balances, result.state.balances) };
}
