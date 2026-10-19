import { describe, expect, it } from 'vitest';
import {
  forecastSeasons,
  likelyGroup,
  lootUntil,
  nextTower,
  predictedSeason,
  remainingAscensionCredits,
  type Season,
  type TowerInfo,
} from '../src';
import { makeCatalog, makeContext, makePlayer } from './factory';
import { fixtureCatalog, fixturePlayer } from './helpers';

const TOWERS: TowerInfo[] = [
  { name: 'Manoir', group: 'Classique', packId: 'pack-classic' },
  { name: 'Modération', group: 'Classique', packId: 'pack-classic' },
  { name: 'TMCUP', group: 'Autres', packId: 'pack-tmcup' },
  { name: 'RPZ', group: 'Autres', packId: 'pack-rpz' },
  { name: 'ZLAN', group: 'ZLAN', packId: 'pack-zlan' },
  { name: 'ZEvent', group: 'ZEvent', packId: 'pack-zevent' },
];

const season = (overrides: Partial<Season> = {}): Season => ({
  id: 's',
  index: 119,
  begin: '2026-10-19',
  end: '2026-11-02',
  towerName: 'TMCUP',
  group: 'Autres',
  packId: 'pack-tmcup',
  floors: [],
  ...overrides,
});

describe('prochains Vortex', () => {
  it("suit l'ordre des groupes appris sur l'historique réel", () => {
    // Fixtures : saison 118 (Manoir Nougaret, Classique). La 119 a bien été la TMCUP (Autres).
    const forecasts = forecastSeasons(fixtureCatalog(), fixturePlayer().towerHistory, 3);
    expect(forecasts.map(likelyGroup)).toEqual(['Autres', 'ZLAN', 'ZEvent']);
    expect(forecasts[0]!.groups.Autres).toBeGreaterThan(0.95);
    expect(forecasts[1]!.groups.ZLAN).toBeGreaterThan(0.9);
    expect(forecasts.map((f) => [f.index, f.begin, f.end])).toEqual([
      [119, '2026-10-19', '2026-11-02'],
      [120, '2026-11-02', '2026-11-16'],
      [121, '2026-11-16', '2026-11-30'],
    ]);
    for (const f of forecasts)
      expect(Object.values(f.groups).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("suit l'ordre observé sans historique", () => {
    const catalog = makeCatalog([], { season: season(), towers: TOWERS });
    expect(forecastSeasons(catalog, [], 4).map(likelyGroup)).toEqual([
      'ZLAN',
      'ZEvent',
      'Classique',
      'Autres',
    ]);
  });

  it("apprend un autre ordre quand l'historique le contredit", () => {
    // Autres → ZEvent → ZLAN → Classique → Autres…, trois fois de suite.
    const order = ['TMCUP', 'ZEvent', 'ZLAN', 'Manoir'];
    const history = Array.from({ length: 12 }, (_, i) => ({
      index: 107 + i,
      towerName: order[i % 4]!,
      begin: '2026-01-01',
      end: '2026-01-15',
    }));
    const catalog = makeCatalog([], { season: season(), towers: TOWERS });
    expect(likelyGroup(forecastSeasons(catalog, history, 1)[0]!)).toBe('ZEvent');
  });

  it("choisit la tour du groupe qui n'est pas revenue depuis le plus longtemps", () => {
    const catalog = makeCatalog([], { season: season(), towers: TOWERS });
    const history = [{ index: 110, towerName: 'Modération', begin: '', end: '' }];
    expect(nextTower(catalog, history, 'Classique')?.name).toBe('Manoir');
    expect(nextTower(catalog, history, 'Autres')?.name).toBe('RPZ');
    const predicted = predictedSeason(
      catalog,
      history,
      { index: 120, begin: '2026-11-02', end: '2026-11-16' },
      'ZLAN',
    );
    expect(predicted).toMatchObject({ group: 'ZLAN', packId: 'pack-zlan', floors: [] });
  });

  it('ne prévoit rien hors saison', () => {
    expect(forecastSeasons(makeCatalog([], { towers: TOWERS }), [], 3)).toEqual([]);
  });
});

describe("essais d'ascension à venir", () => {
  const s = season();

  it('compte les midis restants avant la fin de la saison (fin exclue)', () => {
    // 10 h à Paris le premier jour : 14 midis (19/10 → 01/11), 28 essais.
    expect(remainingAscensionCredits(s, new Date('2026-10-19T08:00:00Z'))).toBe(28);
    // 14 h : le midi du jour est déjà crédité.
    expect(remainingAscensionCredits(s, new Date('2026-10-19T12:00:00Z'))).toBe(26);
    // Dernier jour.
    expect(remainingAscensionCredits(s, new Date('2026-11-01T09:00:00Z'))).toBe(2);
    expect(remainingAscensionCredits(s, new Date('2026-11-01T13:00:00Z'))).toBe(0);
    // Saison terminée : la date de fin est le premier jour de la suivante.
    expect(remainingAscensionCredits(s, new Date('2026-11-02T09:00:00Z'))).toBe(0);
  });
});

describe('récompenses à venir', () => {
  const ctx = makeContext(makeCatalog([]), makePlayer());

  it('compte les /journa et /bonus jusqu’au jour donné', () => {
    // TEST_NOW : 11/10. Journa du jour fait : 6 journas du 12 au 17/10.
    expect(lootUntil(ctx, { dailyDone: true, dailiesSinceWeekly: 0 }, '2026-10-17')).toEqual({
      balance: 6000,
      loreDust: 60,
    });
    // Trois journas déjà faits depuis le dernier bonus : un /bonus en plus.
    expect(lootUntil(ctx, { dailyDone: true, dailiesSinceWeekly: 3 }, '2026-10-17')).toEqual({
      balance: 7000,
      loreDust: 70,
    });
    // Journa du jour pas encore fait : il compte aussi.
    expect(lootUntil(ctx, { dailyDone: false, dailiesSinceWeekly: 0 }, '2026-10-11')).toEqual({
      balance: 1000,
      loreDust: 10,
    });
    expect(lootUntil(ctx, { dailyDone: true, dailiesSinceWeekly: 0 }, '2026-10-01')).toEqual({});
  });
});
