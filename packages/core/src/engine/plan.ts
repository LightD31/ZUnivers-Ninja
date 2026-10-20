import { likelyGroup, seasonLastDay } from '../rules/calendar';
import { boosterOptions, invocationEV, type BoosterOption } from '../rules/random';
import { daysBetween, gameClock } from '../rules/time';
import {
  BOOSTERS,
  FEATURE,
  type BoosterSpec,
  SUBSCRIPTION_COST_LORE_DUST,
  SUBSCRIPTION_DAYS,
  SUBSCRIPTION_LOOT_BONUS,
  SUBSCRIPTION_PREMIUM_INVOCATIONS,
  WEEKLY_EVERY_DAILIES,
} from '../rules/constants';
import {
  SHINY_SUFFIX,
  type Balances,
  type Catalog,
  type Currency,
  type Player,
  type Shiny,
} from '../model/types';
import { applyAction, type Action, type ActionKind } from './actions';
import { CARD_SEPARATOR, COMMAND_MAX_LENGTH, cardsToken, commandLine } from './commands';
import {
  buildContext,
  craftCost,
  enchantCost,
  forgeCurrency,
  resolveOptions,
  type Context,
  type PlannerOptionsInput,
} from './context';
import { horizonReserves, withHorizon, type HorizonReserve } from './horizon';
import { nodeSteps, regroup, search, type Step } from './planner';
import { getCard, initialState, stateValue, type State } from './state';
import { STRATEGIES, type StrategyId } from './strategies';

export interface PlanCard {
  itemId: string;
  identifier: number;
  name: string;
  rarity: number;
  shiny: Shiny;
  count: number;
  image: string | null;
  /** Identifiant de la fiche de la carte sur zunivers.zerator.com (`/carte/<slug>`), vide si inconnu. */
  slug: string;
}

export interface PlanStep {
  kind: ActionKind;
  /** Commande Discord à taper. */
  command: string;
  title: string;
  detail: string | null;
  cards: PlanCard[];
  /** Gain de valeur estimé (points de collection + monnaies pondérées). */
  gain: number;
  /** Action aléatoire : le gain est une espérance. */
  random: boolean;
  auto: boolean;
  balanceDelta: Partial<Balances>;
  /** Succès débloqués par cette étape (noms). */
  achievements: string[];
}

export interface Snapshot {
  balances: Balances;
  points: number;
  /** Cartes uniques possédées par brillance (normale, dorée, chroma). */
  unique: [number, number, number];
  /** Cartes existantes par brillance. */
  total: [number, number, number];
  constellationLevels: number;
  constellationMax: number;
}

export interface ChallengeSummary {
  description: string;
  before: number;
  after: number;
  max: number;
  reward: number;
  plannable: boolean;
}

export interface AchievementSummary {
  name: string;
  description: string;
  before: number;
  after: number;
  max: number;
  /** Points de succès (classement général). */
  score: number;
  /** Poudre créatrice offerte. */
  reward: number;
}

export interface FusionInsight {
  result: PlanCard;
  inputs: { card: PlanCard; have: number; need: number }[];
  /** Tous les composants sont disponibles (en gardant un exemplaire de chacun). */
  ready: boolean;
}

export interface MissingCard {
  card: PlanCard;
  points: number;
  /** Coût de création si la carte est forgeable maintenant. */
  craftCost: number | null;
  currency: Currency | null;
}

export interface Insights {
  /** Fusions dont le résultat manque encore après le plan. */
  fusions: FusionInsight[];
  /** Cartes manquantes après le plan, les plus rentables en points d'abord. */
  missing: MissingCard[];
}

/** Anticipation (option `horizon`) : prochains Vortex prévus et monnaies gardées pour plus tard. */
export interface PlanHorizon {
  /** Prochains Vortex : dates (fin exclue), groupe le plus probable et sa probabilité. */
  seasons: { begin: string; end: string; group: string; probability: number }[];
  /** Monnaies que le plan garde pour une période à venir. */
  reserves: PlanReserve[];
}

