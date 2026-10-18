import { ASCENSION_COST, CONSTELLATION_UPGRADE_DUST, FEATURE } from '../rules/constants';
import { ascensionEV, boosterOptions, expectedDraws, invocationEV } from '../rules/random';
import { reserveBeforeConstellation, reserveFor, reserveTotal } from '../rules/reserve';
import {
  CURRENCIES,
  cardKey,
  type Balances,
  type Currency,
  type Item,
  type OwnedCard,
  type Shiny,
} from '../model/types';
import { goalCardMet } from './achievements';
import { actionKey, applyAction, type Action, type Applied, type RecycleEntry } from './actions';
import { canRecycle, craftCost, enchantCost, forgeCurrency, type Context } from './context';
import { CARD_SEPARATOR, COMMAND_MAX_LENGTH, cardsToken, commandPrefix } from './commands';
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
/** Éclats d'étoile manquants au plus pour proposer les constellations qui débloquent l'évolution. */
const EVOLUTION_REACH = 10;
/**
 * Part du gain du plan qu'il peut perdre au plus quand ses commandes sont regroupées (voir
 * `regroup`), et au moins ce nombre de points : seule l'espérance des tirages bouge.
 */
const REGROUP_TOLERANCE = 0.001;
const REGROUP_TOLERANCE_POINTS = 0.5;
/** Profondeurs entre deux calculs du prix d'opportunité des monnaies. */
const SHADOW_REFRESH = 20;
/** Exemplaires créés ou enchantés au plus pour atteindre le niveau de constellation suivant. */
const CHAIN_MAX = 4;
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
 * Découpe un recyclage en commandes d'au plus `COMMAND_MAX_LENGTH` caractères, dans l'ordre : le
 * jeu n'exécute pas une commande plus longue, et rien n'est recyclé.
 */
