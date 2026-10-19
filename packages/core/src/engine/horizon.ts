import {
  addDays,
  forecastSeasons,
  lootUntil,
  predictedSeason,
  remainingAscensionCredits,
  seasonLastDay,
  vortexGroups,
  type SeasonForecast,
} from '../rules/calendar';
import { ASCENSION_COST, FEATURE, SEASON_DAYS } from '../rules/constants';
import { ascensionEV } from '../rules/random';
import { daysBetween, gameClock } from '../rules/time';
import {
  CURRENCIES,
  type Balances,
  type Currency,
  type GameEvent,
  type Player,
  type Season,
} from '../model/types';
import { applyAction, type Action } from './actions';
import { buildContext, rarityConfig, type Context, type PlannerOptions } from './context';
import { holdCurve, type HoldCurves, type HoldSource, type HoldStep, type Horizon } from './hold';
import { closure, rollout, type LedgerEntry } from './planner';
import { fork, initialState, stateValue, type State } from './state';

/**
 * Anticipation (option `horizon`). Le planificateur ne cherche que le plan du jour : il est
 * recalculé chaque jour, et une recherche sur plusieurs jours exploserait sans rien savoir de plus
 * de l'avenir. Il lui manquait seulement ce que vaudront plus tard les monnaies qu'il garde : un
 * poids fixe ne voit ni le prochain Vortex, ni les essais d'ascension encore à venir, ni un
 * évènement annoncé.
 *
 * Chaque période à venir qui ouvre quelque chose de nouveau est simulée une fois, en glouton, avec
 * l'inventaire d'aujourd'hui : ses dépenses les plus rentables, par unité de monnaie, donnent une
 * courbe de valeur de garde (voir `hold.ts`). Le faisceau du jour ne fait alors une dépense que si
 * elle rapporte plus que ce que ses monnaies rapporteraient plus tard.
 */

/** En deçà de ce poids (probabilité × rabais), une période à venir est ignorée. */
const MIN_WEIGHT = 0.05;
/** Dépenses simulées au plus par période à venir. */
const HORIZON_STEPS = 120;
/** Part de la limite de temps du plan accordée à l'anticipation. */
const HORIZON_BUDGET = 0.15;

/** Contexte avec la valeur de garde des monnaies, quand l'option `horizon` est active. */
export function withHorizon(ctx: Context): Context {
  if (!ctx.options.horizon || ctx.catalog.settings.closed || ctx.horizon) return ctx;
  const start = initialState(ctx);
  const root = closure(
    ctx,
    { state: start, value: stateValue(ctx, start), steps: null, signature: [], depth: 0 },
    'all',
  );
  return { ...ctx, horizon: buildHorizon(ctx, root.state) };
}

/** Paliers d'une source, avant d'être fondus dans la courbe de sa monnaie. */
type Entries = { amount: number; value: number; actions: Action[] }[];

/** Actions gardées au plus par période pour l'aperçu de ce qui y est prévu. */
const PREVIEW_ACTIONS = 60;

/**
 * Valeur de garde des monnaies depuis l'état de départ du plan (actions sans regret faites).
 * Heuristiques pour ne simuler que les périodes qui peuvent changer le plan du jour :
 * - seules les nouveautés comptent : un Vortex du groupe en cours ou du groupe Classique n'ouvre
 *   rien à la forge qui ne le soit déjà, un évènement en cours est déjà proposé aujourd'hui ;
 * - une période improbable ou lointaine (probabilité × rabais sous `MIN_WEIGHT`) est ignorée ;
 * - pas de simulation sans assez de monnaie pour la moindre dépense de la période ;
 * - une seule simulation par groupe, quelle que soit la saison où il revient, limitée au stock du
 *   joueur et à `HORIZON_STEPS` dépenses ;
 * - au-delà de `HORIZON_BUDGET` de la limite de temps, les périodes restantes sont ignorées.
 */