/** Monnaies gardées pour une période à venir, et ce que la simulation de cette période y fait. */
export interface PlanReserve extends Omit<HorizonReserve, 'actions'> {
  /**
   * Commandes prévues pour cette période, regroupées comme le plan, avec la collection
   * d'aujourd'hui : à recalculer quand la période arrive.
   */
  preview: StepGroup[];
}

export interface PlanResult {
  version: 1;
  generatedAt: string;
  ruleSet: string;
  /** Mode de jeu fermé (pas de saison Hardcore en cours) : le plan est vide. */
  closed: boolean;
  /** Stratégie utilisée pour calculer le plan. */
  strategy: { id: StrategyId; label: string };
  player: {
    name: string;
    discordId: string | null;
    displayName: string;
    avatar: string | null;
    corporation: string | null;
    subscribed: boolean;
  };
  steps: PlanStep[];
  /** Étapes regroupées, dans l'ordre : une commande Discord par groupe. */
  groups: StepGroup[];
  /** Lignes de commandes, regroupées comme l'ancien ZUnivers Ninja (`/création carte:1001 + 1002`). */
  commands: string[];
  before: Snapshot;
  after: Snapshot;
  /** `achievements` : points des succès obtenus par le plan. */
  gain: { points: number; expected: number; value: number; achievements: number };
  challenges: ChallengeSummary[];
  /** Succès que le plan fait progresser, puis les plus proches d'être obtenus. */
  achievements: AchievementSummary[];
  advice: string[];
  season: {
    name: string;
    group: string;
    end: string;
    ascensionsLeft: number;
    /** Étage à tenter (à partir de 1). */
    floor: number;
    /** Sommet atteint : plus d'ascension possible cette saison. */
    summit: boolean;
  } | null;
  insights: Insights;
  /** Anticipation, quand l'option `horizon` est active. */
  horizon: PlanHorizon | null;
  stats: {
    explored: number;
    durationMs: number;
    beamWidth: number;
    branching: number;
    /** Limite de temps atteinte : la fin du plan a été cherchée en glouton. */
    timedOut: boolean;
    /** Anticipation : périodes à venir simulées, écartées, et temps passé. */
    horizon?: { windows: number; skipped: number; durationMs: number };
  };
  /** Empreinte des commandes, pour ne notifier que les changements. */
  hash: string;
}

const TITLE: Record<ActionKind, string> = {
  daily: 'Récompense journalière',
  weekly: 'Bonus hebdomadaire',
  recycle: 'Recycler le surplus',
  craft: 'Créer',
  enchant: 'Enchanter',
  fusion: 'Fusionner',
  constellation: 'Constellation',
  invoke: 'Invoquer',
  ascension: 'Ascension',
  evolution: 'Évolution',
};

/** Actions regroupables sur une même ligne de commande. */
const COMBINABLE = new Set<ActionKind>(['recycle', 'craft', 'enchant', 'constellation']);

function card(ctx: Context, itemId: string, shiny: Shiny, count = 1): PlanCard {
  const item = ctx.items[itemId];
  const urlIndex = shiny === 2 ? 3 : shiny;
  return {
    itemId,
    identifier: item?.identifier ?? 0,
    name: item?.name ?? itemId,
    rarity: item?.rarity ?? 0,
    shiny,
    count,
    image: item?.urls[urlIndex] ?? item?.urls[0] ?? null,
    slug: item?.slug ?? '',
  };
}

/** Exemplaires d'une carte dans une commande (`1001*2`, `1002+*3`). */
function cardRef(c: PlanCard, kind?: ActionKind): string {
  return cardsToken(c.identifier, c.shiny, c.count, kind);
}

/** Arguments d'une commande : ses cartes, séparées par ` + `. */
function cardsArgs(cards: Iterable<PlanCard>, kind?: ActionKind): string {
  return [...cards].map((c) => cardRef(c, kind)).join(CARD_SEPARATOR);
}