function recycleChunks(ctx: Context, cards: RecycleEntry[]): RecycleEntry[][] {
  const separator = CARD_SEPARATOR.length;
  // Chaque carte compte avec un séparateur ; le premier est en trop, d'où la marge d'un séparateur.
  const budget = COMMAND_MAX_LENGTH - commandPrefix('recycle').length + separator;
  const chunks: RecycleEntry[][] = [];
  let chunk: RecycleEntry[] = [];
  let used = 0;
  for (const entry of cards) {
    const identifier = ctx.items[entry.itemId]?.identifier ?? 0;
    // Place prise par `count` exemplaires de la carte, séparateur compris.
    const width = (count: number) => cardsToken(identifier, entry.shiny, count).length + separator;
    let left = entry.count;
    while (left > 0) {
      // Plus grand nombre d'exemplaires qui tient encore dans la commande. La place prise ne
      // diminue pas avec la quantité : une recherche dichotomique suffit.
      let room = 0;
      for (let lo = 1, hi = left; lo <= hi;) {
        const mid = (lo + hi) >> 1;
        if (width(mid) <= budget - used) {
          room = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (room === 0 && chunk.length > 0) {
        chunks.push(chunk);
        chunk = [];
        used = 0;
        continue;
      }
      const count = Math.max(1, room);
      chunk.push({ ...entry, count });
      used += width(count);
      left -= count;
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
    for (const chunk of recycleChunks(ctx, cards))
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
  /** Cartes qui entrent dans la collection (espérance des invocations simulées, succès). */
  obtains?: [Item, Shiny][];
  /** Succès dont les points sont déjà comptés dans `gain` (candidat qui le termine). */
  completes?: number;
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

const forgeCache = new WeakMap<Context, Item[]>();

/** Cartes qu'on peut créer ou enchanter en ce moment. */
function forgeList(ctx: Context): Item[] {
  let list = forgeCache.get(ctx);
  if (!list) {
    list = ctx.itemList.filter(
      (i) => craftCost(ctx, i) !== undefined || enchantCost(ctx, i) !== undefined,
    );
    forgeCache.set(ctx, list);
  }
  return list;
}

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
  obtains?: [Item, Shiny][],
): Candidate {
  return {
    actions,
    gain,
    cost: weighted(ctx, cost),
    price: cost,
    key: actions.map(actionKey).join('>'),
    ...(obtains && obtains.length > 0 ? { obtains } : {}),
  };
}

/**
 * Gain d'un candidat de forge selon l'état, en plus de ce que donnent ses cartes (mis en cache) :
 * - après des invocations simulées, une carte qu'elles comptaient déjà comme probable rapporte
 *   d'autant moins (voir `settleExpectedNew`). Sans ça, le faisceau explorait des créations
 *   estimées rentables qui ne rapportaient plus rien, et s'arrêtait avec des monnaies à dépenser ;
 * - une carte qui termine un succès de collection rapporte aussi ses points. Sans ça, la dernière
 *   carte d'un succès (une fusion ★★★★★, par exemple) semblait trop chère pour être explorée.
 */
function adjusted(
  ctx: Context,
  state: State,
  c: Candidate,
  /** Valeur des tirages espérés par carte et brillance, `null` sans invocation simulée. */
  drawn: Map<Item, number>[] | null,
  near: Set<number>,
): Candidate {
  if (!c.obtains) return c;
  let delta = 0;
  if (drawn) {
    for (const [item, shiny] of c.obtains) {
      let lost = drawn[shiny]!.get(item);
      if (lost === undefined) {
        lost = 0;
        for (const draw of expectedDraws(ctx, state, item, shiny))
          lost += draw.points + (draw.fresh ? draw.drawn * ctx.options.newCardBonus : 0);
        drawn[shiny]!.set(item, lost);
      }
      delta -= lost * ctx.options.evFactor;
    }
  }
  if (near.size > 0) {
    let progress: Map<number, number> | null = null;
    for (const [item, shiny] of c.obtains) {
      const goals = ctx.achievementsByItem.get(item.id);
      if (!goals) continue;
      const get = (s: Shiny) => state.cards.get(cardKey(item.id, s));
      for (const goal of goals) {
        if (!near.has(goal.index) || goal.index === c.completes) continue;
        if (goal.shiny !== null && goal.shiny !== shiny) continue;
        if (goalCardMet(get, item.rarity, goal.shiny, false)) continue;
        progress ??= new Map();
        progress.set(goal.index, (progress.get(goal.index) ?? 0) + 1);
      }
    }
    for (const [index, count] of progress ?? []) {
      const goal = ctx.achievements[index]!;
      if (state.achievements[index]! + count >= goal.max)
        delta += goal.score + goal.rewardLoreDust * ctx.options.weights.loreDust;
    }
  }
  return delta !== 0 ? { ...c, gain: c.gain + delta } : c;
}

/**
 * Succès de collection qu'un candidat peut terminer : ceux à quelques cartes près (un candidat en
 * obtient peu à la fois).
 */
function nearAchievements(ctx: Context, state: State): Set<number> {
  const near = new Set<number>();
  ctx.achievements.forEach((goal, index) => {
    const missing = goal.max - state.achievements[index]!;
    if (goal.cards && !goal.constellation && missing > 0 && missing <= ACHIEVEMENT_MISSING_MAX)
      near.add(index);
  });
  return near;
}

/** Candidats de forge d'une carte, par état de la carte : ils ne dépendent que de lui. */
const itemCandidateCache = new WeakMap<Context, Map<string, Candidate[]>>();

/**
 * Création et enchantement, seuls ou suivis de la constellation qu'ils rendent possible. Une
 * chaîne se juge d'un bloc : la première dorée d'une carte rapporte peu face à son prix, mais
 * elle ouvre ses niveaux de constellation dorée, parmi les dépenses les plus rentables du jeu.
 * Étape par étape, le faisceau ne l'explorait pas et dépensait la poudre en cartes ★★★★.
 * Mis en cache par état de la carte : après une forge, seules quelques cartes changent.
 */
function itemCandidates(
  ctx: Context,
  state: State,
  item: Item,
  allow: ReturnType<typeof allowed>,
): Candidate[] {
  const normal = getCard(state, item.id, 0);
  const golden = getCard(state, item.id, 1);
  // Exemplaires que la constellation ne consomme pas (au moins 1), 0 quand elle est impossible.
  const reserved = [normal, golden].map((card, shiny) =>
    allow.constellation && item.upgradable && card.constellation < item.rarity
      ? reserveBeforeConstellation(reserveFor(ctx, state, item.id, shiny as Shiny))
      : 0,
  ) as [number, number];
  const key = `${item.id}|${normal.copies}|${normal.constellation}|${golden.copies}|${golden.constellation}|${reserved.join('|')}`;
  let cache = itemCandidateCache.get(ctx);
  if (!cache) itemCandidateCache.set(ctx, (cache = new Map()));
  const cached = cache.get(key);
  if (cached) return cached;

  const out: Candidate[] = [];
  const w = ctx.options.weights;
  const bonus = ctx.options.newCardBonus;
  // Une carte de succès est gardée même à gain négatif : la terminer peut rapporter le succès.
  const achievement = ctx.achievementsByItem.has(item.id);
  const push = (
    actions: Action[],
    gain: number,
    cost: Partial<Balances>,
    obtains: [Item, Shiny][] = [],
  ) => {
    if (gain > EPSILON || (achievement && obtains.length > 0))
      out.push(candidate(ctx, actions, gain, cost, obtains));
  };
  const craft = allow.craft ? craftCost(ctx, item) : undefined;
  const enchant = allow.enchant ? enchantCost(ctx, item) : undefined;
  const currency = forgeCurrency(item);
  const [normalScore, goldenScore] = [item.scores[0] + bonus, item.scores[1] + bonus];
  const crafts = (n: number): Action[] =>
    Array.from({ length: n }, () => ({ kind: 'craft', itemId: item.id }));
  /** Exemplaires à ajouter pour monter un niveau de constellation (0 si impossible). */
  const toNextLevel = (card: OwnedCard, reserved: number) => {
    const needed = reserved + 1 - card.copies;
    return reserved > 0 && needed <= CHAIN_MAX ? Math.max(0, needed) : 0;
  };

  if (craft !== undefined) {
    const obtains: [Item, Shiny][] = normal.copies === 0 ? [[item, 0]] : [];
    if (normal.copies === 0)
      push(crafts(1), normalScore - craft * w[currency], { [currency]: craft }, obtains);
    const needed = toNextLevel(normal, reserved[0]);
    if (needed > 0)
      push(
        [...crafts(needed), { kind: 'constellation', itemId: item.id, shiny: 0 }],
        (normal.copies === 0 ? normalScore : 0) +
          item.scores[0] * 2 +
          w.upgradeDust -
          needed * craft * w[currency],
        { [currency]: needed * craft },
        obtains,
      );
  }

  if (enchant !== undefined) {
    // Dorées à obtenir : la première, ou de quoi monter un niveau de constellation dorée.
    const targets: { goldens: number; actions: Action[]; gain: number }[] = [];
    if (golden.copies === 0) targets.push({ goldens: 1, actions: [], gain: goldenScore });
    const goldens = toNextLevel(golden, reserved[1]);
    if (goldens > 0)
      targets.push({
        goldens,
        actions: [{ kind: 'constellation', itemId: item.id, shiny: 1 }],
        gain: (golden.copies === 0 ? goldenScore : 0) + item.scores[1] * 2 + w.upgradeDust,
      });
    for (const target of targets) {
      // Exemplaires normaux à enchanter : ceux possédés, complétés par des créations. Enchanter
      // le dernier le retire de la collection ; en créer un de plus l'y garde.
      const least = Math.max(0, target.goldens - normal.copies);
      for (const created of new Set([least, least + 1])) {
        if (created > 0 && craft === undefined) continue;
        const left = normal.copies + created - target.goldens;
        const normalDelta = (Number(left > 0) - Number(normal.copies > 0)) * normalScore;
        const cost = created * (craft ?? 0) + target.goldens * enchant;
        push(
          [
            ...crafts(created),
            ...Array.from({ length: target.goldens }, (): Action => ({
              kind: 'enchant',
              itemId: item.id,
            })),
            ...target.actions,
          ],
          target.gain + normalDelta - cost * w[currency],
          { [currency]: cost },
          [
            ...(golden.copies === 0 ? [[item, 1] as [Item, Shiny]] : []),
            ...(normalDelta > 0 ? [[item, 0] as [Item, Shiny]] : []),
          ],
        );
      }
    }
  }

  cache.set(key, out);
  return out;
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
  // Gardés même à gain négatif quand ils peuvent terminer un succès (voir `adjusted`).
  const push = (
    actions: Action[],
    gain: number,
    cost: Partial<Balances>,
    obtains: [Item, Shiny][],
    completes?: number,
  ) => {
    const achievement =
      ctx.achievements.length > 0 && obtains.some(([i]) => ctx.achievementsByItem.has(i.id));
    if (gain <= EPSILON && !achievement) return;
    const c = candidate(ctx, actions, gain, cost, obtains);
    out.push(completes === undefined ? c : { ...c, completes });
  };
  const allow = allowed(ctx);

  for (const item of forgeList(ctx)) out.push(...itemCandidates(ctx, state, item, allow));

  // Compléter une fusion en forgeant les composants manquants.
  if (allow.fusion && allow.craft) {
    const keep = 1 + ctx.options.keepExtra;
    for (const fusion of ctx.catalog.fusions) {
      const result = ctx.items[fusion.resultId];
      if (!result || getCard(state, result.id, 0).copies > 0) continue;
      const actions: Action[] = [];
      const obtains: [Item, Shiny][] = [[result, 0]];
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
        if (copies === 0) {
          gain += item.scores[0] + bonus;
          obtains.push([item, 0]);
        }
        cost = addCost(cost, forgeCurrency(item), unit * missing);
        for (let i = 0; i < missing; i++) actions.push({ kind: 'craft', itemId: item.id });
      }
      if (!feasible || actions.length === 0) continue;
      actions.push({ kind: 'fusion', itemId: result.id, shiny: 0 });
      push(actions, gain - weighted(ctx, cost), cost, obtains);
    }
  }

  // Terminer un succès de collection en forgeant toutes les cartes qui manquent : carte par
  // carte, le faisceau ne verrait les points du succès qu'à la dernière.
  ctx.achievements.forEach((goal, index) => {
    const missing = goal.max - state.achievements[index]!;
    if (!goal.cards || goal.constellation || missing <= 0 || missing > ACHIEVEMENT_MISSING_MAX)
      return;
    const actions: Action[] = [];
    const obtains: [Item, Shiny][] = [];
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
        obtains.push([item, 1]);
        cost = addCost(cost, forgeCurrency(item), enchant);
        gain += item.scores[1] + bonus - (normal === 1 ? item.scores[0] + bonus : 0);
      } else {
        const craft = craftCost(ctx, item);
        if (!allow.craft || craft === undefined) return;
        actions.push({ kind: 'craft', itemId });
        obtains.push([item, 0]);
        cost = addCost(cost, forgeCurrency(item), craft);
        gain += item.scores[0] + bonus;
      }
    }
    if (actions.length > 0) push(actions, gain - weighted(ctx, cost), cost, obtains, index);
  });

  cache.set(writes, out);
  return out;
}

/**
 * Actions de dépense prometteuses depuis un état. `affordableOnly: false` garde aussi celles que
 * le solde ne permet pas (pour savoir quelle monnaie manque, voir `shadowPrices`).
 */
export function candidates(ctx: Context, state: State, affordableOnly = true): Candidate[] {
  const payable = (cost: Partial<Balances>) => !affordableOnly || affordable(state, cost);
  // Création, enchantement, fusions à compléter : ne dépendent que des cartes, mis en cache.
  const out: Candidate[] = [];
  const drawn =
    Object.keys(state.expectedNew).length > 0 ? [new Map(), new Map(), new Map()] : null;
  const near = nearAchievements(ctx, state);
  for (const c of forgeCandidates(ctx, state)) {
    if (!payable(c.price)) continue;
    const estimated = adjusted(ctx, state, c, drawn, near);
    if (estimated.gain > EPSILON) out.push(estimated);
  }
  const w = ctx.options.weights;
  // Bonus des cartes nouvelles et part de l'espérance retenue : mêmes termes que `stateValue`.
  const bonus = ctx.options.newCardBonus;
  const evFactor = ctx.options.evFactor;
  const push = (actions: Action[], gain: number, cost: Partial<Balances>) => {
    if (gain <= EPSILON || !payable(cost)) return;
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
      else if (gain > EPSILON && payable(option.cost))
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
      const action: Action = {
        kind: 'evolution',
        fromItemId: current.itemId,
        toItemId: next.itemId,
      };
      const gain = next.score - current.score - cost * w.upgradeDust;
      push([action], gain, { upgradeDust: cost });
      // Évolution à quelques éclats près : les constellations les plus rentables qui les donnent,
      // puis l'évolution. Une à une, ces constellations ne valaient pas plus que d'autres
      // dépenses, et un plan pouvait finir à deux éclats d'une évolution de plusieurs centaines
      // de points.
      const missing = Math.ceil((cost - state.balances.upgradeDust) / CONSTELLATION_UPGRADE_DUST);
      if (gain > EPSILON && missing > 0 && missing <= EVOLUTION_REACH) {
        const chains: Candidate[] = [];
        const items = new Set<string>();
        const levels = out
          .filter((c) => c.actions.at(-1)?.kind === 'constellation' && !c.price.upgradeDust)
          .sort(
            (a, b) => b.gain / (b.cost + 1) - a.gain / (a.cost + 1) || (a.key < b.key ? -1 : 1),
          );
        for (const c of levels) {
          const last = c.actions.at(-1)!;
          if (last.kind !== 'constellation' || items.has(last.itemId)) continue;
          items.add(last.itemId);
          chains.push(c);
          if (chains.length === missing) break;
        }
        if (chains.length === missing) {
          let price: Partial<Balances> = {};
          for (const c of chains)
            for (const cur of CURRENCIES)
              if (c.price[cur]) price = addCost(price, cur, c.price[cur]);
          push(
            [...chains.flatMap((c) => c.actions), action],
            chains.reduce((sum, c) => sum + c.gain, 0) + gain,
            price,
          );
        }
      }
    }
  }

  return out;
}