export function buildHorizon(ctx: Context, root: State): Horizon {
  const started = performance.now();
  const deadline =
    ctx.options.timeLimitMs > 0 ? started + ctx.options.timeLimitMs * HORIZON_BUDGET : Infinity;
  const inBudget = () => performance.now() < deadline;
  const { allow, evFactor, horizonDiscount, horizonSeasons, horizonEventDays } = ctx.options;
  const forecasts = forecastSeasons(ctx.catalog, ctx.player.towerHistory, horizonSeasons);
  const sources: HoldSource[] = [];
  const steps: HoldStep[] = [];
  const offsets: Partial<Balances> = {};
  const stats = { windows: 0, skipped: 0, durationMs: 0 };

  const add = (
    source: Omit<HoldSource, 'actions'>,
    entries: Entries,
    income: Partial<Balances>,
  ) => {
    const kept = entries.filter((e) => e.amount > 0 && e.value > 0);
    if (kept.length === 0) return;
    const index = sources.length;
    sources.push({ ...source, actions: kept.flatMap((e) => e.actions).slice(0, PREVIEW_ACTIONS) });
    for (const { amount, value } of kept) steps.push({ amount, value, source: index });
    // Revenu certain avant la première période qui a besoin de cette monnaie.
    const c = source.currency;
    offsets[c] = Math.min(offsets[c] ?? Infinity, income[c] ?? 0);
  };

  // Essais d'ascension encore à créditer d'ici la fin du Vortex.
  const ascension = ascensionSource(ctx, root);
  if (ascension) {
    stats.windows++;
    add(ascension.source, ascension.entries, ascension.income);
  }

  // Vortex des autres groupes : leurs packs s'ouvrent à la forge, payée en cristaux.
  const season = ctx.catalog.season;
  if (season && (allow.craft || allow.enchant) && ctx.features.has(FEATURE.craft)) {
    const classic = new Set(ctx.itemList.filter((i) => i.isClassic).map((i) => i.packId));
    for (const group of vortexGroups(ctx.catalog)) {
      if (group === season.group) continue;
      const packs = new Set(
        ctx.catalog.towers
          .filter((t) => t.group === group)
          .map((t) => t.packId)
          .filter((id) => !classic.has(id) && !ctx.forgeablePacks.has(id)),
      );
      const window = firstWindow(forecasts, group, horizonDiscount);
      const future = window && predictedSeason(ctx.catalog, ctx.player.towerHistory, window, group);
      if (
        packs.size === 0 ||
        !window ||
        !future ||
        window.weight < MIN_WEIGHT ||
        root.balances.loreFragment < cheapestForge(ctx, packs) ||
        !inBudget()
      ) {
        stats.skipped++;
        continue;
      }
      stats.windows++;
      const ledger = simulate(ctx, root, {
        season: future,
        date: window.begin,
        packs,
        events: [],
        balances: { loreFragment: root.balances.loreFragment },
      });
      add(
        {
          currency: 'loreFragment',
          kind: 'vortex',
          label: group,
          begin: window.begin,
          end: window.end,
          probability: window.probability,
        },
        weighted(ledger, 'loreFragment', window.weight),
        {},
      );
    }
  }

  // Évènements annoncés : l'API les liste parfois avant leur début.
  if (allow.invoke && evFactor > 0 && ctx.features.has(FEATURE.invoke)) {
    const today = gameClock(ctx.now).date;
    for (const event of ctx.catalog.events) {
      const begin = event.begin.slice(0, 10);
      if (begin <= today) continue;
      const days = daysBetween(today, begin);
      const income = lootUntil(ctx, root, begin);
      const available: Balances = { ...root.balances };
      for (const c of CURRENCIES) available[c] += income[c] ?? 0;
      if (
        days > horizonEventDays ||
        available.balance < event.balanceCost ||
        available.loreDust < event.loreDustCost ||
        !inBudget()
      ) {
        stats.skipped++;
        continue;
      }
      stats.windows++;
      const ledger = simulate(ctx, root, {
        season,
        date: begin,
        packs: new Set(),
        events: [{ ...event, active: true }],
        balances: { balance: available.balance, loreDust: available.loreDust },
      });
      const weight = horizonDiscount ** (days / SEASON_DAYS);
      for (const currency of ['balance', 'loreDust'] as const)
        add(
          {
            currency,
            kind: 'event',
            label: event.name,
            begin,
            end: addDays(event.end.slice(0, 10), 1),
            probability: 1,
          },
          weighted(ledger, currency, weight),
          income,
        );
    }
  }

  const curves: HoldCurves = {};
  for (const c of CURRENCIES) {
    const curve = holdCurve(
      steps.filter((s) => sources[s.source]!.currency === c),
      offsets[c] ?? 0,
    );
    if (curve) curves[c] = curve;
  }
  stats.durationMs = Math.round(performance.now() - started);
  return { curves, sources, forecasts, stats };
}

