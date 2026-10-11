import type { Context } from '../engine/context';
import { recycleGain } from '../engine/context';
import { getCard, type State } from '../engine/state';
import { CURRENCIES, type Balances, type Item, type Shiny } from '../model/types';
import {
  ASCENSION_FAIL_REFUND,
  BOOSTERS,
  FEATURE,
  REPUTATION_ATTEMPT,
  REPUTATION_SUCCESS,
  REPUTATION_TOP_FLOOR,
  type BoosterSpec,
} from './constants';
import { gameClock } from './time';

/**
 * Modèle en espérance des actions aléatoires (invocations, ascensions) : on ne peut pas savoir
 * quelles cartes tomberont, mais on peut estimer combien de points elles rapportent en moyenne.
 */

interface PoolBucket {
  items: Item[];
  /** Valeur moyenne d'un doublon (recyclage pondéré). */
  dupValue: number;
}

/** Réserve de tirage : cartes d'un pack par rareté et brillance. */
type Pool = Map<string, PoolBucket>;

const bucketKey = (pool: string, rarity: number, shiny: Shiny) => `${pool}|${rarity}|${shiny}`;
const poolCache = new WeakMap<Context, Map<string, Pool>>();

function weightedValue(ctx: Context, gain: Partial<Balances>): number {
  let v = 0;
  for (const c of CURRENCIES) v += (gain[c] ?? 0) * ctx.options.weights[c];
  return v;
}