/**
 * Garde les meilleurs candidats, moitié par gain absolu, moitié par efficacité. Le gain absolu
 * déduit la valeur d'opportunité des monnaies dépensées (`shadow`).
 */
function selectCandidates(all: Candidate[], branching: number, shadow?: Balances): Candidate[] {
  // Clés de tri calculées une fois : des centaines de candidats par état, triés deux fois.
  const scored = all.map((c) => {
    let net = c.gain;
    if (shadow) for (const cur of CURRENCIES) net -= (c.price[cur] ?? 0) * shadow[cur];
    return { c, net, efficiency: c.gain / (c.cost + 1) };
  });
  // Égalités départagées par la clé, en ordre de code (indépendant de la langue) : déterministe.
  const byKey = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    a.c.key < b.c.key ? -1 : a.c.key > b.c.key ? 1 : 0;
  const byGain = [...scored].sort((a, b) => b.net - a.net || byKey(a, b));
  const byEfficiency = [...scored].sort((a, b) => b.efficiency - a.efficiency || byKey(a, b));
  const chosen = new Map<string, Candidate>();
  const half = Math.ceil(branching / 2);
  for (const { c } of byGain.slice(0, half)) chosen.set(c.key, c);
  for (const { c } of byEfficiency) {
    if (chosen.size >= branching) break;
    chosen.set(c.key, c);
  }
  for (const { c } of byGain) {
    if (chosen.size >= branching) break;
    chosen.set(c.key, c);
  }
  return [...chosen.values()];
}