function describe(ctx: Context, step: Step, achievements: string[]): PlanStep {
  const action = step.action;
  const base = {
    kind: action.kind,
    gain: step.gain,
    random: step.ev !== undefined,
    auto: step.auto,
    balanceDelta: step.balanceDelta,
    detail: step.note ?? null,
    achievements,
  };
  const make = (
    cards: PlanCard[],
    args: string,
    title = TITLE[action.kind],
    detail = base.detail,
  ): PlanStep => ({
    ...base,
    cards,
    title,
    detail,
    command: commandLine(action.kind, args),
  });

  switch (action.kind) {
    case 'recycle': {
      const cards = action.cards.map((c) => card(ctx, c.itemId, c.shiny, c.count));
      return make(cards, cardsArgs(cards));
    }
    case 'craft':
    case 'enchant': {
      const c = card(ctx, action.itemId, action.kind === 'enchant' ? 1 : 0);
      return make([c], String(c.identifier), `${TITLE[action.kind]} ${c.name}`);
    }
    case 'fusion':
    case 'constellation': {
      const c = card(ctx, action.itemId, action.shiny);
      return make([c], cardRef(c), `${TITLE[action.kind]} ${c.name}${SHINY_SUFFIX[action.shiny]}`);
    }
    case 'invoke': {
      const option = boosterOptions(ctx).find((o) => o.key === action.booster);
      return make(
        [],
        option?.param ?? '',
        option?.label ?? TITLE.invoke,
        step.note
          ? `Gain espéré (tirage aléatoire) : ${step.note}`
          : 'Gain espéré (tirage aléatoire)',
      );
    }
    case 'evolution': {
      const from = action.fromItemId ? card(ctx, action.fromItemId, 0) : null;
      const to = card(ctx, action.toItemId, 0);
      return make([to], from ? String(from.identifier) : '', `Évolution : ${to.name}`);
    }
    default:
      return make([], '');
  }
}

const SHINY_PLURAL = { golden: 'dorées', chroma: 'chromas' } as const;

/** Part des cartes d'une invocation tirées dorées ou chromas. */
const shinyShare = (spec: BoosterSpec, shiny: keyof typeof SHINY_PLURAL) =>
  spec.rarity.reduce((sum, p, i) => sum + p * spec[shiny][i]!, 0);

/** 2 → « 2 », 2,67 → « 2,7 ». */
const ratio = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

/**
 * Invocation dorée ou chroma : ce qu'elle rapporte par ZUMonnaie face à la basique, moins chère.
 * Le planificateur compare les packs par ZUMonnaie dépensée, pas par invocation : sans le dire,
 * une chroma conseillée au double du prix d'une basique passait pour une erreur.
 */
function invocationNote(ctx: Context, state: State, booster: string): string | undefined {
  const options = boosterOptions(ctx);
  const option = options.find((o) => o.key === booster);
  const basic = options.find((o) => o.key === BOOSTERS.basic.kind);
  // Les invocations d'évènement ont les taux de la basique : seul leur pack change.
  const shiny = option?.spec.kind;
  if (!option || !basic || !shiny || shiny === 'basic') return undefined;
  // Même valeur que celle comparée par le planificateur (voir `candidates`).
  const perCoin = (o: BoosterOption) => {
    const { ev, newCards } = invocationEV(ctx, state, o);
    return (ev + newCards * ctx.options.newCardBonus) / o.spec.cost;
  };
  const reference = perCoin(basic);
  if (reference <= 0) return undefined;
  const percent = Math.round((perCoin(option) / reference - 1) * 100);
  // Moins rentable que la basique : le pack n'a servi qu'à finir le solde, rien à expliquer.
  if (percent < 1) return undefined;
  const price = ratio(option.spec.cost / basic.spec.cost);
  const more = ratio(shinyShare(option.spec, shiny) / shinyShare(basic.spec, shiny));
  return `${price} fois le prix de l'invocation basique pour ${more} fois plus de ${SHINY_PLURAL[shiny]}, soit ~${percent} % de points en plus par ZUMonnaie`;
}

