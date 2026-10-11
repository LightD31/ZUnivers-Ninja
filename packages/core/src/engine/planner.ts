import { ASCENSION_COST } from '../rules/constants';
import { ascensionEV, boosterOptions, invocationEV } from '../rules/random';
import { reserveBeforeConstellation, reserveFor, reserveTotal } from '../rules/reserve';
import { CURRENCIES, type Balances, type Currency, type Item, type Shiny } from '../model/types';
import { actionKey, applyAction, type Action, type Applied, type RecycleEntry } from './actions';
import { canRecycle, craftCost, enchantCost, forgeCurrency, type Context } from './context';
import { getCard, initialState, stateValue, type State } from './state';

export interface Step {
  action: Action;
  /** Variation de la valeur (points + espérance + monnaies pondérées). */
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

    for (const fusion of ctx.catalog.fusions) {
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
    if (cards.length > 0)
      node = tryApply(ctx, node, { kind: 'recycle', cards }, true, next) ?? node;

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
export function candidates(ctx: Context, state: State): Candidate[] {
  const out: Candidate[] = [];
  const w = ctx.options.weights;
  const push = (actions: Action[], gain: number, cost: Partial<Balances>) => {
    if (gain <= EPSILON || !affordable(state, cost)) return;
    out.push({ actions, gain, cost: weighted(ctx, cost), key: actions.map(actionKey).join('>') });
  };
  const { allow } = ctx.options;
  const lists = forgeLists(ctx);

  if (allow.craft) {
    for (const item of lists.craft) {
      const cost = craftCost(ctx, item)!;
      const currency = forgeCurrency(item);
      const price = { [currency]: cost };
      const normal = getCard(state, item.id, 0);
      if (normal.copies === 0) {
        push([{ kind: 'craft', itemId: item.id }], item.scores[0] - cost * w[currency], price);
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
          item.scores[1] - (cost + enchant) * w[currency],
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
      const lostNormal = normal.copies === 1 ? item.scores[0] : 0;
      const golden = getCard(state, item.id, 1);
      if (golden.copies === 0) {
        push(
          [{ kind: 'enchant', itemId: item.id }],
          item.scores[1] - lostNormal - cost * w[currency],
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
      let gain = result.scores[0];
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
        if (copies === 0) gain += item.scores[0];
        cost = addCost(cost, forgeCurrency(item), unit * missing);
        for (let i = 0; i < missing; i++) actions.push({ kind: 'craft', itemId: item.id });
      }
      if (!feasible || actions.length === 0) continue;
      actions.push({ kind: 'fusion', itemId: result.id, shiny: 0 });
      push(actions, gain - weighted(ctx, cost), cost);
    }
  }

  if (allow.invoke) {
    for (const option of boosterOptions(ctx)) {
      if (option.oneTime && option.eventId && (state.eventInvocations[option.eventId] ?? 0) > 0)
        continue;
      const { ev } = invocationEV(ctx, state, option);
      push([{ kind: 'invoke', booster: option.key }], ev - weighted(ctx, option.cost), option.cost);
    }
  }

  if (allow.ascension && state.ascensionsLeft > 0) {
    const { ev } = ascensionEV(ctx, state);
    push([{ kind: 'ascension' }], ev - ASCENSION_COST * w.loreDust, { loreDust: ASCENSION_COST });
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

/** Garde les meilleurs candidats, moitié par gain absolu, moitié par efficacité. */
function selectCandidates(all: Candidate[], branching: number): Candidate[] {
  const byGain = [...all].sort((a, b) => b.gain - a.gain || a.key.localeCompare(b.key));
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

export interface SearchResult {
  root: SearchNode;
  best: SearchNode;
  explored: number;
  /** La limite de temps a été atteinte : la fin du plan a été cherchée en glouton. */
  timedOut: boolean;
}

/**
 * Recherche en faisceau : à chaque profondeur, on étend les meilleurs états avec leurs actions
 * candidates (suivies des actions sans regret), et on ne garde que les `beamWidth` meilleurs.
 * Passé `timeLimitMs`, on continue en glouton depuis le meilleur état pour finir le plan.
 */
export function search(ctx: Context): SearchResult {
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
      for (const candidate of selectCandidates(candidates(ctx, node.state), branching * 3)) {
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
    beam = [...children.values()]
      .sort(
        (a, b) => b.value - a.value || a.signature.join('|').localeCompare(b.signature.join('|')),
      )
      .slice(0, beamWidth);
    if (beam[0]!.value > best.value + EPSILON) best = beam[0]!;
  }

  return { root, best, explored, timedOut };
}