/**
 * Valeur d'opportunité d'une unité de chaque monnaie, au-delà de son poids : le gain par unité de
 * la meilleure dépense que le solde ne permet plus, quand on dépense en prenant toujours la plus
 * rentable (prix marginal d'un sac à dos). Zéro quand le solde suffit à tout acheter.
 *
 * Avec des poids faibles, une grosse dépense peu rentable rapporte plus de valeur immédiate que
 * plusieurs petites très rentables : sans ce prix, le faisceau la préfère et élimine les plans
 * qui auraient mieux utilisé le même budget.
 *
 * Les dépenses sont simulées une à une : une carte offre plusieurs niveaux de constellation, et
 * une dépense en ouvre d'autres. En ne comptant que les dépenses possibles au départ, le prix de
 * la poudre était souvent nul alors qu'elle venait à manquer.
 */
export function shadowPrices(ctx: Context, state: State): Balances {
  const start = { state, value: stateValue(ctx, state), steps: null, signature: [], depth: 0 };
  return rollout(ctx, start).prices;
}

/**
 * Dépenses gloutonnes, la plus rentable par unité d'abord, jusqu'à ce que chaque monnaie manque :
 * donne le prix d'opportunité des monnaies (`shadowPrices`) et un plan complet, comparé à celui du
 * faisceau.
 */