export interface StepGroup {
  kind: ActionKind;
  /** Ligne de commande Discord. */
  command: string;
  title: string;
  detail: string | null;
  /** Cartes concernées (quantités fusionnées). */
  cards: PlanCard[];
  gain: number;
  random: boolean;
  auto: boolean;
  balanceDelta: Partial<Balances>;
  /** Succès débloqués par ces étapes (noms). */
  achievements: string[];
  /** Nombre d'actions élémentaires regroupées. */
  size: number;
}

function sumDelta(a: Partial<Balances>, b: Partial<Balances>): Partial<Balances> {
  const out: Partial<Balances> = { ...a };
  for (const [k, v] of Object.entries(b) as [Currency, number][]) out[k] = (out[k] ?? 0) + v;
  return out;
}

function groupTitle(kind: ActionKind, cards: PlanCard[], size: number, fallback: string): string {
  const count = cards.reduce((n, c) => n + c.count, 0);
  const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n > 1 ? many : word}`;
  switch (kind) {
    case 'recycle':
      return `Recycler ${plural(count, 'carte')} en surplus`;
    case 'craft':
      return size === 1 ? fallback : `Créer ${plural(count, 'carte')}`;
    case 'enchant':
      return size === 1 ? fallback : `Enchanter ${plural(count, 'carte')}`;
    case 'constellation':
      return size === 1
        ? fallback
        : `Constellations : ${plural(count, 'niveau', 'niveaux')} sur ${plural(cards.length, 'carte')}`;
    default:
      return fallback;
  }
}

/**
 * Trie chaque suite d'invocations consécutives par pack, dans l'ordre de première apparition.
 * Une invocation ne fait que dépenser des monnaies, sans rien rapporter avant la suivante : dans
 * une suite sans autre action, tout ordre reste payable et donne les mêmes cartes en moyenne.
 * Le joueur tape alors chaque pack d'affilée (22 classiques, puis 14 dorées…) au lieu de les
 * alterner au fil de la recherche.
 */
export function sortInvocations(steps: Step[]): Step[] {
  const out: Step[] = [];
  let i = 0;
  while (i < steps.length) {
    if (steps[i]!.action.kind !== 'invoke') {
      out.push(steps[i++]!);
      continue;
    }
    const byBooster = new Map<string, Step[]>();
    for (; i < steps.length; i++) {
      const { action } = steps[i]!;
      if (action.kind !== 'invoke') break;
      const run = byBooster.get(action.booster);
      if (run) run.push(steps[i]!);
      else byBooster.set(action.booster, [steps[i]!]);
    }
    for (const run of byBooster.values()) out.push(...run);
  }
  return out;
}

/**
 * Regroupe les actions consécutives combinables (création, enchantement, constellation) en une
 * seule commande, comme l'ancien ZUnivers Ninja (`/création carte:1001 + 1002`). Une commande
 * qui dépasserait `COMMAND_MAX_LENGTH` caractères est coupée : le jeu ne l'exécuterait pas.
 */
export function groupSteps(steps: PlanStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;
    if (!COMBINABLE.has(step.kind)) {
      groups.push({ ...step, size: 1 });
      i++;
      continue;
    }
    let counts = new Map<string, PlanCard>();
    let gain = 0;
    let balanceDelta: Partial<Balances> = {};
    let size = 0;
    let auto = true;
    const achievements: string[] = [];
    while (i < steps.length && steps[i]!.kind === step.kind) {
      const current = steps[i]!;
      const next = new Map(counts);
      for (const c of current.cards) {
        const key = `${c.itemId}:${c.shiny}`;
        const existing = next.get(key);
        next.set(key, existing ? { ...existing, count: existing.count + c.count } : { ...c });
      }
      const length = commandLine(step.kind, cardsArgs(next.values(), step.kind)).length;
      if (size > 0 && length > COMMAND_MAX_LENGTH) break;
      counts = next;
      gain += current.gain;
      balanceDelta = sumDelta(balanceDelta, current.balanceDelta);
      auto &&= current.auto;
      achievements.push(...current.achievements);
      size++;
      i++;
    }
    const cards = [...counts.values()];
    groups.push({
      kind: step.kind,
      command: size === 1 ? step.command : commandLine(step.kind, cardsArgs(cards, step.kind)),
      title: groupTitle(step.kind, cards, size, step.title),
      detail: size === 1 ? step.detail : null,
      cards,
      gain,
      random: false,
      auto,
      balanceDelta,
      achievements,
      size,
    });
  }
  return groups;
}

/** Lignes de commandes du plan. */
export const groupCommands = (steps: PlanStep[]): string[] =>
  groupSteps(steps).map((g) => g.command);

function snapshot(ctx: Context, state: State): Snapshot {
  const unique: [number, number, number] = [0, 0, 0];
  const total: [number, number, number] = [0, 0, 0];
  let constellationLevels = 0;
  let constellationMax = 0;
  for (const item of ctx.itemList) {
    for (const shiny of [0, 1, 2] as Shiny[]) {
      if (!item.shinyAvailable[shiny]) continue;
      total[shiny]++;
      const owned = getCard(state, item.id, shiny);
      if (owned.copies > 0) unique[shiny]++;
      if (item.upgradable && shiny <= 1) {
        constellationMax += item.rarity;
        constellationLevels += owned.constellation;
      }
    }
  }
  return {
    balances: { ...state.balances },
    points: state.points,
    unique,
    total,
    constellationLevels,
    constellationMax,
  };
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');
/** AAAA-MM-JJ → JJ/MM/AAAA */
const frDate = (date: string) => date.slice(0, 10).split('-').reverse().join('/');

/** Points espérés au moins pour signaler une monnaie gardée pour plus tard. */
const RESERVE_MIN_POINTS = 1;

/** Monnaies gardées pour plus tard qui valent d'être signalées. */
const shownReserves = (ctx: Context, after: State) =>
  ctx.horizon
    ? horizonReserves(ctx.horizon, after.balances).filter(
        (r) => r.amount >= 1 && r.value >= RESERVE_MIN_POINTS,
      )
    : [];

/** Monnaies gardées pour plus tard, avec les commandes prévues pour chaque période. */
function planReserves(ctx: Context, after: State): PlanReserve[] {
  return shownReserves(ctx, after).map(({ actions, ...reserve }) => {
    const steps = actions.map((action) =>
      describe(ctx, { action, gain: 0, balanceDelta: {}, auto: false }, []),
    );
    return { ...reserve, preview: groupSteps(steps) };
  });
}

/**
 * Échéances proches de l'anticipation : fin du Vortex et de sa forge, évènement, défis de la
 * semaine. Les monnaies gardées pour plus tard sont dans `PlanResult.horizon.reserves`, affichées
 * en tête du plan plutôt que parmi les conseils.
 */
function horizonAdvice(ctx: Context, after: State): string[] {
  const advice: string[] = [];
  const today = gameClock(ctx.now).date;
  const when = (left: number) => (left === 0 ? 'ce soir' : 'demain soir');
  const season = ctx.catalog.season;
  if (season) {
    const left = daysBetween(today, seasonLastDay(season));
    const opens = [...ctx.forgeablePacks].some((id) =>
      ctx.itemList.some((i) => i.packId === id && !i.isClassic),
    );
    if (left >= 0 && left <= 1 && opens) {
      const next = ctx.horizon?.forecasts.find((f) => likelyGroup(f) === season.group);
      advice.push(
        `Le Vortex « ${season.towerName} » se termine ${when(left)} : ${left === 0 ? 'dernier jour' : 'plus que deux jours'} pour forger les cartes du groupe « ${season.group} »${next ? ` (prochain Vortex « ${season.group} » prévu le ${frDate(next.begin)})` : ''}.`,
      );
    }
    if (left === 0 && after.ascensionsLeft > 0)
      advice.push(
        `${after.ascensionsLeft} essai(s) d'ascension non utilisé(s) seront perdus ce soir, à la fin du Vortex.`,
      );
  }
  for (const event of ctx.catalog.events) {
    const end = event.end.slice(0, 10);
    if (!event.active || event.begin.slice(0, 10) > today || end < today) continue;
    const left = daysBetween(today, end);
    if (left <= 1) advice.push(`L'évènement « ${event.name} » se termine ${when(left)}.`);
  }
  const ends = new Map(ctx.player.challenges.map((c) => [c.id, c.end?.slice(0, 10)]));
  const open = after.challenges.filter((c) => c.current < c.max);
  const end = open.map((c) => ends.get(c.id)).find((e) => e !== undefined);
  if (end && daysBetween(today, end) >= 0 && daysBetween(today, end) <= 1)
    advice.push(
      `Défis de la semaine : ${open.length} pas encore terminé(s), ils se terminent ${when(daysBetween(today, end))}.`,
    );
  return advice;
}

