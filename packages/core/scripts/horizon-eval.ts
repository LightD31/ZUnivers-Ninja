/**
 * Évalue l'option `horizon` (anticipation) : simule plusieurs semaines de jeu, un plan par jour à
 * 14 h, avec et sans anticipation, et compare ce que le joueur a gagné à la fin.
 *
 *   pnpm tsx packages/core/scripts/horizon-eval.ts [--weeks 8] [--strategy vortex]
 *     [--give loreFragment=20000] [--draws] [--truth reverse] [pseudo…]
 *
 * Sans pseudo, le joueur des fixtures. Avec des pseudos, l'API ZUnivers est appelée une fois par
 * joueur (et une fois pour le catalogue).
 *
 * Simulation déterministe : chaque jour, le plan est appliqué tel quel (cartes, monnaies, Vortex),
 * puis le jour suivant repart de cet état. Les tirages ne donnent pas de cartes : les ascensions
 * comptent pour leur espérance, et les invocations sont désactivées sauf avec `--draws`. Les Vortex
 * suivants sont ceux que prévoit `forecastSeasons` (groupe le plus probable, tour du groupe qui n'est
 * pas revenue depuis le plus longtemps). Avec `--truth reverse`, les groupes viennent au contraire
 * dans l'ordre inverse de `VORTEX_ROTATION` : la prévision se trompe, pour mesurer ce que ça coûte.
 * Les défis et succès ne sont comptés que le premier jour.
 */
import { createClient } from '../src/api/client';
import type { ApiTower } from '../src/api/schemas';
import { fetchRawCatalog, fetchRawPlayer } from '../src/model/fetch';
import {
  normalizeCatalog,
  normalizePlayer,
  normalizeSeason,
  type RawCatalog,
  type RawPlayer,
} from '../src/model/normalize';
import {
  CURRENCIES,
  CURRENCY_LABEL,
  type Balances,
  type Player,
  type Season,
} from '../src/model/types';
import { addDays, forecastSeasons, likelyGroup, nextTower } from '../src/rules/calendar';
import { VORTEX_ROTATION } from '../src/rules/constants';
import { gameClock } from '../src/rules/time';
import { buildContext, resolveOptions, type PlannerOptionsInput } from '../src/engine/context';
import { withHorizon } from '../src/engine/horizon';
import { isStrategy } from '../src/engine/strategies';
import { search } from '../src/engine/planner';
import { initialState } from '../src/engine/state';
import { NOW, rawCatalog, rawPlayer } from '../test/helpers';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const weeks = Number(flag('--weeks') ?? 8);
const give: Partial<Balances> = {};
for (let value = flag('--give'); value; value = flag('--give')) {
  const [currency, amount] = value.split('=');
  if (!CURRENCIES.includes(currency as keyof Balances))
    throw new Error(`Monnaie inconnue : ${currency}`);
  give[currency as keyof Balances] = Number(amount);
}
const strategy = flag('--strategy');
if (strategy !== undefined && !isStrategy(strategy))
  throw new Error(`Stratégie inconnue : ${strategy}`);
const truth = flag('--truth') ?? 'forecast';
if (truth !== 'forecast' && truth !== 'reverse') throw new Error(`--truth : forecast ou reverse`);
const draws = args.includes('--draws');
const pseudos = args.filter((a) => !a.startsWith('--'));

interface Totals {
  points: number;
  expected: number;
  balances: Balances;
  value: number;
  ms: number;
  horizonMs: number;
}

/** Saison qui suit `season` : groupe le plus probable, avec les étages réels de sa tour. */
function nextSeason(
  raw: RawCatalog,
  catalog: ReturnType<typeof normalizeCatalog>,
  player: Player,
): Season {
  const forecast = forecastSeasons(catalog, player.towerHistory, 1)[0]!;
  const current = VORTEX_ROTATION.indexOf(catalog.season!.group);
  const group =
    truth === 'reverse' && current >= 0
      ? VORTEX_ROTATION[(current + VORTEX_ROTATION.length - 1) % VORTEX_ROTATION.length]!
      : likelyGroup(forecast);
  const tower = nextTower(catalog, player.towerHistory, group)!;
  const rawTower = raw.towers.find((t) => t.name === tower.name) as ApiTower;
  return normalizeSeason({
    id: `simulation:${forecast.index}`,
    index: forecast.index,
    beginDate: forecast.begin,
    endDate: forecast.end,
    tower: rawTower,
  })!;
}