function rollout(ctx: Context, start: SearchNode): { prices: Balances; node: SearchNode } {
  const prices: Balances = { balance: 0, loreDust: 0, loreFragment: 0, upgradeDust: 0 };
  const open = new Set<Currency>(CURRENCIES);
  let node = start;
  for (let step = 0; step < ctx.options.maxDepth && open.size > 0; step++) {
    // Dépense la plus rentable par unité, dans une seule monnaie (seules à donner un prix lisible).
    let best: { candidate: Candidate; currency: Currency; perUnit: number } | null = null;
    for (const c of candidates(ctx, node.state, false)) {
      const spent = CURRENCIES.filter((cur) => (c.price[cur] ?? 0) > 0);
      if (spent.length !== 1 || !open.has(spent[0]!)) continue;
      const perUnit = c.gain / c.price[spent[0]!]!;
      if (
        !best ||
        perUnit > best.perUnit ||
        (perUnit === best.perUnit && c.key < best.candidate.key)
      )
        best = { candidate: c, currency: spent[0]!, perUnit };
    }
    if (!best) break;
    if (!affordable(node.state, best.candidate.price)) {
      prices[best.currency] = best.perUnit;
      open.delete(best.currency);
      continue;
    }
    let next: SearchNode | null = node;
    const touched = new Set<string>();
    for (const action of best.candidate.actions) {
      next = tryApply(ctx, next, action, false, touched);
      if (!next) break;
    }
    if (!next) {
      open.delete(best.currency);
      continue;
    }
    node = closure(ctx, next, touched);
  }
  return { prices, node };
}

