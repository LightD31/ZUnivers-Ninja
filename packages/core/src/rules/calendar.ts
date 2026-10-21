import type { Context } from '../engine/context';
import type { Balances, Catalog, Player, Season, TowerInfo, TowerSeasonLog } from '../model/types';
import {
  ASCENSIONS_PER_DAY,
  ASCENSION_CREDIT_HOUR,
  FEATURE,
  SEASON_DAYS,
  SUBSCRIPTION_LOOT_BONUS,
  SUBSCRIPTION_PREMIUM_DAYS,
  SUBSCRIPTION_PREMIUM_INVOCATIONS,
  VORTEX_ROTATION,
  WEEKLY_EVERY_DAILIES,
} from './constants';
import { daysBetween, gameClock, gameDateTime } from './time';

/**
 * Calendrier du jeu : ce qui est connu ou prévisible des jours à venir. La fin du Vortex, les
 * essais d'ascension et les récompenses quotidiennes sont connus d'avance ; le groupe des
 * prochains Vortex se prévoit d'après l'historique du joueur.
 */

/** Date AAAA-MM-JJ décalée de `days` jours. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Dernier jour d'une saison : sa date de fin est le premier jour de la suivante. */
export const seasonLastDay = (season: Pick<Season, 'end'>) => addDays(season.end, -1);

/**
 * Essais d'ascension encore à créditer d'ici la fin de la saison : deux à chaque midi à venir,
 * celui d'aujourd'hui compris s'il n'est pas encore passé.
 */
export function remainingAscensionCredits(
  season: Pick<Season, 'begin' | 'end'>,
  now: Date,
): number {
  const { date, hour } = gameClock(now);
  const last = seasonLastDay(season);
  if (date > last) return 0;
  if (date < season.begin) return (daysBetween(season.begin, last) + 1) * ASCENSIONS_PER_DAY;
  return (daysBetween(date, last) + (hour < ASCENSION_CREDIT_HOUR ? 1 : 0)) * ASCENSIONS_PER_DAY;
}

/**
 * Date (AAAA-MM-JJTHH:MM:SS, heure française) de la prochaine invocation premium de l'abonné :
 * trois par abonnement, la première dès son début, puis 10 jours d'attente entre deux (source :
 * /abonnement). Vérifié sur l'historique de 50 abonnés : jamais deux à moins de 10 jours dans un
 * même abonnement. `null` s'il n'en reste plus avant la fin de l'abonnement, ou si l'historique
 * est inconnu : mieux vaut ne rien conseiller qu'une commande refusée.
 */
export function nextPremium(player: Pick<Player, 'subscription'>): string | null {
  const subscription = player.subscription;
  const dates = subscription?.premiumDates;
  if (!subscription || !dates || dates.length >= SUBSCRIPTION_PREMIUM_INVOCATIONS) return null;
  const last = dates.at(-1);
  // Dates sans fuseau, en heure française : décalées telles quelles.
  const ready = last
    ? new Date(Date.parse(`${last}Z`) + SUBSCRIPTION_PREMIUM_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 19)
    : subscription.begin;
  return ready < subscription.end ? ready : null;
}

/** L'invocation premium de l'abonné est-elle disponible maintenant ? (voir `nextPremium`) */
export function premiumAvailable(player: Pick<Player, 'subscription'>, now: Date): boolean {
  const next = nextPremium(player);
  const clock = gameDateTime(now);
  return next !== null && next <= clock && clock < player.subscription!.end;
}

/**
 * Récompenses /journa et /bonus encore à venir jusqu'au jour `until` compris : le seul revenu connu
 * d'avance. `today` décrit l'état du jour (journa déjà fait, journas depuis le dernier bonus).
 */
