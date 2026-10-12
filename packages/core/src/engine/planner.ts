import { ASCENSION_COST, FEATURE } from '../rules/constants';
import { ascensionEV, boosterOptions, invocationEV } from '../rules/random';
import { reserveBeforeConstellation, reserveFor, reserveTotal } from '../rules/reserve';
import {
  CURRENCIES,
  cardKey,
  type Balances,
  type Currency,
  type Item,
  type Shiny,
} from '../model/types';
import { goalCardMet } from './achievements';
import { actionKey, applyAction, type Action, type Applied, type RecycleEntry } from './actions';
import { canRecycle, craftCost, enchantCost, forgeCurrency, type Context } from './context';
import { getCard, initialState, stateValue, type State } from './state';

export interface Step {
  action: Action;
  /** Variation de la valeur (points + espérance + bonus de stratégie + monnaies pondérées). */
  gain: number;
  balanceDelta: Partial<Balances>;
  ev?: number;
  note?: string;
  /** Action « sans regret » appliquée automatiquement (journa, recyclage du surplus…). */
  auto: boolean;
}

interface StepLink {
  prev: StepLink | null;
  step: Step;
}

export interface SearchNode {
  state: State;
  value: number;
  steps: StepLink | null;
  /** Actions de dépense triées : deux ordres différents des mêmes actions sont dédupliqués. */
  signature: string[];
  depth: number;
}

export function nodeSteps(node: SearchNode): Step[] {
  const steps: Step[] = [];
  for (let link = node.steps; link; link = link.prev) steps.push(link.step);
  return steps.reverse();
}

const EPSILON = 1e-9;
/**
 * Un compte riche peut enchaîner des centaines d'invocations : une à une, elles épuisaient la
 * profondeur de recherche avant le solde. Au-delà de ce nombre d'invocations payables, elles sont
 * proposées par lots d'une fraction du solde.
 */
const INVOKE_STEPS = 50;
/** En deçà de ce nombre d'invocations du meilleur pack, tous les packs restent proposés. */
const INVOKE_TAIL = 4;
/** Cartes manquantes au plus pour proposer de terminer un succès de collection d'un coup. */
const ACHIEVEMENT_MISSING_MAX = 8;

function record(
  ctx: Context,
  node: SearchNode,
  action: Action,
  applied: Applied,
  auto: boolean,
): SearchNode {
  const value = stateValue(ctx, applied.state);
  const step: Step = {
    action,
    gain: value - node.value,
    balanceDelta: applied.balanceDelta,
    auto,
    ...(applied.ev !== undefined ? { ev: applied.ev } : {}),
    ...(applied.note ? { note: applied.note } : {}),
  };
  return { ...node, state: applied.state, value, steps: { prev: node.steps, step } };
}

function tryApply(
  ctx: Context,
  node: SearchNode,
  action: Action,
  auto: boolean,
  touched?: Set<string>,
): SearchNode | null {
  const applied = applyAction(ctx, node.state, action);
  if (!applied) return null;
  if (touched) for (const id of applied.touched) touched.add(id);
  return record(ctx, node, action, applied, auto);
}

/**
 * Fusions dont une carte (résultat ou composant) a changé. Les autres étaient déjà impossibles
 * avant : une fusion ne dépend que de ses cartes, et chaque état du faisceau sort de `closure`.
 */
function fusionsTouching(ctx: Context, touched: Set<string> | 'all') {
  if (touched === 'all') return ctx.catalog.fusions;
  const related = new Set<object>();
  for (const id of touched) {
    for (const f of ctx.fusionsByInput.get(id) ?? []) related.add(f);
    const asResult = ctx.fusionsByResult.get(id);
    if (asResult) related.add(asResult);
  }
  // Ordre du catalogue, pour un plan déterministe.
  return related.size === 0 ? [] : ctx.catalog.fusions.filter((f) => related.has(f));
}