function buildAdvice(ctx: Context, before: State, after: State): string[] {
  const advice: string[] = [];
  const { player } = ctx;

  if (!after.weeklyDone && ctx.features.has(FEATURE.loot)) {
    const remaining = WEEKLY_EVERY_DAILIES - after.dailiesSinceWeekly;
    if (remaining > 0) advice.push(`Encore ${remaining} /journa avant le prochain /bonus.`);
  }

  if (player.invokeBeforePity != null && ctx.features.has(FEATURE.invoke)) {
    const left = player.invokeBeforePity;
    advice.push(
      `Bienveillance : carte 4 ★ garantie dans ${left} carte${left > 1 ? 's' : ''} invoquée${left > 1 ? 's' : ''} (${Math.ceil(left / 10)} invocation${left > 10 ? 's' : ''}).`,
    );
  }

  const trade = after.challenges.find(
    (c) => c.action === null && /chang/i.test(c.description) && c.current < c.max,
  );
  if (trade && player.tradesLeft > 0) {
    advice.push(
      `Défi « ${trade.description} » : il te reste ${player.tradesLeft} échange(s) aujourd'hui (le planificateur ne peut pas les faire pour toi).`,
    );
  }

  if (
    after.ascensionsLeft > 0 &&
    ctx.catalog.season &&
    Math.floor(after.towerFloor) < ctx.catalog.season.floors.length
  ) {
    advice.push(
      `${after.ascensionsLeft} ascension(s) disponible(s) non conseillée(s) (poudre insuffisante ou peu rentable). Elles restent cumulables jusqu'au ${frDate(ctx.catalog.season.end)}.`,
    );
  }

  if (!player.subscribed && ctx.features.has(FEATURE.subscription)) {
    const w = ctx.options.weights;
    const basic = boosterOptions(ctx).find((o) => o.key === BOOSTERS.basic.kind);
    const premiumEV = basic ? invocationEV(ctx, before, basic).ev : 0;
    const value =
      SUBSCRIPTION_DAYS * SUBSCRIPTION_LOOT_BONUS * w.balance +
      SUBSCRIPTION_PREMIUM_INVOCATIONS * premiumEV;
    const cost = SUBSCRIPTION_COST_LORE_DUST * w.loreDust;
    if (before.balances.loreDust >= SUBSCRIPTION_COST_LORE_DUST && value > cost) {
      advice.push(
        `L'abonnement (${fmt(SUBSCRIPTION_COST_LORE_DUST)} poudre) semble rentable : ~${fmt(value)} points espérés pour ~${fmt(cost)} points de poudre.`,
      );
    }
  }

  if (ctx.horizon) advice.push(...horizonAdvice(ctx, after));

  const unspent = (Object.keys(after.balances) as Currency[]).filter(
    (c) => c !== 'upgradeDust' && after.balances[c] > 0 && ctx.options.weights[c] > 0,
  );
  if (unspent.length > 0 && ctx.catalog.season) {
    advice.push(
      `Forge ouverte pour le groupe « ${ctx.catalog.season.group} » jusqu'au ${frDate(ctx.catalog.season.end)} (Vortex : ${ctx.catalog.season.towerName}).`,
    );
  }

  // Le solde après le plan n'est pas un conseil : l'interface et Discord l'affichent déjà.
  return advice;
}