export function lootUntil(
  ctx: Context,
  today: { dailyDone: boolean; dailiesSinceWeekly: number },
  until: string,
): Partial<Balances> {
  if (!ctx.features.has(FEATURE.loot)) return {};
  const dailies =
    Math.max(0, daysBetween(gameClock(ctx.now).date, until)) + (today.dailyDone ? 0 : 1);
  if (dailies === 0) return {};
  const weeklies = Math.floor((today.dailiesSinceWeekly + dailies) / WEEKLY_EVERY_DAILIES);
  const { dailyReward, weeklyReward, dailyLoreDust } = ctx.catalog.settings;
  // Mêmes termes que `lootReward` : bonus de corporation, et d'abonnement au /journa seulement,
  // jusqu'à la fin de l'abonnement.
  const corporation = ctx.corporation.loot;
  let subscribedDays = 0;
  if (ctx.player.subscribed) {
    const first = addDays(gameClock(ctx.now).date, today.dailyDone ? 1 : 0);
    const end = ctx.player.subscription?.end.slice(0, 10);
    subscribedDays = end ? Math.min(dailies, Math.max(0, daysBetween(first, end))) : dailies;
  }
  return {
    balance:
      dailies * (dailyReward + corporation) +
      subscribedDays * SUBSCRIPTION_LOOT_BONUS +
      weeklies * (weeklyReward + corporation),
    loreDust: (dailies + weeklies) * dailyLoreDust,
  };
}

export interface SeasonForecast {
  /** Saisons après celle en cours (1 = la prochaine). */
  ahead: number;
  index: number;
  /** Dates AAAA-MM-JJ, fin exclue. */
  begin: string;
  end: string;
  /** Probabilité de chaque groupe de Vortex. */
  groups: Record<string, number>;
}

/** Poids d'une transition observée il y a une saison de plus : les plus récentes comptent plus. */
const HISTORY_DECAY = 0.85;
/** Saisons d'historique au plus pour apprendre l'ordre des groupes. */
const HISTORY_SEASONS = 32;
/** Poids de l'ordre observé (`VORTEX_ROTATION`) face aux transitions de l'historique. */
const ROTATION_PRIOR = 1;