function simulate(raw: RawCatalog, rawP: RawPlayer, start: Date, horizon: boolean): Totals {
  let catalog = normalizeCatalog(raw, 'NORMAL', start);
  let player = normalizePlayer(rawP);
  player = { ...player, balances: { ...player.balances } };
  for (const c of CURRENCIES) player.balances[c] += give[c] ?? 0;
  const options: PlannerOptionsInput = {
    horizon,
    ...(strategy && isStrategy(strategy) ? { strategy } : {}),
    ...(draws ? {} : { allow: { invoke: false } }),
  };
  const startDate = gameClock(start).date;
  let firstPoints: number | null = null;
  let expected = 0;
  let ms = 0;
  let horizonMs = 0;
  let last = initialState(buildContext(catalog, player, start, resolveOptions(options)));

  for (let day = 0; day < weeks * 7; day++) {
    const date = addDays(startDate, day);
    const now = new Date(`${date}T12:00:00Z`);
    // Nouvelle saison de Vortex : la précédente rejoint l'historique.
    const season = catalog.season;
    if (season && date >= season.end) {
      player = {
        ...player,
        towerHistory: [
          ...player.towerHistory,
          {
            index: season.index,
            towerName: season.towerName,
            begin: season.begin,
            end: season.end,
          },
        ],
        tower: { floorsClimbed: 0, logCount: 0 },
      };
      catalog = { ...catalog, season: nextSeason(raw, catalog, player) };
    }

    const started = performance.now();
    const ctx = withHorizon(buildContext(catalog, player, now, resolveOptions(options)));
    const begin = initialState(ctx);
    const final = search(ctx).best.state;
    ms += performance.now() - started;
    horizonMs += ctx.horizon?.stats.durationMs ?? 0;
    firstPoints ??= begin.points;
    expected += final.ev * ctx.options.evFactor;

    const tower = player.tower ?? { floorsClimbed: 0, logCount: 0 };
    player = {
      ...player,
      inventory: Object.fromEntries(
        [...final.cards.entries()].filter(([, c]) => c.copies > 0 || c.constellation > 0),
      ),
      balances: { ...final.balances },
      loot: [
        ...player.loot,
        { date, daily: Number(final.dailyDone), weekly: Number(final.weeklyDone) },
      ],
      tower: {
        floorsClimbed: final.towerFloor,
        logCount: tower.logCount + begin.ascensionsLeft - final.ascensionsLeft,
      },
      evolution: player.evolution && {
        ...player.evolution,
        steps: player.evolution.steps.map((s, i) => ({ ...s, owned: i <= final.evolutionIndex })),
      },
      // Défis et succès de la semaine suivante inconnus : comptés le premier jour seulement.
      challenges: [],
      achievements: [],
      invokeBeforePity: draws ? player.invokeBeforePity : null,
    };
    last = final;
  }

  const weights = resolveOptions(options).weights;
  let value = last.points - firstPoints! + expected;
  for (const c of CURRENCIES) value += last.balances[c] * weights[c];
  return {
    points: last.points - firstPoints!,
    expected,
    balances: last.balances,
    value,
    ms,
    horizonMs,
  };
}

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');

async function main() {
  let raw: RawCatalog;
  let players: { name: string; raw: RawPlayer }[];
  let start: Date;
  if (pseudos.length === 0) {
    raw = rawCatalog();
    players = [{ name: 'fixtures', raw: rawPlayer() }];
    start = NOW;
  } else {
    const client = createClient({ userAgent: 'github.com/LightD31/ZUnivers-Ninja (horizon-eval)' });
    raw = await fetchRawCatalog(client);
    players = [];
    for (const name of pseudos) players.push({ name, raw: await fetchRawPlayer(client, name) });
    start = new Date();
  }

  console.log(
    `${weeks} semaines à partir du ${gameClock(start).date}, stratégie ${strategy ?? 'par défaut'}${draws ? '' : ', sans invocation'}${truth === 'reverse' ? ', Vortex dans l’ordre inverse de la prévision' : ''}${
      Object.keys(give).length ? `, en plus : ${JSON.stringify(give)}` : ''
    }\n`,
  );
  console.log(
    '| Joueur | Anticipation | Points sûrs | Points espérés | Valeur totale | Cristaux | Poudre | ZUMonnaie | Temps (s) | dont anticipation |',
  );
  console.log('| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |');
  for (const { name, raw: p } of players) {
    for (const horizon of [false, true]) {
      const t = simulate(raw, p, start, horizon);
      console.log(
        `| ${name} | ${horizon ? 'oui' : 'non'} | ${fmt(t.points)} | ${fmt(t.expected)} | ${fmt(t.value)} | ${fmt(t.balances.loreFragment)} | ${fmt(t.balances.loreDust)} | ${fmt(t.balances.balance)} | ${(t.ms / 1000).toFixed(1)} | ${(t.horizonMs / 1000).toFixed(1)} |`,
      );
    }
  }
  console.log(
    `\nValeur totale = points sûrs + points espérés + monnaies restantes à leur poids (${CURRENCIES.map((c) => `${CURRENCY_LABEL[c]} ${resolveOptions(strategy && isStrategy(strategy) ? { strategy } : {}).weights[c]}`).join(', ')}).`,
  );
}

await main();