function getPool(ctx: Context, packId: string | null, invocableOnly: boolean): Pool {
  let cache = poolCache.get(ctx);
  if (!cache) poolCache.set(ctx, (cache = new Map()));
  const key = `${packId ?? 'classic'}|${invocableOnly}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const pool: Pool = new Map();
  for (const item of ctx.itemList) {
    if (packId === null ? !item.isClassic : item.packId !== packId) continue;
    if (invocableOnly && !item.invocable) continue;
    if (item.isFusion || item.isStar) continue;
    for (const shiny of [0, 1, 2] as Shiny[]) {
      if (!item.shinyAvailable[shiny]) continue;
      const k = bucketKey(key, item.rarity, shiny);
      const bucket = pool.get(k) ?? { items: [], dupValue: 0 };
      bucket.items.push(item);
      pool.set(k, bucket);
    }
  }
  for (const [k, bucket] of pool) {
    const shiny = Number(k.split('|').at(-1)) as Shiny;
    const total = bucket.items.reduce(
      (sum, it) => sum + (it.recyclable ? weightedValue(ctx, recycleGain(ctx, it, shiny)) : 0),
      0,
    );
    bucket.dupValue = bucket.items.length > 0 ? total / bucket.items.length : 0;
  }
  cache.set(key, pool);
  return pool;
}

/** Espérance de valeur d'une carte tirée dans un seau, et probabilité qu'elle soit nouvelle. */
function cardEV(
  state: State,
  poolKey: string,
  bucket: PoolBucket | undefined,
  rarity: number,
  shiny: Shiny,
): { value: number; pNew: number; key: string } {
  const key = bucketKey(poolKey, rarity, shiny);
  if (!bucket || bucket.items.length === 0) return { value: 0, pNew: 0, key };
  let unowned = 0;
  let unownedScore = 0;
  for (const item of bucket.items) {
    if (getCard(state, item.id, shiny).copies === 0) {
      unowned++;
      unownedScore += item.scores[shiny];
    }
  }
  const effective = Math.max(0, unowned - (state.expectedNew[key] ?? 0));
  const pNew = effective / bucket.items.length;
  const avgNewScore = unowned > 0 ? unownedScore / unowned : 0;
  return { value: pNew * avgNewScore + (1 - pNew) * bucket.dupValue, pNew, key };
}

export interface BoosterOption {
  key: string;
  label: string;
  /** Paramètre de /im (vide pour l'invocation basique). */
  param: string;
  cost: Partial<Balances>;
  cards: number;
  spec: BoosterSpec;
  /** `null` = pack Classique. */
  packId: string | null;
  chroma: boolean;
  eventId?: string;
  oneTime?: boolean;
}

/** Invocations disponibles en ce moment. */
export function boosterOptions(ctx: Context): BoosterOption[] {
  if (!ctx.features.has(FEATURE.invoke)) return [];
  const options: BoosterOption[] = Object.values(BOOSTERS).map((spec) => ({
    key: spec.kind,
    label: spec.label,
    param: spec.param,
    cost: { balance: spec.cost },
    cards: 10,
    spec,
    packId: null,
    chroma: true,
  }));
  // Les dates d'évènement sont en heure française, sans fuseau : on compare au jour près.
  const today = gameClock(ctx.now).date;
  for (const event of ctx.catalog.events) {
    if (!event.active) continue;
    if (event.begin.slice(0, 10) > today || event.end.slice(0, 10) < today) continue;
    const classic = !event.packId || event.packSlug === 'classique';
    const cost: Partial<Balances> = {};
    if (event.balanceCost > 0) cost.balance = event.balanceCost;
    if (event.loreDustCost > 0) cost.loreDust = event.loreDustCost;
    options.push({
      key: `event:${event.id}`,
      label: `Invocation « ${event.name} »`,
      param: event.name,
      cost,
      cards: event.invokeCount,
      spec: BOOSTERS.basic,
      packId: classic ? null : event.packId,
      chroma: classic,
      eventId: event.id,
      oneTime: event.oneTime,
    });
  }
  return options;
}

/** Espérance (en points) d'une invocation, et cartes nouvelles attendues (au total et par seau). */
export function invocationEV(
  ctx: Context,
  state: State,
  option: BoosterOption,
): { ev: number; newCards: number; expectedNew: Record<string, number> } {
  const pool = getPool(ctx, option.packId, true);
  const poolKey = `${option.packId ?? 'classic'}|true`;
  const expectedNew: Record<string, number> = {};
  let perCard = 0;
  let newCards = 0;
  option.spec.rarity.forEach((pRarity, i) => {
    const rarity = i + 1;
    const pGolden = option.spec.golden[i] ?? 0;
    const pChroma = option.chroma ? (option.spec.chroma[i] ?? 0) : 0;
    const shares: [Shiny, number][] = [
      [0, 1 - pGolden - pChroma],
      [1, pGolden],
      [2, pChroma],
    ];
    for (const [shiny, pShiny] of shares) {
      const p = pRarity * pShiny;
      if (p <= 0) continue;
      const { value, pNew, key } = cardEV(
        state,
        poolKey,
        pool.get(bucketKey(poolKey, rarity, shiny)),
        rarity,
        shiny,
      );
      perCard += p * value;
      expectedNew[key] = (expectedNew[key] ?? 0) + option.cards * p * pNew;
      newCards += option.cards * p * pNew;
    }
  });
  return { ev: perCard * option.cards, newCards, expectedNew };
}

/** Espérance (en points) d'une tentative d'ascension à l'étage courant, et cartes nouvelles attendues. */
export function ascensionEV(
  ctx: Context,
  state: State,
): { ev: number; successRate: number; newCards: number } {
  const season = ctx.catalog.season;
  if (!season) return { ev: 0, successRate: 0, newCards: 0 };
  const floor = season.floors[Math.floor(state.towerFloor)];
  if (!floor) return { ev: 0, successRate: 0, newCards: 0 };
  const pool = getPool(ctx, season.packId, false);
  const poolKey = `${season.packId}|false`;
  let reward = 0;
  let pNewReward = 0;
  for (const drop of floor.drops) {
    const { value, pNew } = cardEV(
      state,
      poolKey,
      pool.get(bucketKey(poolKey, drop.rarity, drop.shiny)),
      drop.rarity,
      drop.shiny,
    );
    reward += drop.rate * value;
    pNewReward += drop.rate * pNew;
  }
  const floorIndex = Math.floor(state.towerFloor);
  const refund = ASCENSION_FAIL_REFUND * ctx.options.weights.loreDust;
  const rep = ctx.options.reputationWeight;
  const successRep =
    floorIndex === season.floors.length - 1 ? REPUTATION_TOP_FLOOR : REPUTATION_SUCCESS;
  const success = reward + successRep * rep;
  const failure = refund + REPUTATION_ATTEMPT * rep;
  return {
    ev: floor.rate * success + (1 - floor.rate) * failure,
    successRate: floor.rate,
    newCards: floor.rate * pNewReward,
  };
}