/** Groupes de Vortex du catalogue : dans l'ordre observé, puis les autres par ordre alphabétique. */
export function vortexGroups(catalog: Catalog): string[] {
  const groups = new Set(catalog.towers.map((t) => t.group).filter((g) => g));
  if (catalog.season) groups.add(catalog.season.group);
  if (catalog.nextTower?.group) groups.add(catalog.nextTower.group);
  const rank = (g: string) => {
    const i = VORTEX_ROTATION.indexOf(g);
    return i < 0 ? VORTEX_ROTATION.length : i;
  };
  return [...groups].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Groupe de chaque saison connue : historique du joueur, puis saison en cours. */
function knownSeasons(catalog: Catalog, history: TowerSeasonLog[]): Map<number, string> {
  const groupOf = new Map(catalog.towers.map((t) => [t.name, t.group]));
  const known = new Map<number, string>();
  for (const log of history) {
    const group = groupOf.get(log.towerName);
    if (group) known.set(log.index, group);
  }
  if (catalog.season) known.set(catalog.season.index, catalog.season.group);
  return known;
}

/**
 * Probabilité de chaque groupe pour les `count` prochaines saisons. L'API annonce la tour de la
 * prochaine saison (`Catalog.nextTower`) : son groupe est sûr. Au-delà, l'ordre des groupes
 * s'apprend sur les saisons consécutives de l'historique du joueur (chaîne de Markov : le groupe
 * suivant dépend du groupe en cours), en partant de l'ordre observé `VORTEX_ROTATION`. Une saison
 * manquée ne fausse rien : seules les paires consécutives comptent.
 */
export function forecastSeasons(
  catalog: Catalog,
  history: TowerSeasonLog[],
  count: number,
): SeasonForecast[] {
  const season = catalog.season;
  if (!season) return [];
  const groups = vortexGroups(catalog);
  const known = knownSeasons(catalog, history);
  const latest = Math.max(...known.keys());
  const counts = new Map<string, Map<string, number>>();
  for (const [index, group] of known) {
    const next = known.get(index + 1);
    if (next === undefined || latest - index > HISTORY_SEASONS) continue;
    const row = counts.get(group) ?? new Map<string, number>();
    row.set(next, (row.get(next) ?? 0) + HISTORY_DECAY ** (latest - index - 1));
    counts.set(group, row);
  }

  const transitions = new Map<string, Map<string, number>>();
  const transition = (from: string) => {
    let out = transitions.get(from);
    if (out) return out;
    // Sans historique : le groupe suivant dans l'ordre observé, sinon n'importe quel autre.
    const prior = new Map<string, number>();
    const at = VORTEX_ROTATION.indexOf(from);
    const successor = at >= 0 ? VORTEX_ROTATION[(at + 1) % VORTEX_ROTATION.length] : undefined;
    const others = groups.filter((g) => g !== from);
    if (successor && groups.includes(successor)) prior.set(successor, 1);
    else if (others.length === 0) prior.set(from, 1);
    else for (const g of others) prior.set(g, 1 / others.length);
    const row = counts.get(from);
    let total = ROTATION_PRIOR;
    for (const v of row?.values() ?? []) total += v;
    out = new Map();
    for (const g of groups) {
      const p = ((row?.get(g) ?? 0) + ROTATION_PRIOR * (prior.get(g) ?? 0)) / total;
      if (p > 0) out.set(g, p);
    }
    transitions.set(from, out);
    return out;
  };

  const forecasts: SeasonForecast[] = [];
  let dist = new Map([[season.group, 1]]);
  const announced = catalog.nextTower?.group;
  for (let ahead = 1; ahead <= count; ahead++) {
    let next = new Map<string, number>();
    if (ahead === 1 && announced) next = new Map([[announced, 1]]);
    else
      for (const [from, p] of dist)
        for (const [to, q] of transition(from)) next.set(to, (next.get(to) ?? 0) + p * q);
    dist = next;
    const begin = addDays(season.end, SEASON_DAYS * (ahead - 1));
    forecasts.push({
      ahead,
      index: season.index + ahead,
      begin,
      end: addDays(begin, SEASON_DAYS),
      groups: Object.fromEntries(groups.filter((g) => dist.has(g)).map((g) => [g, dist.get(g)!])),
    });
  }
  return forecasts;
}

/** Groupe le plus probable d'une saison prévue. */
export function likelyGroup(forecast: SeasonForecast): string {
  let best = '';
  for (const [group, p] of Object.entries(forecast.groups))
    if (!best || p > forecast.groups[best]!) best = group;
  return best;
}

/** Tour la plus probable d'un groupe : celle qui n'est pas revenue depuis le plus longtemps. */
export function nextTower(
  catalog: Catalog,
  history: TowerSeasonLog[],
  group: string,
): TowerInfo | undefined {
  const last = new Map<string, number>();
  for (const log of history) last.set(log.towerName, log.index);
  if (catalog.season) last.set(catalog.season.towerName, catalog.season.index);
  const seen = (t: TowerInfo) => last.get(t.name) ?? -Infinity;
  let best: TowerInfo | undefined;
  for (const tower of catalog.towers)
    if (tower.group === group && (!best || seen(tower) < seen(best))) best = tower;
  return best;
}

/**
 * Saison prévue, pour simuler la forge de ce Vortex : la tour choisie importe peu, la forge ouvre
 * les packs de tout son groupe (voir `buildContext`). La prochaine saison a sa tour annoncée par
 * l'API. Ses étages ne servent pas : pas d'ascension simulée.
 */
export function predictedSeason(
  catalog: Catalog,
  history: TowerSeasonLog[],
  forecast: Pick<SeasonForecast, 'index' | 'begin' | 'end'> & { ahead?: number },
  group: string,
): Season | null {
  const announced =
    forecast.ahead === 1 && catalog.nextTower?.group === group ? catalog.nextTower : undefined;
  const tower = announced ?? nextTower(catalog, history, group);
  if (!tower) return null;
  return {
    id: `prévision:${forecast.index}:${group}`,
    index: forecast.index,
    begin: forecast.begin,
    end: forecast.end,
    towerName: tower.name,
    group,
    packId: tower.packId,
    floors: [],
  };
}
