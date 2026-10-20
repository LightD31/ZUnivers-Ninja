import type { Context } from '../engine/context';
import { recycleGain } from '../engine/context';
import { getCard, type State } from '../engine/state';
import { CURRENCIES, cardKey, type Balances, type Item, type Shiny } from '../model/types';
import {
  ASCENSION_FAIL_REFUND,
  BOOSTERS,
  CONSTELLATION_POINTS_FACTOR,
  CONSTELLATION_UPGRADE_DUST,
  FEATURE,
  PITY_CARDS,
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

function weightedValue(weights: Balances, gain: Partial<Balances>): number {
  let v = 0;
  for (const c of CURRENCIES) v += (gain[c] ?? 0) * weights[c];
  return v;
}

/**
 * Valeur d'une unité de monnaie rapportée par un doublon. Une invocation se paie en ZUMonnaie et
 * ses doublons rapportent de la poudre, comptée à ce qu'elle achète (voir `withDuplicateValue`).
 * Une ascension se paie en poudre, comptée à son poids : ses doublons aussi, sinon elle semblait
 * rendre plus de poudre qu'elle n'en coûte.
 */
const duplicateWeights = (ctx: Context, invocation: boolean) =>
  (invocation && ctx.duplicateWeights) || ctx.options.weights;

/** Réserve d'une invocation (cartes invocables) ou d'une ascension (toutes les cartes du pack). */
function getPool(ctx: Context, packId: string | null, invocableOnly: boolean): Pool {
  let cache = poolCache.get(ctx);
  if (!cache) poolCache.set(ctx, (cache = new Map()));
  const key = `${packId ?? 'classic'}|${invocableOnly}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const items = ctx.itemList.filter(
    (item) =>
      (packId === null ? item.isClassic : item.packId === packId) &&
      (!invocableOnly || item.invocable) &&
      !item.isFusion &&
      !item.isStar,
  );
  const pool = buildPool(ctx, key, items, duplicateWeights(ctx, invocableOnly));
  cache.set(key, pool);
  return pool;
}

/** Seaux d'une réserve de tirage, par rareté et brillance, avec la valeur moyenne d'un doublon. */
function buildPool(ctx: Context, key: string, items: Item[], weights: Balances): Pool {
  const pool: Pool = new Map();
  for (const item of items) {
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
      (sum, it) => sum + (it.recyclable ? weightedValue(weights, recycleGain(ctx, it, shiny)) : 0),
      0,
    );
    bucket.dupValue = bucket.items.length > 0 ? total / bucket.items.length : 0;
  }
  return pool;
}

/**
 * Cartes non possédées d'un seau, mises en cache par contenu d'inventaire : sur un compte riche,
 * des centaines d'invocations s'enchaînent sans changer l'inventaire, et ce parcours de tout le
 * seau dominait le temps de calcul.
 */
const unownedCache = new WeakMap<object, Map<string, BucketCards>>();

interface BucketCards {
  unowned: number;
  score: number;
  fresh: number;
  /**
   * Cartes à qui il reste des niveaux de constellation, par nombre de niveaux restants (indice 1 à
   * 4) : leur nombre et la somme des points qu'un niveau leur rapporte. Possédées (`open`), chaque
   * doublon tiré peut monter un niveau ; non possédées (`openUnowned`), chaque tirage après le
   * premier, qui donne la carte.
   */
  open: { count: number; points: number }[];
  openUnowned: { count: number; points: number }[];
}

/** La carte était-elle dans la collection au début du plan ? */
const ownedAtStart = (ctx: Context, item: Item, shiny: Shiny) =>
  (ctx.player.inventory[cardKey(item.id, shiny)]?.copies ?? 0) > 0;

/**
 * Cartes non possédées d'un seau, leurs points, et combien d'entre elles le joueur n'avait pas au
 * début du plan (`fresh`) : une carte retirée de la collection pendant le plan (dernier exemplaire
 * normal enchanté) puis retirée n'est pas une carte jamais possédée. Aussi, les cartes possédées
 * dont un doublon monterait une constellation.
 */
function unownedIn(
  ctx: Context,
  state: State,
  key: string,
  bucket: PoolBucket,
  shiny: Shiny,
): BucketCards {
  const { layer, writes } = state.cards.snapshot();
  let cache = unownedCache.get(layer);
  if (!cache) unownedCache.set(layer, (cache = new Map()));
  const cacheKey = `${writes}|${key}`;
  let entry = cache.get(cacheKey);
  if (!entry) {
    entry = { unowned: 0, score: 0, fresh: 0, open: [], openUnowned: [] };
    for (const item of bucket.items) {
      const card = getCard(state, item.id, shiny);
      if (card.copies === 0) {
        entry.unowned++;
        entry.score += item.scores[shiny];
        if (!ownedAtStart(ctx, item, shiny)) entry.fresh++;
      }
      if (item.upgradable && shiny <= 1 && card.constellation < item.rarity) {
        const levels = item.rarity - card.constellation;
        const list = card.copies === 0 ? entry.openUnowned : entry.open;
        const open = (list[levels] ??= { count: 0, points: 0 });
        open.count++;
        open.points += item.scores[shiny] * CONSTELLATION_POINTS_FACTOR;
      }
    }
    cache.set(cacheKey, entry);
  }
  return entry;
}

/** Chance qu'une carte tirée en moyenne `draws` fois l'ait été moins de `levels` fois (Poisson). */
function fewerDraws(draws: number, levels: number): number {
  let term = Math.exp(-draws);
  let p = 0;
  for (let k = 0; k < levels; k++) {
    p += term;
    term *= draws / (k + 1);
  }
  return p;
}

/**
 * Niveaux de constellation montés en espérance par les doublons d'une carte tirée en moyenne
 * `draws` fois, à qui il reste `levels` niveaux : E[min(X, levels)], somme des P(X ≥ k).
 */
function levelsFilled(draws: number, levels: number): number {
  let filled = 0;
  for (let k = 1; k <= levels; k++) filled += 1 - fewerDraws(draws, k);
  return filled;
}

/** Comme `levelsFilled`, pour une carte non possédée : son premier tirage la donne. */
const levelsFilledAfterFirst = (draws: number, levels: number) =>
  levelsFilled(draws, levels + 1) - levelsFilled(draws, 1);

/**
 * Niveaux de plus quand une carte entre dans la collection : son premier tirage aussi devient un
 * doublon. E[min(X, n)] - E[min(X - 1, n)] = P(1 ≤ X ≤ n).
 */
const levelsOnceOwned = (draws: number, levels: number) =>
  fewerDraws(draws, levels + 1) - fewerDraws(draws, 1);

/**
 * Ce qu'un niveau de constellation rapporte de plus que le recyclage du doublon qui le monte :
 * ses points et ses éclats, moins le recyclage. Les éclats valent comme les autres monnaies des
 * doublons d'invocation (voir `withDuplicateValue`).
 */
const levelGain = (ctx: Context, bucket: PoolBucket, count: number, points: number) =>
  Math.max(
    0,
    points +
      count *
        (CONSTELLATION_UPGRADE_DUST * duplicateWeights(ctx, true).upgradeDust - bucket.dupValue),
  );

/**
 * Espérance de valeur d'une carte tirée dans un seau, probabilité qu'elle soit nouvelle, et qu'elle
 * soit en plus une carte que le joueur n'avait pas au début du plan (`pFresh`, pour le bonus des
 * cartes nouvelles).
 *
 * Invocations (`drawn` : cartes tirées dans ce seau par l'invocation, en espérance) : le doublon
 * d'une carte à qui il reste des niveaux de constellation en monte un au lieu d'être recyclé, tant
 * que les tirages précédents du plan (`State.drawsPerCard`) ne les ont pas tous montés. Recyclé, il
 * valait bien moins : un doublon de dorée 1 ★ monte 120 points, mais n'en rend qu'une vingtaine en
 * poudre. Chaque invocation compte exactement les niveaux que ses tirages ajoutent : la somme ne
 * dépend pas de la façon dont les tirages se répartissent entre invocations.
 */
function cardEV(
  ctx: Context,
  state: State,
  poolKey: string,
  bucket: PoolBucket | undefined,
  rarity: number,
  shiny: Shiny,
  drawn: number | null,
): { value: number; pNew: number; pFresh: number; key: string; size: number } {
  const key = bucketKey(poolKey, rarity, shiny);
  if (!bucket || bucket.items.length === 0) return { value: 0, pNew: 0, pFresh: 0, key, size: 0 };
  const {
    unowned,
    score: unownedScore,
    fresh,
    open,
    openUnowned,
  } = unownedIn(ctx, state, key, bucket, shiny);
  const size = bucket.items.length;
  const effective = Math.max(0, unowned - (state.expectedNew[key] ?? 0));
  const pNew = effective / size;
  const avgNewScore = unowned > 0 ? unownedScore / unowned : 0;
  let levels = 0;
  if (drawn) {
    const before = state.drawsPerCard[key] ?? 0;
    const step = drawn / size;
    open.forEach((o, n) => {
      const filled = levelsFilled(before + step, n) - levelsFilled(before, n);
      levels += (filled / step) * levelGain(ctx, bucket, o.count, o.points);
    });
    openUnowned.forEach((o, n) => {
      const filled = levelsFilledAfterFirst(before + step, n) - levelsFilledAfterFirst(before, n);
      levels += (filled / step) * levelGain(ctx, bucket, o.count, o.points);
    });
  }
  return {
    value: pNew * avgNewScore + (1 - pNew) * bucket.dupValue + levels / size,
    pNew,
    pFresh: unowned > 0 ? (pNew * fresh) / unowned : 0,
    key,
    size,
  };
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
  /**
   * Cartes mises en avant par l'évènement, par rareté : une carte tirée dans une de ces raretés
   * est forcément l'une d'elles (le site affiche « N'importe quelle carte » pour les autres).
   */
  featured?: Map<number, Item[]>;
}

const boosterCache = new WeakMap<Context, BoosterOption[]>();

/** Invocations disponibles en ce moment (ne dépend que du catalogue et de l'heure : en cache). */
export function boosterOptions(ctx: Context): BoosterOption[] {
  let options = boosterCache.get(ctx);
  if (!options) boosterCache.set(ctx, (options = listBoosterOptions(ctx)));
  return options;
}

function listBoosterOptions(ctx: Context): BoosterOption[] {
  // Période à venir simulée (option `horizon`) : les invocations sont déjà proposées aujourd'hui.
  if (!ctx.features.has(FEATURE.invoke) || ctx.futureWindow) return [];
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
    const featured = new Map<number, Item[]>();
    for (const id of event.itemIds) {
      const item = ctx.items[id];
      if (!item || item.isFusion || item.isStar) continue;
      featured.set(item.rarity, [...(featured.get(item.rarity) ?? []), item]);
    }
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
      ...(featured.size > 0 ? { featured } : {}),
    });
  }
  return options;
}

const featuredPools = new WeakMap<BoosterOption, Pool>();

function featuredPool(ctx: Context, option: BoosterOption): Pool | null {
  if (!option.featured) return null;
  let pool = featuredPools.get(option);
  if (!pool) {
    pool = buildPool(
      ctx,
      option.key,
      [...option.featured.values()].flat(),
      duplicateWeights(ctx, true),
    );
    featuredPools.set(option, pool);
  }
  return pool;
}

const pityCache = new WeakMap<
  Float64Array,
  Map<string, { next: Float64Array; triggers: number }>
>();

/**
 * Fait avancer la bienveillance de `cards` cartes. `dist[d]` est la probabilité que la 4 ★
 * garantie soit la d-ième prochaine carte ; une 4 ★ naturelle (probabilité `pR4`) ou garantie
 * remet le compteur à 210. Renvoie la nouvelle distribution et le nombre espéré de 4 ★ garanties.
 */
export function pityStep(
  dist: Float64Array,
  cards: number,
  pR4: number,
): { next: Float64Array; triggers: number } {
  const key = `${cards}|${pR4}`;
  let cache = pityCache.get(dist);
  if (!cache) pityCache.set(dist, (cache = new Map()));
  const cached = cache.get(key);
  if (cached) return cached;

  let current = dist;
  let triggers = 0;
  for (let card = 0; card < cards; card++) {
    const next = new Float64Array(PITY_CARDS + 1);
    // d = 1 : 4 ★ garantie. Sinon 4 ★ naturelle (le compteur repart à 210) ou rapprochement d'un cran.
    let reset = current[1]!;
    triggers += reset;
    for (let d = 2; d <= PITY_CARDS; d++) {
      const mass = current[d]!;
      reset += mass * pR4;
      next[d - 1] = mass * (1 - pR4);
    }
    next[PITY_CARDS] = reset;
    current = next;
  }
  const result = { next: current, triggers };
  cache.set(key, result);
  return result;
}

/**
 * Espérance (en points) d'une invocation, cartes nouvelles attendues (par seau, et au total celles
 * que le joueur n'avait pas au début du plan), et bienveillance après l'invocation. Une 4 ★ garantie remplace un tirage ordinaire : son gain est
 * la valeur d'un tirage 4 ★ moins celle d'un tirage moyen, pondérée par la probabilité qu'elle
 * tombe pendant cette invocation.
 */
export function invocationEV(
  ctx: Context,
  state: State,
  option: BoosterOption,
): {
  ev: number;
  newCards: number;
  expectedNew: Record<string, number>;
  /** Tirages attendus de chaque carte, par seau (voir `State.drawsPerCard`). */
  draws: Record<string, number>;
  pity: Float64Array | null;
} {
  const pool = getPool(ctx, option.packId, true);
  const poolKey = `${option.packId ?? 'classic'}|true`;
  const featured = featuredPool(ctx, option);
  const expectedNew: Record<string, number> = {};
  const draws: Record<string, number> = {};
  let perCard = 0;
  let perCardFresh = 0;
  // Tirage d'une carte 4 ★ (pour la bienveillance) : valeur, cartes nouvelles par seau.
  let r4Value = 0;
  let r4Fresh = 0;
  const r4Buckets: [string, number, number][] = [];
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
      if (pShiny <= 0) continue;
      // Rareté mise en avant par l'évènement : seules ses cartes peuvent tomber.
      const featuredBucket = option.featured?.has(rarity)
        ? featured?.get(bucketKey(option.key, rarity, shiny))
        : undefined;
      const p = pRarity * pShiny;
      const drawn = option.cards * p;
      const { value, pNew, pFresh, key, size } = featuredBucket
        ? cardEV(ctx, state, option.key, featuredBucket, rarity, shiny, drawn)
        : cardEV(
            ctx,
            state,
            poolKey,
            pool.get(bucketKey(poolKey, rarity, shiny)),
            rarity,
            shiny,
            drawn,
          );
      perCard += p * value;
      perCardFresh += p * pFresh;
      expectedNew[key] = (expectedNew[key] ?? 0) + option.cards * p * pNew;
      if (size > 0) draws[key] = (draws[key] ?? 0) + drawn / size;
      if (rarity === 4) {
        r4Value += pShiny * value;
        r4Fresh += pShiny * pFresh;
        r4Buckets.push([key, pShiny * pNew, size > 0 ? pShiny / size : 0]);
      }
    }
  });
  let ev = perCard * option.cards;
  let newCards = perCardFresh * option.cards;
  let pity = state.pity;
  if (pity) {
    const step = pityStep(pity, option.cards, option.spec.rarity[3] ?? 0);
    pity = step.next;
    if (step.triggers > 0) {
      ev += step.triggers * (r4Value - perCard);
      newCards += step.triggers * (r4Fresh - perCardFresh);
      for (const [key, pNew, perCardDraws] of r4Buckets) {
        expectedNew[key] = (expectedNew[key] ?? 0) + step.triggers * pNew;
        draws[key] = (draws[key] ?? 0) + step.triggers * perCardDraws;
      }
    }
  }
  return { ev, newCards, expectedNew, draws, pity };
}

/** Seaux d'invocation contenant chaque carte (par brillance) : ne dépend que du catalogue. */
const membershipCache = new WeakMap<Context, Map<string, { key: string; bucket: PoolBucket }[]>>();

function bucketsOf(ctx: Context, item: Item, shiny: Shiny) {
  let cache = membershipCache.get(ctx);
  if (!cache) membershipCache.set(ctx, (cache = new Map()));
  const id = `${item.id}|${shiny}`;
  let list = cache.get(id);
  if (!list) {
    list = [];
    const seen = new Set<string>();
    for (const option of boosterOptions(ctx)) {
      const featured = option.featured?.has(item.rarity);
      const poolKey = featured ? option.key : `${option.packId ?? 'classic'}|true`;
      const key = bucketKey(poolKey, item.rarity, shiny);
      if (seen.has(key)) continue;
      seen.add(key);
      const bucket = featured
        ? featuredPool(ctx, option)?.get(key)
        : getPool(ctx, option.packId, true).get(key);
      if (bucket?.items.includes(item)) list.push({ key, bucket });
    }
    cache.set(id, list);
  }
  return list;
}

/**
 * Tirages espérés déjà attribués à une carte non possédée, par seau : chaque carte non possédée
 * d'un seau a la même chance d'avoir été tirée par les invocations simulées
 * (`attendues / non possédées`), et elle comptait alors pour ses points au lieu d'un doublon.
 */
export function expectedDraws(
  ctx: Context,
  state: State,
  item: Item,
  shiny: Shiny,
): { key: string; drawn: number; points: number; fresh: boolean }[] {
  const draws: { key: string; drawn: number; points: number; fresh: boolean }[] = [];
  const fresh = !ownedAtStart(ctx, item, shiny);
  for (const { key, bucket } of bucketsOf(ctx, item, shiny)) {
    const expected = state.expectedNew[key] ?? 0;
    if (expected <= 0) continue;
    const { unowned } = unownedIn(ctx, state, key, bucket, shiny);
    if (unowned <= 0) continue;
    const drawn = Math.min(1, expected / unowned);
    draws.push({ key, drawn, points: drawn * (item.scores[shiny] - bucket.dupValue), fresh });
  }
  return draws;
}

/**
 * Une carte obtenue à coup sûr (création, enchantement, fusion, évolution) après des invocations
 * simulées : leur espérance la comptait déjà comme nouvelle avec une certaine probabilité. Sans
 * correction, elle rapportait deux fois (tirage espéré puis forge), et un plan qui invoque avant
 * de forger les mêmes cartes paraissait meilleur que le même plan dans l'autre ordre. Son tirage
 * espéré redevient un doublon. À appeler avant que la carte n'entre dans la collection.
 */
export function settleExpectedNew(ctx: Context, state: State, item: Item, shiny: Shiny): void {
  for (const { key, drawn, points, fresh } of expectedDraws(ctx, state, item, shiny)) {
    state.ev -= points;
    if (fresh) state.expectedNewCards -= drawn;
    state.expectedNew = { ...state.expectedNew, [key]: state.expectedNew[key]! - drawn };
  }
}

/**
 * Un niveau de constellation monté à coup sûr après des invocations simulées : leur espérance
 * comptait déjà que leurs doublons de la carte le monteraient. Une carte tirée en moyenne `d` fois
 * et à qui il restait `n` niveaux en montait E[min(X, n)], X suivant une loi de Poisson de moyenne
 * `d` : avec un niveau de moins, E[min(X, n - 1)]. La différence, P(X ≥ n) niveaux, redevient du
 * recyclage. L'ordre des invocations et des constellations ne change donc pas la valeur d'un plan.
 * À appeler avant que le niveau ne monte.
 */
export function settleExpectedLevels(ctx: Context, state: State, item: Item, shiny: Shiny): void {
  const card = getCard(state, item.id, shiny);
  if (card.copies === 0 || !item.upgradable || shiny > 1 || card.constellation >= item.rarity)
    return;
  const levels = item.rarity - card.constellation;
  const points = item.scores[shiny] * CONSTELLATION_POINTS_FACTOR;
  for (const { key, bucket } of bucketsOf(ctx, item, shiny)) {
    const draws = state.drawsPerCard[key] ?? 0;
    if (draws <= 0) continue;
    state.ev -= (1 - fewerDraws(draws, levels)) * levelGain(ctx, bucket, 1, points);
  }
}

/**
 * Niveaux que les invocations simulées montent de plus (ou de moins) quand une carte entre dans
 * la collection (ou en sort) : non possédée, son premier tirage la donnait et les suivants
 * montaient ses niveaux ; possédée, tous ses tirages sont des doublons. Sans ça, créer une carte
 * que les invocations allaient sans doute donner semblait rapporter les niveaux que ses doublons
 * monteraient de toute façon, et le plan dépensait sa poudre à forger ces cartes.
 */
function shiftExpectedLevels(
  ctx: Context,
  state: State,
  item: Item,
  shiny: Shiny,
  sign: 1 | -1,
): void {
  const card = getCard(state, item.id, shiny);
  if (!item.upgradable || shiny > 1 || card.constellation >= item.rarity) return;
  const levels = item.rarity - card.constellation;
  const points = item.scores[shiny] * CONSTELLATION_POINTS_FACTOR;
  for (const { key, bucket } of bucketsOf(ctx, item, shiny)) {
    const draws = state.drawsPerCard[key] ?? 0;
    if (draws <= 0) continue;
    state.ev += sign * levelsOnceOwned(draws, levels) * levelGain(ctx, bucket, 1, points);
  }
}

/**
 * Variation de l'espérance des invocations simulées quand une carte entre dans la collection
 * (`obtained`, voir `creditExpectedLevels`) puis monte `constellations` niveaux à coup sûr (voir
 * `settleExpectedLevels`), sans rien appliquer : pour estimer un candidat de forge. Sans ça, une
 * chaîne « enchanter, constellation » sur une dorée que les invocations allaient monter semblait
 * rapporter tout son niveau, et ces chaînes évinçaient du faisceau les dépenses qui rapportaient.
 */
export function expectedLevelsShift(
  ctx: Context,
  state: State,
  item: Item,
  shiny: Shiny,
  obtained: boolean,
  constellations: number,
): number {
  const card = getCard(state, item.id, shiny);
  if (!item.upgradable || shiny > 1 || card.constellation >= item.rarity) return 0;
  const levels = item.rarity - card.constellation;
  const points = item.scores[shiny] * CONSTELLATION_POINTS_FACTOR;
  let delta = 0;
  for (const { key, bucket } of bucketsOf(ctx, item, shiny)) {
    const draws = state.drawsPerCard[key] ?? 0;
    if (draws <= 0) continue;
    const gain = levelGain(ctx, bucket, 1, points);
    if (obtained && card.copies === 0) delta += levelsOnceOwned(draws, levels) * gain;
    for (let k = 0; k < Math.min(constellations, levels); k++)
      delta -= (1 - fewerDraws(draws, levels - k)) * gain;
  }
  return delta;
}

/** À appeler avant qu'une carte non possédée n'entre dans la collection (voir `shiftExpectedLevels`). */
export function creditExpectedLevels(ctx: Context, state: State, item: Item, shiny: Shiny): void {
  if (getCard(state, item.id, shiny).copies === 0) shiftExpectedLevels(ctx, state, item, shiny, 1);
}

/** À appeler avant que le dernier exemplaire d'une carte ne quitte la collection. */
export function releaseExpectedLevels(ctx: Context, state: State, item: Item, shiny: Shiny): void {
  if (getCard(state, item.id, shiny).copies > 0) shiftExpectedLevels(ctx, state, item, shiny, -1);
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
  let pFreshReward = 0;
  for (const drop of floor.drops) {
    const { value, pFresh } = cardEV(
      ctx,
      state,
      poolKey,
      pool.get(bucketKey(poolKey, drop.rarity, drop.shiny)),
      drop.rarity,
      drop.shiny,
      null,
    );
    reward += drop.rate * value;
    pFreshReward += drop.rate * pFresh;
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
    newCards: floor.rate * pFreshReward,
  };
}