/**
 * Cartes au plus par commande /recyclage. Le bot du jeu ne confirmait pas une commande de 562
 * cartes (« Je ne suis pas sûre d'avoir pris en compte ton action ») et rien n'était recyclé ;
 * une commande de 100 cartes passe (vérifié en jeu le 12/10/2026).
 */
export const RECYCLE_MAX_CARDS = 100;

/** Découpe un recyclage en commandes de `RECYCLE_MAX_CARDS` cartes au plus, dans l'ordre. */
function recycleChunks(cards: RecycleEntry[]): RecycleEntry[][] {
  const chunks: RecycleEntry[][] = [];
  let chunk: RecycleEntry[] = [];
  let size = 0;
  for (const entry of cards) {
    let left = entry.count;
    while (left > 0) {
      const count = Math.min(left, RECYCLE_MAX_CARDS - size);
      chunk.push({ ...entry, count });
      size += count;
      left -= count;
      if (size === RECYCLE_MAX_CARDS) {
        chunks.push(chunk);
        chunk = [];
        size = 0;
      }
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/**
 * Applique toutes les actions sans regret jusqu'à stabilité : récompenses quotidiennes, fusions
 * possibles sans toucher au dernier exemplaire, constellations avec les doublons, puis recyclage
 * du surplus réel.
 */
export function closure(
  ctx: Context,
  start: SearchNode,
  touchedInit: Set<string> | 'all',
): SearchNode {
  let node = start;
  for (const action of [{ kind: 'daily' }, { kind: 'weekly' }] as const) {
    node = tryApply(ctx, node, action, true) ?? node;
  }

  let touched: Set<string> | 'all' = touchedInit;
  for (let round = 0; round < 20; round++) {
    const next = new Set<string>();

    for (const fusion of fusionsTouching(ctx, touched)) {
      for (const shiny of [0, 1, 2] as Shiny[]) {
        node =
          tryApply(ctx, node, { kind: 'fusion', itemId: fusion.resultId, shiny }, true, next) ??
          node;
      }
    }

    const itemIds =
      touched === 'all'
        ? [...new Set([...node.state.cards.entries().values()].map((c) => c.itemId))]
        : [...touched, ...next];
    const sortedIds = [...new Set(itemIds)].sort();

    for (const itemId of sortedIds) {
      for (const shiny of [0, 1] as Shiny[]) {
        for (let guard = 0; guard < 10; guard++) {
          const after = tryApply(ctx, node, { kind: 'constellation', itemId, shiny }, true, next);
          if (!after) break;
          node = after;
        }
      }
    }

    const cards: RecycleEntry[] = [];
    for (const itemId of sortedIds) {
      const item = ctx.items[itemId];
      if (!item) continue;
      for (const shiny of [0, 1, 2] as Shiny[]) {
        const copies = getCard(node.state, itemId, shiny).copies;
        if (copies <= 1 || !canRecycle(ctx, item, shiny)) continue;
        const surplus = copies - reserveTotal(reserveFor(ctx, node.state, itemId, shiny));
        if (surplus > 0) cards.push({ itemId, shiny, count: surplus });
      }
    }
    for (const chunk of recycleChunks(cards))
      node = tryApply(ctx, node, { kind: 'recycle', cards: chunk }, true, next) ?? node;

    if (next.size === 0) break;
    touched = next;
  }
  return node;
}

interface Candidate {
  actions: Action[];
  /** Estimation du gain, utilisée seulement pour trier les candidats. */
  gain: number;
  /** Coût pondéré, pour l'efficacité. */
  cost: number;
  /** Coût en monnaies. */
  price: Partial<Balances>;
  key: string;
}

function weighted(ctx: Context, cost: Partial<Balances>): number {
  let v = 0;
  for (const c of CURRENCIES) v += (cost[c] ?? 0) * ctx.options.weights[c];
  return v;
}

function affordable(state: State, cost: Partial<Balances>): boolean {
  return CURRENCIES.every((c) => state.balances[c] >= (cost[c] ?? 0));
}

/** Nombre de fois qu'on peut payer `cost` avec le solde. */
function timesAffordable(state: State, cost: Partial<Balances>): number {
  let times = Infinity;
  for (const c of CURRENCIES) {
    const amount = cost[c] ?? 0;
    if (amount > 0) times = Math.min(times, Math.floor(state.balances[c] / amount));
  }
  return times;
}

function addCost(a: Partial<Balances>, currency: Currency, amount: number): Partial<Balances> {
  return { ...a, [currency]: (a[currency] ?? 0) + amount };
}

const forgeCache = new WeakMap<Context, { craft: Item[]; enchant: Item[] }>();

function forgeLists(ctx: Context) {
  let lists = forgeCache.get(ctx);
  if (!lists) {
    lists = {
      craft: ctx.itemList.filter((i) => craftCost(ctx, i) !== undefined),
      enchant: ctx.itemList.filter((i) => enchantCost(ctx, i) !== undefined),
    };
    forgeCache.set(ctx, lists);
  }
  return lists;
}

/** Actions de dépense prometteuses depuis un état. */
/** Actions possibles dans ce mode de jeu et voulues par les options (comme `applyAction`). */
function allowed(ctx: Context) {
  // Une action désactivée dans ce mode de jeu (pas de constellations en Hardcore, par exemple)
  // ne doit pas être proposée.
  const has = (feature: string) => ctx.features.has(feature);
  const { allow: wanted } = ctx.options;
  return {
    craft: wanted.craft && has(FEATURE.craft),
    enchant: wanted.enchant && has(FEATURE.craft),
    fusion: wanted.fusion && has(FEATURE.fusion),
    constellation: wanted.constellation && has(FEATURE.upgrade),
    invoke: wanted.invoke,
    ascension: wanted.ascension && has(FEATURE.tower),
    evolution: wanted.evolution && has(FEATURE.evolution),
  };
}

function candidate(
  ctx: Context,
  actions: Action[],
  gain: number,
  cost: Partial<Balances>,
): Candidate {
  return {
    actions,
    gain,
    cost: weighted(ctx, cost),
    price: cost,
    key: actions.map(actionKey).join('>'),
  };
}

/** Candidats de forge par contenu d'inventaire (une invocation ne change aucune carte). */
const forgeCandidateCache = new WeakMap<object, Map<number, Candidate[]>>();

/**
 * Création, enchantement et fusions à compléter, sans tenir compte du solde : ces candidats ne
 * dépendent que des cartes. Sur un compte riche, des centaines d'invocations s'enchaînent sans
 * toucher l'inventaire, et les recalculer à chaque étape dominait le temps de calcul.
 */
function forgeCandidates(ctx: Context, state: State): Candidate[] {
  const { layer, writes } = state.cards.snapshot();
  let cache = forgeCandidateCache.get(layer);
  if (!cache) forgeCandidateCache.set(layer, (cache = new Map()));
  const cached = cache.get(writes);
  if (cached) return cached;

  const out: Candidate[] = [];
  const w = ctx.options.weights;
  const bonus = ctx.options.newCardBonus;
  const push = (actions: Action[], gain: number, cost: Partial<Balances>) => {
    if (gain > EPSILON) out.push(candidate(ctx, actions, gain, cost));
  };
  const allow = allowed(ctx);
  const lists = forgeLists(ctx);

  if (allow.craft) {
    for (const item of lists.craft) {
      const cost = craftCost(ctx, item)!;
      const currency = forgeCurrency(item);
      const price = { [currency]: cost };
      const normal = getCard(state, item.id, 0);
      if (normal.copies === 0) {
        push(
          [{ kind: 'craft', itemId: item.id }],
          item.scores[0] + bonus - cost * w[currency],
          price,
        );
        continue;
      }
      const reserve = reserveFor(ctx, state, item.id, 0);
      if (
        allow.constellation &&
        item.upgradable &&
        normal.constellation < item.rarity &&
        // Un exemplaire de plus rend la constellation possible.
        normal.copies === reserveBeforeConstellation(reserve)
      ) {
        push(
          [
            { kind: 'craft', itemId: item.id },
            { kind: 'constellation', itemId: item.id, shiny: 0 },
          ],
          item.scores[0] * 2 + w.upgradeDust - cost * w[currency],
          price,
        );
      }
      const enchant = enchantCost(ctx, item);
      if (
        allow.enchant &&
        enchant !== undefined &&
        normal.copies === 1 &&
        getCard(state, item.id, 1).copies === 0
      ) {
        push(
          [
            { kind: 'craft', itemId: item.id },
            { kind: 'enchant', itemId: item.id },
          ],
          item.scores[1] + bonus - (cost + enchant) * w[currency],
          { [currency]: cost + enchant },
        );
      }
    }
  }

  if (allow.enchant) {
    for (const item of lists.enchant) {
      const normal = getCard(state, item.id, 0);
      if (normal.copies < 1) continue;
      const cost = enchantCost(ctx, item)!;
      const currency = forgeCurrency(item);
      // Enchanter le dernier exemplaire normal le retire de la collection.
      const lostNormal = normal.copies === 1 ? item.scores[0] + bonus : 0;
      const golden = getCard(state, item.id, 1);
      if (golden.copies === 0) {
        push(
          [{ kind: 'enchant', itemId: item.id }],
          item.scores[1] + bonus - lostNormal - cost * w[currency],
          {
            [currency]: cost,
          },
        );
      } else if (
        allow.constellation &&
        item.upgradable &&
        golden.constellation < item.rarity &&
        golden.copies === reserveBeforeConstellation(reserveFor(ctx, state, item.id, 1))
      ) {
        push(
          [
            { kind: 'enchant', itemId: item.id },
            { kind: 'constellation', itemId: item.id, shiny: 1 },
          ],
          item.scores[1] * 2 + w.upgradeDust - lostNormal - cost * w[currency],
          { [currency]: cost },
        );
      }
    }
  }

  // Compléter une fusion en forgeant les composants manquants.
  if (allow.fusion && allow.craft) {
    const keep = 1 + ctx.options.keepExtra;
    for (const fusion of ctx.catalog.fusions) {
      const result = ctx.items[fusion.resultId];
      if (!result || getCard(state, result.id, 0).copies > 0) continue;
      const actions: Action[] = [];
      let cost: Partial<Balances> = {};
      let gain = result.scores[0] + bonus;
      let feasible = true;
      for (const input of fusion.inputs) {
        const item = ctx.items[input.itemId];
        const copies = getCard(state, input.itemId, 0).copies;
        const missing = input.quantity + keep - copies;
        if (missing <= 0) continue;
        const unit = item ? craftCost(ctx, item) : undefined;
        if (!item || unit === undefined || missing > 6) {
          feasible = false;
          break;
        }
        if (copies === 0) gain += item.scores[0] + bonus;
        cost = addCost(cost, forgeCurrency(item), unit * missing);
        for (let i = 0; i < missing; i++) actions.push({ kind: 'craft', itemId: item.id });
      }
      if (!feasible || actions.length === 0) continue;
      actions.push({ kind: 'fusion', itemId: result.id, shiny: 0 });
      push(actions, gain - weighted(ctx, cost), cost);
    }
  }

  // Terminer un succès de collection en forgeant toutes les cartes qui manquent : carte par
  // carte, le faisceau ne verrait les points du succès qu'à la dernière.
  ctx.achievements.forEach((goal, index) => {
    const missing = goal.max - state.achievements[index]!;
    if (!goal.cards || goal.constellation || missing <= 0 || missing > ACHIEVEMENT_MISSING_MAX)
      return;
    const actions: Action[] = [];
    let cost: Partial<Balances> = {};
    let gain = goal.score + goal.rewardLoreDust * w.loreDust;
    for (const { itemId, shiny } of goal.cards) {
      const item = ctx.items[itemId];
      if (!item) return;
      if (goalCardMet((s) => state.cards.get(cardKey(itemId, s)), item.rarity, shiny, false))
        continue;
      const normal = getCard(state, itemId, 0).copies;
      if (shiny === 1) {
        const enchant = enchantCost(ctx, item);
        if (!allow.enchant || enchant === undefined) return;
        if (normal === 0) {
          const craft = craftCost(ctx, item);
          if (!allow.craft || craft === undefined) return;
          actions.push({ kind: 'craft', itemId });
          cost = addCost(cost, forgeCurrency(item), craft);
        }
        actions.push({ kind: 'enchant', itemId });
        cost = addCost(cost, forgeCurrency(item), enchant);
        gain += item.scores[1] + bonus - (normal === 1 ? item.scores[0] + bonus : 0);
      } else {
        const craft = craftCost(ctx, item);
        if (!allow.craft || craft === undefined) return;
        actions.push({ kind: 'craft', itemId });
        cost = addCost(cost, forgeCurrency(item), craft);
        gain += item.scores[0] + bonus;
      }
    }
    if (actions.length > 0) push(actions, gain - weighted(ctx, cost), cost);
  });

  cache.set(writes, out);
  return out;
}

export function candidates(ctx: Context, state: State): Candidate[] {
  // Création, enchantement, fusions à compléter : ne dépendent que des cartes, mis en cache.
  const out: Candidate[] = forgeCandidates(ctx, state).filter((c) => affordable(state, c.price));
  const w = ctx.options.weights;
  // Bonus des cartes nouvelles et part de l'espérance retenue : mêmes termes que `stateValue`.
  const bonus = ctx.options.newCardBonus;
  const evFactor = ctx.options.evFactor;
  const push = (actions: Action[], gain: number, cost: Partial<Balances>) => {
    if (gain <= EPSILON || !affordable(state, cost)) return;
    out.push(candidate(ctx, actions, gain, cost));
  };
  const allow = allowed(ctx);

  if (allow.invoke) {
    const repeatable: Candidate[] = [];
    for (const option of boosterOptions(ctx)) {
      if (option.oneTime && option.eventId && (state.eventInvocations[option.eventId] ?? 0) > 0)
        continue;
      const { ev, newCards } = invocationEV(ctx, state, option);
      const gain = (ev + newCards * bonus) * evFactor - weighted(ctx, option.cost);
      const action: Action = { kind: 'invoke', booster: option.key };
      if (option.oneTime) push([action], gain, option.cost);
      else if (gain > EPSILON && affordable(state, option.cost))
        repeatable.push(candidate(ctx, [action], gain, option.cost));
    }
    // Packs répétables : seul le plus rentable par monnaie dépensée est proposé. Le faisceau
    // compare des étapes, et à une invocation par étape le pack le plus cher l'emportait parce
    // qu'il fait plus de valeur par invocation, même quand il en fait moins par ZUMonnaie.
    const best = repeatable.reduce<Candidate | null>(
      (a, c) => (!a || c.gain * a.cost > a.gain * c.cost ? c : a),
      null,
    );
    const times = best ? timesAffordable(state, best.price) : 0;
    if (best && times < INVOKE_TAIL) {
      // Fin du solde : un autre pack peut mieux l'épuiser, le faisceau compare les combinaisons.
      out.push(...repeatable);
    } else if (best) {
      const count = Math.max(1, Math.floor(times / INVOKE_STEPS));
      const price: Partial<Balances> = {};
      for (const c of CURRENCIES) if (best.price[c]) price[c] = best.price[c] * count;
      out.push(candidate(ctx, Array(count).fill(best.actions[0]), best.gain * count, price));
    }
  }

  if (allow.ascension && state.ascensionsLeft > 0) {
    const { ev, newCards } = ascensionEV(ctx, state);
    push(
      [{ kind: 'ascension' }],
      (ev + newCards * bonus) * evFactor - ASCENSION_COST * w.loreDust,
      {
        loreDust: ASCENSION_COST,
      },
    );
  }

  const evolution = ctx.player.evolution;
  if (allow.evolution && evolution && state.evolutionIndex >= 0) {
    const current = evolution.steps[state.evolutionIndex];
    const next = evolution.steps[state.evolutionIndex + 1];
    const cost = evolution.costs[state.evolutionIndex];
    if (current && next && cost !== undefined) {
      push(
        [{ kind: 'evolution', fromItemId: current.itemId, toItemId: next.itemId }],
        next.score - current.score - cost * w.upgradeDust,
        { upgradeDust: cost },
      );
    }
  }

  return out;
}

/**
 * Garde les meilleurs candidats, moitié par gain absolu, moitié par efficacité. Le gain absolu
 * déduit la valeur d'opportunité des monnaies dépensées (`shadow`).
 */
function selectCandidates(all: Candidate[], branching: number, shadow?: Balances): Candidate[] {
  const net = new Map<Candidate, number>();
  for (const c of all) {
    let gain = c.gain;
    if (shadow) for (const cur of CURRENCIES) gain -= (c.price[cur] ?? 0) * shadow[cur];
    net.set(c, gain);
  }
  const byGain = [...all].sort((a, b) => net.get(b)! - net.get(a)! || a.key.localeCompare(b.key));
  const byEfficiency = [...all].sort(
    (a, b) => b.gain / (b.cost + 1) - a.gain / (a.cost + 1) || a.key.localeCompare(b.key),
  );
  const chosen = new Map<string, Candidate>();
  const half = Math.ceil(branching / 2);
  for (const c of byGain.slice(0, half)) chosen.set(c.key, c);
  for (const c of byEfficiency) {
    if (chosen.size >= branching) break;
    chosen.set(c.key, c);
  }
  for (const c of byGain) {
    if (chosen.size >= branching) break;
    chosen.set(c.key, c);
  }
  return [...chosen.values()];
}

/**
 * Valeur d'opportunité d'une unité de chaque monnaie, au-delà de son poids : le gain par unité de
 * la dernière dépense nécessaire pour épuiser le solde, en prenant les dépenses les plus
 * rentables d'abord (prix marginal d'un sac à dos fractionnaire). Zéro quand le solde suffit à
 * tout acheter.
 *
 * Avec des poids faibles, une grosse dépense peu rentable rapporte plus de valeur immédiate que
 * plusieurs petites très rentables : sans ce prix, le faisceau la préfère et élimine les plans
 * qui auraient mieux utilisé le même budget.
 */
export function shadowPrices(ctx: Context, state: State): Balances {
  const all = candidates(ctx, state);
  const prices = {} as Balances;
  for (const currency of CURRENCIES) {
    const uses: { amount: number; perUnit: number }[] = [];
    for (const c of all) {
      const amount = c.price[currency] ?? 0;
      // Seules les dépenses dans cette seule monnaie donnent un prix lisible.
      if (amount <= 0 || Object.keys(c.price).length !== 1) continue;
      const perUnit = c.gain / amount + ctx.options.weights[currency];
      if (perUnit > 0) uses.push({ amount, perUnit });
    }
    uses.sort((a, b) => b.perUnit - a.perUnit);
    let budget = state.balances[currency];
    let marginal = 0;
    for (const use of uses) {
      if (budget <= 0) break;
      marginal = use.perUnit;
      budget -= use.amount;
    }
    prices[currency] = budget > 0 ? 0 : Math.max(0, marginal - ctx.options.weights[currency]);
  }
  return prices;
}

export interface SearchResult {
  root: SearchNode;
  best: SearchNode;
  explored: number;
  /** La limite de temps a été atteinte : la fin du plan a été cherchée en glouton. */
  timedOut: boolean;
}

/**
 * Meilleur plan. Un succès rapporte beaucoup de points d'un coup : le faisceau peut alors remplir
 * toutes ses places avec des variantes du plan qui l'obtient, et perdre un plan qui dépense mieux
 * le même budget. La recherche est donc faite aussi sans les succès, et le meilleur des deux plans
 * est gardé, évalué avec les succès : en tenir compte ne donne jamais un plan moins bon. Les deux
 * recherches se partagent la limite de temps.
 */
export function search(ctx: Context): SearchResult {
  if (ctx.achievements.length === 0) return beamSearch(ctx);
  const options = { ...ctx.options, timeLimitMs: ctx.options.timeLimitMs / 2 };
  const aware = beamSearch({ ...ctx, options });
  const blind = beamSearch({ ...ctx, options, achievements: [], achievementsByItem: new Map() });
  const replayed = rebuild(ctx, nodeSteps(blind.best));
  return {
    root: aware.root,
    best: replayed && replayed.value > aware.best.value + EPSILON ? replayed : aware.best,
    explored: aware.explored + blind.explored,
    timedOut: aware.timedOut || blind.timedOut,
  };
}

/** Rejoue des étapes dans ce contexte : mêmes actions, gains recalculés. */
function rebuild(ctx: Context, steps: Step[]): SearchNode | null {
  const state = initialState(ctx);
  let node: SearchNode | null = {
    state,
    value: stateValue(ctx, state),
    steps: null,
    signature: [],
    depth: 0,
  };
  for (const step of steps) {
    node = tryApply(ctx, node, step.action, step.auto);
    if (!node) return null;
  }
  return node;
}

/**
 * Recherche en faisceau : à chaque profondeur, on étend les meilleurs états avec leurs actions
 * candidates (suivies des actions sans regret), et on ne garde que les `beamWidth` meilleurs.
 * Passé `timeLimitMs`, on continue en glouton depuis le meilleur état pour finir le plan.
 */
function beamSearch(ctx: Context): SearchResult {
  const { maxDepth, timeLimitMs } = ctx.options;
  let { beamWidth, branching } = ctx.options;
  const deadline = timeLimitMs > 0 ? performance.now() + timeLimitMs : Infinity;
  let timedOut = false;
  const state = initialState(ctx);
  const start: SearchNode = {
    state,
    value: stateValue(ctx, state),
    steps: null,
    signature: [],
    depth: 0,
  };
  const root = closure(ctx, start, 'all');

  // Le faisceau classe les plans en valorisant les monnaies restantes à leur prix d'opportunité ;
  // le meilleur plan reste choisi sur la vraie valeur.
  const shadow = shadowPrices(ctx, root.state);
  const rank = (node: SearchNode) => {
    let r = node.value;
    for (const c of CURRENCIES) r += node.state.balances[c] * shadow[c];
    return r;
  };

  let beam = [root];
  let best = root;
  let explored = 1;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (!timedOut && performance.now() > deadline) {
      timedOut = true;
      beamWidth = 1;
      branching = 1;
      beam = beam.slice(0, 1);
    }
    const children = new Map<string, SearchNode>();
    for (const node of beam) {
      // On essaie les candidats dans l'ordre jusqu'à obtenir `branching` enfants qui progressent.
      let improving = 0;
      for (const candidate of selectCandidates(
        candidates(ctx, node.state),
        branching * 3,
        shadow,
      )) {
        if (improving >= branching) break;
        let child: SearchNode | null = node;
        const touched = new Set<string>();
        for (const action of candidate.actions) {
          child = tryApply(ctx, child, action, false, touched);
          if (!child) break;
        }
        if (!child) continue;
        child = closure(ctx, child, touched);
        explored++;
        if (child.value <= node.value + EPSILON) continue;
        improving++;
        const signature = [...node.signature, candidate.key].sort();
        const sigKey = signature.join('|');
        const previous = children.get(sigKey);
        if (!previous || child.value > previous.value) {
          children.set(sigKey, { ...child, signature, depth });
        }
      }
    }
    if (children.size === 0) break;
    const ranked = [...children.values()].map((node) => ({ node, rank: rank(node) }));
    ranked.sort(
      (a, b) =>
        b.rank - a.rank || a.node.signature.join('|').localeCompare(b.node.signature.join('|')),
    );
    beam = ranked.slice(0, beamWidth).map((r) => r.node);
    for (const { node } of ranked) if (node.value > best.value + EPSILON) best = node;
  }

  return { root, best, explored, timedOut };
}