/** Candidats essayés au plus par étape pour terminer un plan. */
const FINISH_TRIES = 24;

/**
 * Termine un plan avec les dépenses qui rapportent encore, la plus rentable d'abord. Le faisceau
 * classe les plans avec le prix d'opportunité des monnaies : une dépense qui rapporte tout juste
 * ce prix (une évolution, par exemple) lui est indifférente et pouvait rester de côté.
 */
function finish(ctx: Context, start: SearchNode): SearchNode {
  let node = start;
  for (let step = 0; step < ctx.options.maxDepth; step++) {
    const sorted = candidates(ctx, node.state).sort(
      (a, b) =>
        b.gain / (b.cost + 1) - a.gain / (a.cost + 1) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    let next: SearchNode | null = null;
    for (const c of sorted.slice(0, FINISH_TRIES)) {
      let child: SearchNode | null = node;
      const touched = new Set<string>();
      for (const action of c.actions) {
        child = tryApply(ctx, child, action, false, touched);
        if (!child) break;
      }
      if (!child) continue;
      child = closure(ctx, child, touched);
      if (child.value > node.value + EPSILON) {
        next = child;
        break;
      }
    }
    if (!next) break;
    node = next;
  }
  return node;
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

/** Actions qui se regroupent sur une même ligne de commande : elles gagnent à se suivre. */
const GROUPED = new Set<Action['kind']>(['recycle', 'craft', 'enchant', 'constellation']);

/**
 * Réordonne un plan pour regrouper ses commandes : les créations à la suite, puis les
 * enchantements, puis les constellations… au lieu de « enchanter X, constellation de X, enchanter
 * Y… », une commande par action. Chaque action est rejouée à sa nouvelle place : on prend la plus
 * ancienne action restante du même type que la précédente si elle est possible, sinon la plus
 * ancienne action restante possible. Les mêmes actions donnent les mêmes cartes et monnaies ; seule
 * l'espérance des tirages dépend un peu de l'ordre. Le plan réordonné est gardé s'il ne perd pas
 * plus de `REGROUP_TOLERANCE` de son gain, sinon l'ordre de la recherche est gardé.
 */
export function regroup(ctx: Context, steps: Step[]): Step[] {
  const original = rebuild(ctx, steps);
  const start = initialState(ctx);
  let node: SearchNode = {
    state: start,
    value: stateValue(ctx, start),
    steps: null,
    signature: [],
    depth: 0,
  };
  const done = steps.map(() => false);
  let first = 0;
  let kind: Action['kind'] | null = null;
  for (let placed = 0; placed < steps.length; placed++) {
    let index = -1;
    let next: SearchNode | null = null;
    const place = (sameKind: boolean) => {
      for (let i = first; i < steps.length; i++) {
        const step = steps[i]!;
        if (done[i] || (sameKind && step.action.kind !== kind)) continue;
        next = tryApply(ctx, node, step.action, step.auto);
        if (next) return i;
      }
      return -1;
    };
    if (kind && GROUPED.has(kind)) index = place(true);
    if (index < 0) index = place(false);
    if (index < 0 || !next) return steps;
    done[index] = true;
    node = next;
    kind = steps[index]!.action.kind;
    while (first < steps.length && done[first]) first++;
  }
  if (!original) return steps;
  const gain = Math.abs(original.value - stateValue(ctx, start));
  const tolerance = Math.max(REGROUP_TOLERANCE_POINTS, REGROUP_TOLERANCE * gain);
  if (node.value < original.value - tolerance) return steps;
  return nodeSteps(node);
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
  // le meilleur plan reste choisi sur la vraie valeur. Le prix est recalculé en chemin : les
  // dépenses déjà faites changent ce que vaut la suite (des invocations rendent inutile la
  // création des cartes qu'elles donneront), et un prix devenu trop haut faisait préférer les plus
  // petites dépenses, une à une, jusqu'à la profondeur maximale.
  const greedy = rollout(ctx, root);
  let shadow = greedy.prices;
  const rank = (node: SearchNode) => {
    let r = node.value;
    for (const c of CURRENCIES) r += node.state.balances[c] * shadow[c];
    return r;
  };

  let beam = [root];
  let best = root;
  let explored = 1;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (depth % SHADOW_REFRESH === 0 && !timedOut) shadow = shadowPrices(ctx, beam[0]!.state);
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
    const ranked = [...children].map(([key, node]) => ({ key, node, rank: rank(node) }));
    ranked.sort((a, b) => b.rank - a.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    beam = ranked.slice(0, beamWidth).map((r) => r.node);
    for (const { node } of ranked) if (node.value > best.value + EPSILON) best = node;
  }
  // Fin des plans, et filet de sécurité : le plan glouton du calcul des prix, s'il fait mieux.
  best = finish(ctx, best);
  const fallback = finish(ctx, greedy.node);
  if (fallback.value > best.value + EPSILON) best = fallback;

  return { root, best, explored, timedOut };
}