const MISSING_LIMIT = 40;
/** Succès non touchés par le plan affichés en plus, les plus proches d'être obtenus. */
const ACHIEVEMENT_NEAR_LIMIT = 3;

function buildAchievements(ctx: Context, finalState: State): AchievementSummary[] {
  const all = ctx.achievements.map((goal, i) => ({
    name: goal.name,
    description: goal.description,
    before: goal.current,
    after: finalState.achievements[i] ?? goal.current,
    max: goal.max,
    score: goal.score,
    reward: goal.rewardLoreDust,
  }));
  const progressed = all
    .filter((a) => a.after > a.before)
    .sort((a, b) => Number(b.after >= b.max) - Number(a.after >= a.max) || b.score - a.score);
  const near = all
    .filter((a) => a.after === a.before)
    .sort((a, b) => a.max - a.after - (b.max - b.after) || b.score - a.score)
    .slice(0, ACHIEVEMENT_NEAR_LIMIT);
  return [...progressed, ...near];
}

function buildInsights(ctx: Context, state: State): Insights {
  const keep = 1 + ctx.options.keepExtra;
  const fusions: FusionInsight[] = [];
  for (const fusion of ctx.catalog.fusions) {
    if (getCard(state, fusion.resultId, 0).copies > 0) continue;
    const inputs = fusion.inputs.map((input) => ({
      card: card(ctx, input.itemId, 0, input.quantity),
      have: getCard(state, input.itemId, 0).copies,
      need: input.quantity + keep,
    }));
    fusions.push({
      result: card(ctx, fusion.resultId, 0),
      inputs,
      ready: inputs.every((i) => i.have >= i.need),
    });
  }
  fusions.sort(
    (a, b) =>
      b.inputs.filter((i) => i.have >= i.need).length / b.inputs.length -
        a.inputs.filter((i) => i.have >= i.need).length / a.inputs.length ||
      a.result.identifier - b.result.identifier,
  );

  const missing: MissingCard[] = [];
  for (const item of ctx.itemList) {
    for (const shiny of [0, 1, 2] as Shiny[]) {
      if (!item.shinyAvailable[shiny] || item.scores[shiny] <= 0) continue;
      if (getCard(state, item.id, shiny).copies > 0) continue;
      const cost =
        shiny === 0 ? craftCost(ctx, item) : shiny === 1 ? enchantCost(ctx, item) : undefined;
      missing.push({
        card: card(ctx, item.id, shiny),
        points: item.scores[shiny],
        craftCost: cost ?? null,
        currency: cost !== undefined ? forgeCurrency(item) : null,
      });
    }
  }
  missing.sort(
    (a, b) =>
      Number(b.craftCost !== null) - Number(a.craftCost !== null) ||
      b.points - a.points ||
      a.card.identifier - b.card.identifier,
  );
  return { fusions, missing: missing.slice(0, MISSING_LIMIT) };
}

