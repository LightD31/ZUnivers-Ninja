import { ASCENSIONS_PER_DAY, ASCENSION_CREDIT_HOUR, GAME_TIMEZONE } from './constants';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: GAME_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** Date (AAAA-MM-JJ) et heure dans le fuseau du jeu (les récompenses sont créditées à minuit, heure française). */
export function gameClock(now: Date): { date: string; hour: number } {
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: GAME_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Date et heure AAAA-MM-JJTHH:MM:SS dans le fuseau du jeu, comme les dates sans fuseau de l'API. */
export function gameDateTime(now: Date): string {
  const p = Object.fromEntries(dateTimeFormatter.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** Nombre de jours entre deux dates AAAA-MM-JJ. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Essais d'ascension crédités depuis le début de la saison : deux par jour, à midi,
 * cumulables jusqu'à la fin du Vortex (source : /vortex).
 */
export function ascensionCredits(seasonBegin: string, seasonEnd: string, now: Date): number {
  const { date, hour } = gameClock(now);
  if (date < seasonBegin || date > seasonEnd) return 0;
  const noons = daysBetween(seasonBegin, date) + (hour >= ASCENSION_CREDIT_HOUR ? 1 : 0);
  return noons * ASCENSIONS_PER_DAY;
}