/** Dépenses rentables d'une monnaie, en points par unité, pondérées. */
const weighted = (ledger: LedgerEntry[], currency: Currency, weight: number): Entries =>
  ledger
    .filter((e) => e.currency === currency && e.net > 0)
    .map((e) => ({ amount: e.amount, value: (weight * e.net) / e.amount, actions: e.actions }));

/**
 * Premier Vortex d'un groupe dans l'horizon : sa saison la plus probable, la probabilité qu'il
 * revienne dans l'horizon, et son poids (probabilité × rabais, saison par saison).
 */
function firstWindow(forecasts: SeasonForecast[], group: string, discount: number) {
  let notYet = 1;
  let weight = 0;
  let probability = 0;
  let best: SeasonForecast | undefined;
  let bestChance = 0;
  for (const f of forecasts) {
    const p = f.groups[group] ?? 0;
    const chance = notYet * p;
    weight += chance * discount ** f.ahead;
    probability += chance;
    if (chance > bestChance) {
      bestChance = chance;
      best = f;
    }
    notYet *= 1 - p;
  }
  return best ? { ...best, weight, probability } : null;
}

/** Plus petit prix de forge d'une carte de ces packs. */
function cheapestForge(ctx: Context, packs: Set<string>): number {
  let cheapest = Infinity;
  for (const item of ctx.itemList) {
    if (!packs.has(item.packId) || item.isFusion || item.isStar) continue;
    const craft = item.craftable ? rarityConfig(ctx, item.rarity, 0)?.craft : undefined;
    const enchant =
      item.goldable && item.shinyAvailable[1]
        ? rarityConfig(ctx, item.rarity, 1)?.craft
        : undefined;
    for (const cost of [craft, enchant]) if (cost && cost > 0) cheapest = Math.min(cheapest, cost);
  }
  return cheapest;
}

/**
 * Essais d'ascension encore à créditer dans ce Vortex : chacun vaut ce que rapporte une ascension
 * à l'étage où le joueur en sera (mêmes termes que le candidat d'ascension). Les essais déjà
 * crédités passent d'abord : le plan du jour en décide.
 */
function ascensionSource(ctx: Context, root: State) {
  const season = ctx.catalog.season;
  const { allow, evFactor, newCardBonus, weights } = ctx.options;
  if (!season || !allow.ascension || evFactor <= 0 || !ctx.features.has(FEATURE.tower)) return null;
  const count = remainingAscensionCredits(season, ctx.now);
  // Plus d'essai à venir, ou sommet déjà atteint : rien à garder.
  if (count === 0 || Math.floor(root.towerFloor) >= season.floors.length) return null;
  let state: State = { ...fork(root), ascensionsLeft: root.ascensionsLeft + count };
  state.balances.loreDust = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < root.ascensionsLeft; i++) {
    const applied = applyAction(ctx, state, { kind: 'ascension' });
    if (!applied) break;
    state = applied.state;
  }
  const entries: Entries = [];
  for (let i = 0; i < count; i++) {
    const { ev, newCards } = ascensionEV(ctx, state);
    const applied = applyAction(ctx, state, { kind: 'ascension' });
    if (!applied) break;
    state = applied.state;
    const net = (ev + newCards * newCardBonus) * evFactor - ASCENSION_COST * weights.loreDust;
    entries.push({
      amount: ASCENSION_COST,
      value: net / ASCENSION_COST,
      actions: [{ kind: 'ascension' }],
    });
  }
  const source: Omit<HoldSource, 'actions'> = {
    currency: 'loreDust',
    kind: 'ascension',
    label: season.towerName,
    begin: gameClock(ctx.now).date,
    end: season.end,
    probability: 1,
    count,
  };
  return { source, entries, income: lootUntil(ctx, root, seasonLastDay(season)) };
}

/**
 * Dépenses gloutonnes d'une période à venir, depuis l'inventaire d'aujourd'hui (actions sans
 * regret faites), avec les seules monnaies données : seules ses nouveautés sont proposées
 * (`futureWindow`). Pas de recyclage ni de récompense : on mesure ce que rapportent les monnaies
 * gardées, pas celles gagnées d'ici là.
 */