/** Rejoue un plan depuis l'état initial pour vérifier qu'il est valide. */
export function replay(
  ctx: Context,
  actions: Action[],
  onStep?: (before: State, after: State, action: Action) => void,
): State {
  let state = initialState(ctx);
  for (const action of actions) {
    const applied = applyAction(ctx, state, action);
    if (!applied) throw new Error(`Plan invalide : action impossible ${JSON.stringify(action)}`);
    for (const [c, v] of Object.entries(applied.state.balances)) {
      if (v < 0) throw new Error(`Plan invalide : ${c} négatif après ${JSON.stringify(action)}`);
    }
    onStep?.(state, applied.state, action);
    state = applied.state;
  }
  return state;
}

export interface CreatePlanInput {
  catalog: Catalog;
  player: Player;
  options?: PlannerOptionsInput;
  now?: Date;
}

/** Calcule le meilleur plan d'actions pour un joueur. */
export function createPlan({
  catalog,
  player,
  options,
  now = new Date(),
}: CreatePlanInput): PlanResult {
  const started = performance.now();
  const closed = catalog.settings.closed === true;
  // Option `horizon` : valeur de garde des monnaies, calculée une fois pour toute la recherche.
  const ctx = withHorizon(buildContext(catalog, player, now, resolveOptions(options)));
  const start = initialState(ctx);
  // Pas de saison Hardcore en cours : aucune commande ne peut être jouée, même pas /journa.
  const { best, explored, timedOut } = closed
    ? {
        best: { state: start, value: stateValue(ctx, start), steps: null, signature: [], depth: 0 },
        explored: 0,
        timedOut: false,
      }
    : search(ctx);
  // Commandes regroupées : les créations à la suite, puis les enchantements… (voir `regroup`).
  const steps = sortInvocations(regroup(ctx, nodeSteps(best)));
  // Succès débloqués à chaque étape, pour les signaler sur la commande qui les obtient, et
  // invocations dorées ou chromas comparées à la basique dans l'état où elles sont faites.
  const unlocked: string[][] = [];
  const notes: (string | undefined)[] = [];
  const finalState = replay(
    ctx,
    steps.map((s) => s.action),
    (from, to, action) => {
      unlocked.push(
        ctx.achievements
          .filter((a, i) => from.achievements[i]! < a.max && to.achievements[i]! >= a.max)
          .map((a) => a.name),
      );
      notes.push(action.kind === 'invoke' ? invocationNote(ctx, from, action.booster) : undefined);
    },
  );
  const before = start;

  const planSteps = steps.map((s, i) => {
    const note = notes[i];
    return describe(ctx, note ? { ...s, note } : s, unlocked[i] ?? []);
  });
  const groups = groupSteps(planSteps);
  const commands = groups.map((g) => g.command);
  const afterSnapshot = snapshot(ctx, finalState);
  const beforeSnapshot = snapshot(ctx, before);

  const challenges: ChallengeSummary[] = before.challenges.map((c) => {
    const final = finalState.challenges.find((f) => f.id === c.id) ?? c;
    return {
      description: c.description,
      before: c.current,
      after: final.current,
      max: c.max,
      reward: c.reward,
      plannable: c.action !== null,
    };
  });
  for (const c of player.challenges) {
    if (c.current >= c.max)
      challenges.push({
        description: c.description,
        before: c.max,
        after: c.max,
        max: c.max,
        reward: c.rewardLoreDust,
        plannable: c.action !== null,
      });
  }

  const season = catalog.season;
  return {
    version: 1,
    generatedAt: now.toISOString(),
    ruleSet: catalog.ruleSet,
    closed,
    strategy: { id: ctx.options.strategy, label: STRATEGIES[ctx.options.strategy].label },
    player: {
      name: player.name,
      discordId: player.discordId,
      displayName: player.displayName,
      avatar: player.avatar,
      corporation: player.corporation?.name ?? null,
      subscribed: player.subscribed,
    },
    steps: planSteps,
    groups,
    commands,
    before: beforeSnapshot,
    after: afterSnapshot,
    gain: {
      points: afterSnapshot.points - beforeSnapshot.points,
      expected: finalState.ev,
      value: stateValue(ctx, finalState) - stateValue(ctx, before),
      achievements: finalState.achievementPoints,
    },
    challenges,
    achievements: buildAchievements(ctx, finalState),
    advice: buildAdvice(ctx, before, finalState),
    insights: buildInsights(ctx, finalState),
    horizon: ctx.horizon
      ? {
          seasons: ctx.horizon.forecasts.slice(0, 3).map((f) => {
            const group = likelyGroup(f);
            return { begin: f.begin, end: f.end, group, probability: f.groups[group] ?? 0 };
          }),
          reserves: planReserves(ctx, finalState),
        }
      : null,
    season: season
      ? {
          name: season.towerName,
          group: season.group,
          end: season.end,
          ascensionsLeft: finalState.ascensionsLeft,
          floor: Math.min(season.floors.length, Math.floor(before.towerFloor) + 1),
          summit: Math.floor(before.towerFloor) >= season.floors.length,
        }
      : null,
    stats: {
      explored,
      durationMs: Math.round(performance.now() - started),
      beamWidth: ctx.options.beamWidth,
      branching: ctx.options.branching,
      timedOut,
      ...(ctx.horizon ? { horizon: ctx.horizon.stats } : {}),
    },
    hash: fnv1a(commands.join('\n')),
  };
}