function simulate(
  ctx: Context,
  root: State,
  window: {
    season: Season | null;
    date: string;
    packs: Set<string>;
    events: GameEvent[];
    balances: Partial<Balances>;
  },
): LedgerEntry[] {
  const player: Player = {
    ...ctx.player,
    inventory: Object.fromEntries(root.cards.entries()),
    balances: { balance: 0, loreDust: 0, loreFragment: 0, upgradeDust: 0, ...window.balances },
    challenges: [],
    achievements: [],
    loot: [{ date: window.date, daily: 1, weekly: 1 }],
    tower: null,
    evolution: null,
  };
  const options: PlannerOptions = {
    ...ctx.options,
    horizon: false,
    maxDepth: HORIZON_STEPS,
    timeLimitMs: 0,
    allow: {
      ...ctx.options.allow,
      recycle: false,
      ascension: false,
      evolution: false,
      invoke: ctx.options.allow.invoke && window.events.length > 0,
    },
  };
  const future: Context = {
    ...buildContext(
      { ...ctx.catalog, season: window.season, events: window.events },
      player,
      new Date(`${window.date}T12:00:00Z`),
      options,
    ),
    futureWindow: { packs: window.packs, events: new Set(window.events.map((e) => e.id)) },
  };
  // État de départ neuf (nouvelle couche d'inventaire) : les caches indexés par inventaire ne
  // mélangent pas les candidats d'aujourd'hui et ceux de la période simulée.
  const state = initialState(future);
  const start = closure(
    future,
    { state, value: stateValue(future, state), steps: null, signature: [], depth: 0 },
    'all',
  );
  const ledger: LedgerEntry[] = [];
  rollout(future, start, { ledger, maxSteps: HORIZON_STEPS });
  return ledger;
}

/** Monnaies gardées pour une période à venir, et ce qu'elles y rapporteront en espérance. */
export interface HorizonReserve extends HoldSource {
  amount: number;
  /** Points espérés au-delà du poids des monnaies (probabilité et rabais compris). */
  value: number;
}

/**
 * Monnaies que garde un solde, par période à venir : le revenu certain d'ici là couvre d'abord les
 * dépenses à venir les plus rentables, le solde les suivantes (comme `curveValue`).
 */
export function horizonReserves(horizon: Horizon, balances: Balances): HorizonReserve[] {
  const reserves = new Map<number, HorizonReserve>();
  for (const c of CURRENCIES) {
    const curve = horizon.curves[c];
    if (!curve) continue;
    let income = curve.offset;
    let held = balances[c];
    for (const step of curve.steps) {
      if (held <= 0) break;
      const covered = Math.min(step.amount, income);
      income -= covered;
      const used = Math.min(step.amount - covered, held);
      held -= used;
      if (used <= 0) continue;
      const reserve = reserves.get(step.source) ?? {
        ...horizon.sources[step.source]!,
        amount: 0,
        value: 0,
      };
      reserve.amount += used;
      reserve.value += used * step.value;
      reserves.set(step.source, reserve);
    }
  }
  return [...reserves].sort(([a], [b]) => a - b).map(([, r]) => r);
}

/** AAAA-MM-JJ → JJ/MM */
const shortDate = (date: string) => date.slice(5, 10).split('-').reverse().join('/');

/**
 * Pour quoi une monnaie est gardée, en quelques mots : « Vortex « ZLAN » du 02/11 (prévu) »,
 * « 14 essais d'ascension d'ici le 18/10 », « évènement « zerator » du 13/10 ». Même texte dans
 * l'interface, sur Discord et en console.
 */
export function reserveLabel(r: Omit<HoldSource, 'actions'>): string {
  switch (r.kind) {
    case 'vortex': {
      const chance = r.probability < 0.9 ? ` · ${Math.round(r.probability * 100)} %` : '';
      return `Vortex « ${r.label} » du ${shortDate(r.begin)} (prévu${chance})`;
    }
    case 'ascension':
      return `${r.count ?? 0} essais d'ascension d'ici le ${shortDate(seasonLastDay(r))}`;
    case 'event':
      return `évènement « ${r.label} » du ${shortDate(r.begin)}`;
  }
}
