import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareForTrade,
  createPlan,
  ZuNotFoundError,
  type PlanResult,
  type TradePartners,
  type TradeResult,
} from '@zuninja/core';
import { describe, expect, it, vi } from 'vitest';
import { makePlayer } from '../../../packages/core/test/factory';
import { fixtureCatalog, fixturePlayer, NOW } from '../../../packages/core/test/helpers';
import { loadConfig } from '../src/config';
import { setLogLevel } from '../src/logger';
import { Metrics, PlayerTracker } from '../src/metrics';
import { buildDiscordMessage, sendDiscord } from '../src/notifiers/discord';
import { PlannerBusyError, PlannerTimeoutError } from '../src/pool';
import { runTick } from '../src/scheduler';
import { createApp, parsePlannerQuery, parseTradeKeep, parseTradeNames } from '../src/server';
import { PlayerNotFoundError, TradeUnavailableError, type PlanService } from '../src/service';
import { StateStore } from '../src/store';

setLogLevel('error');

const plan: PlanResult = createPlan({
  catalog: fixtureCatalog(),
  player: fixturePlayer(),
  now: NOW,
});
const tmp = () => mkdtempSync(join(tmpdir(), 'zuninja-'));

function fakeService(impl: (name: string) => Promise<PlanResult>): PlanService {
  return { plan: vi.fn(impl) } as unknown as PlanService;
}

describe('configuration', () => {
  it('lit les joueurs, y compris via l’ancienne variable DISCORD_TAGS', () => {
    expect(loadConfig({ ZU_USERS: 'alice, bob,alice' }).users).toEqual(['alice', 'bob']);
    expect(loadConfig({ DISCORD_TAGS: 'carol' }).users).toEqual(['carol']);
    expect(loadConfig({}).ruleSet).toBe('NORMAL');
  });

  it('lit la stratégie par défaut et celle de chaque joueur', () => {
    const config = loadConfig({ ZU_USERS: 'Alice:prudent, bob,carol:vortex', STRATEGY: 'epargne' });
    expect(config.users).toEqual(['Alice', 'bob', 'carol']);
    expect(config.strategies).toEqual({ alice: 'prudent', carol: 'vortex' });
    expect(config.planner.strategy).toBe('epargne');
    expect(loadConfig({}).planner.strategy).toBeUndefined();
    expect(loadConfig({}).planner.horizon).toBeUndefined();
    expect(loadConfig({ HORIZON: 'true' }).planner.horizon).toBe(true);
    expect(loadConfig({ HORIZON_DISCOUNT: '0.8', HORIZON_SEASONS: '2' }).planner).toMatchObject({
      horizonDiscount: 0.8,
      horizonSeasons: 2,
    });
  });

  it('refuse une stratégie inconnue', () => {
    expect(() => loadConfig({ ZU_USERS: 'alice:yolo' })).toThrow(/stratégie « yolo » inconnue/);
    expect(() => loadConfig({ STRATEGY: 'yolo' })).toThrow(/Configuration invalide/);
  });

  it('borne le planificateur par défaut', () => {
    expect(loadConfig({})).toMatchObject({ threads: 2, queueLimit: 4, timeLimitMs: 20_000 });
    expect(loadConfig({ PLANNER_TIME_LIMIT_SECONDS: '0' }).timeLimitMs).toBe(0);
  });

  it('lit les actions refusées', () => {
    expect(loadConfig({}).planner.allow).toBeUndefined();
    expect(loadConfig({ SKIP_ACTIONS: 'Recycle, invoke' }).planner.allow).toMatchObject({
      recycle: false,
      invoke: false,
      craft: true,
    });
    expect(() => loadConfig({ SKIP_ACTIONS: 'recycle,yolo' })).toThrow(/inconnue\(s\) : yolo/);
  });

  it('refuse une configuration invalide', () => {
    expect(() => loadConfig({ RULESET: 'EXTREME' })).toThrow(/Configuration invalide/);
    expect(() => loadConfig({ WEBHOOK_URL: 'pas une url' })).toThrow(/Configuration invalide/);
  });
});

describe('message Discord', () => {
  it('met le plan dans un embed quand il tient', () => {
    const small: PlanResult = { ...plan, commands: ['/journa', '/im'] };
    const message = buildDiscordMessage(small, { webUrl: 'https://ninja.example/' });
    const embed = (message.payload.embeds as Record<string, unknown>[])[0]!;
    expect(message.attachment).toBeNull();
    expect(embed.description).toBe('```\n/journa\n/im\n```');
    expect(embed.url).toBe('https://ninja.example/?u=alexpresso');
    expect((embed.footer as { text: string }).text).toMatch(/^Stratégie : Équilibré/);
    expect(message.payload.allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it('dit ce que le plan garde pour plus tard (option horizon)', () => {
    const waiting: PlanResult = {
      ...plan,
      horizon: {
        seasons: [],
        reserves: [
          {
            currency: 'loreFragment',
            kind: 'vortex',
            label: 'ZLAN',
            begin: '2026-11-02',
            end: '2026-11-16',
            probability: 0.99,
            amount: 3000,
            value: 450,
            preview: [],
          },
        ],
      },
    };
    const fields = (buildDiscordMessage(waiting).payload.embeds as { fields: unknown[] }[])[0]!
      .fields;
    expect(fields).toContainEqual({
      name: 'À garder',
      value: "Cristaux d'histoire : `3\u202f000` · Vortex « ZLAN » du 02/11 (prévu) · ~+450 points",
      inline: false,
    });
    const none = (buildDiscordMessage(plan).payload.embeds as { fields: { name: string }[] }[])[0]!;
    expect(none.fields.map((f) => f.name)).not.toContain('À garder');
  });

  it('signale une saison Hardcore terminée', () => {
    const closed: PlanResult = { ...plan, closed: true, commands: [] };
    const embed = (buildDiscordMessage(closed).payload.embeds as Record<string, unknown>[])[0]!;
    expect(embed.description).toMatch(/Pas de saison Hardcore en cours/);
  });

  it('garde la stratégie dans le lien vers l’interface', () => {
    const prudent: PlanResult = { ...plan, strategy: { id: 'prudent', label: 'Prudent' } };
    const message = buildDiscordMessage(prudent, { webUrl: 'https://ninja.example' });
    const embed = (message.payload.embeds as Record<string, unknown>[])[0]!;
    expect(embed.url).toBe('https://ninja.example/?u=alexpresso&strategy=prudent');
  });

  it('joint un fichier quand le plan est trop long', () => {
    const long: PlanResult = {
      ...plan,
      commands: Array.from({ length: 400 }, (_, i) => `/création ${1000 + i}`),
    };
    const message = buildDiscordMessage(long);
    expect(message.attachment?.name).toBe('conseils.txt');
    expect(message.attachment?.content.split('\n')).toHaveLength(401);
  });

  it('mentionne le joueur seulement si demandé', () => {
    const message = buildDiscordMessage(plan, { mention: true });
    expect(message.payload.content).toBe(`Conseils pour <@${plan.player.discordId}>`);
  });

  it('respecte le délai demandé par Discord (429)', async () => {
    const responses = [
      new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 }),
      new Response(null, { status: 204 }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    await sendDiscord(
      'https://discord.test/hook',
      buildDiscordMessage({ ...plan, commands: ['/journa'] }),
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('passage planifié', () => {
  it('ne notifie que lorsque le plan change', async () => {
    const store = new StateStore(join(tmp(), 'state.json'));
    const notify = vi.fn(async () => {});
    const service = fakeService(async () => plan);
    const options = { users: ['alexpresso'], ruleSet: 'NORMAL' as const, dryRun: false };

    await runTick(service, store, [{ name: 'test', notify }], options);
    await runTick(service, store, [{ name: 'test', notify }], options);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.user('AlexPresso').hash).toBe(plan.hash);
  });

  it('calcule chaque joueur avec sa stratégie', async () => {
    const store = new StateStore(join(tmp(), 'state.json'));
    const service = fakeService(async () => plan);
    await runTick(service, store, [], {
      users: ['Alice', 'bob'],
      strategies: { alice: 'collectionneur' },
      ruleSet: 'NORMAL',
      dryRun: true,
    });
    expect(service.plan).toHaveBeenCalledWith(
      'Alice',
      'NORMAL',
      { strategy: 'collectionneur' },
      { fresh: true },
    );
    expect(service.plan).toHaveBeenCalledWith('bob', 'NORMAL', {}, { fresh: true });
  });

  it("enregistre l'erreur d'un joueur sans bloquer les autres", async () => {
    const file = join(tmp(), 'state.json');
    const store = new StateStore(file);
    const service = fakeService(async (name) => {
      if (name === 'inconnu') throw new ZuNotFoundError('/public/user/inconnu');
      return plan;
    });
    const results = await runTick(service, store, [], {
      users: ['inconnu', 'alexpresso'],
      ruleSet: 'NORMAL',
      dryRun: false,
    });
    expect(results.map((r) => Boolean(r.error))).toEqual([true, false]);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.users.inconnu.lastError).toMatch(/introuvable/);
    expect(new StateStore(file).user('alexpresso').checkedAt).not.toBeNull();
  });
});

describe('API HTTP', () => {
  const options = {
    ruleSet: 'NORMAL' as const,
    users: [],
    webDir: join(tmp(), 'absent'),
    cron: '* * * * *',
  };

  it('répond au healthcheck', async () => {
    const app = createApp(
      fakeService(async () => plan),
      null,
      options,
    );
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('renvoie le plan et transmet les options bornées', async () => {
    const service = fakeService(async () => plan);
    const app = createApp(service, null, options);
    const res = await app.request('/api/plan/alexpresso?beamWidth=999&ruleset=hardcore');
    expect(res.status).toBe(200);
    expect((await res.json()).hash).toBe(plan.hash);
    expect(service.plan).toHaveBeenCalledWith(
      'alexpresso',
      'HARDCORE',
      { beamWidth: 64 },
      { fresh: false, signal: expect.any(AbortSignal) },
    );
  });

  it('transmet la stratégie demandée et refuse une stratégie inconnue', async () => {
    const service = fakeService(async () => plan);
    const app = createApp(service, null, options);
    const res = await app.request('/api/plan/alexpresso?strategy=vortex');
    expect(res.status).toBe(200);
    expect(service.plan).toHaveBeenCalledWith(
      'alexpresso',
      'NORMAL',
      { strategy: 'vortex' },
      { fresh: false, signal: expect.any(AbortSignal) },
    );
    const bad = await app.request('/api/plan/alexpresso?strategy=yolo');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/inconnue/);
    expect(service.plan).toHaveBeenCalledTimes(1);
  });

  it.each(['/api/config', '/api/strategies'])(
    '%s liste les stratégies disponibles',
    async (path) => {
      const app = createApp(
        fakeService(async () => plan),
        null,
        { ...options, strategy: 'prudent' },
      );
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.strategy).toBe('prudent');
      expect(body.strategies).toHaveLength(5);
      expect(body.strategies[0]).toEqual({
        id: 'equilibre',
        label: 'Équilibré',
        description: expect.any(String),
      });
    },
  );

  it('répond 503 quand le serveur est saturé', async () => {
    const app = createApp(
      fakeService(async () => {
        throw new PlannerBusyError();
      }),
      null,
      options,
    );
    const res = await app.request('/api/plan/alexpresso');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    expect((await res.json()).error).toMatch(/Trop de calculs/);
  });

  it('répond 503 quand le calcul dépasse le délai', async () => {
    const app = createApp(
      fakeService(async () => {
        throw new PlannerTimeoutError(50_000);
      }),
      null,
      options,
    );
    const res = await app.request('/api/plan/alexpresso');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/trop de temps/);
  });

  it('renvoie 404 pour un joueur inconnu', async () => {
    const app = createApp(
      fakeService(async () => {
        throw new ZuNotFoundError('/public/user/x');
      }),
      null,
      options,
    );
    const res = await app.request('/api/plan/x');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/introuvable/);
  });

  it('renvoie un message Discord prêt à poster', async () => {
    const app = createApp(
      fakeService(async () => plan),
      null,
      { ...options, webUrl: 'https://ninja.example' },
    );
    const res = await app.request('/api/plan/alexpresso/discord?mention=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hash).toBe(plan.hash);
    expect(body.strategy).toEqual({ id: 'equilibre', label: 'Équilibré' });
    expect(body.empty).toBe(false);
    expect(body.commandCount).toBe(plan.commands.length);
    expect(body.content).toBe(`Conseils pour <@${plan.player.discordId}>`);
    expect(body.embeds[0].url).toBe('https://ninja.example/?u=alexpresso');
    expect(body.player.discordId).toBe(plan.player.discordId);
  });

  it.each(['/api/plan/alexpresso', '/api/plan/alexpresso/discord'])(
    '%s répond 304 tant que le plan ne change pas',
    async (path) => {
      const app = createApp(
        fakeService(async () => plan),
        null,
        options,
      );
      const first = await app.request(path);
      const etag = first.headers.get('etag');
      expect(etag).toBe(`W/"${plan.hash}"`);
      const again = await app.request(path, { headers: { 'If-None-Match': etag! } });
      expect(again.status).toBe(304);
      const changed = await app.request(path, { headers: { 'If-None-Match': 'W/"autre"' } });
      expect(changed.status).toBe(200);
    },
  );

  it('borne les paramètres du planificateur', () => {
    expect(
      parsePlannerQuery({
        beamWidth: '0',
        branching: 'abc',
        keepExtra: '3',
        keepForGolden: '0',
        keepForGoldenFusions: '0',
        horizon: '1',
        horizonDiscount: '1.5',
        horizonSeasons: '2',
        wLoreDust: '0.02',
      }),
    ).toEqual({
      beamWidth: 1,
      keepExtra: 3,
      keepForGolden: false,
      keepForGoldenFusions: false,
      horizon: true,
      horizonDiscount: 1,
      horizonSeasons: 2,
      weights: { loreDust: 0.02 },
    });
    expect(
      parsePlannerQuery({ keepForGolden: 'oui', keepForGoldenFusions: 'oui', horizon: 'oui' }),
    ).toEqual({});
    // Les actions inconnues sont ignorées, et `skip=` vide les autorise toutes.
    expect(parsePlannerQuery({ skip: 'recycle,invoke,yolo' }).allow).toMatchObject({
      recycle: false,
      invoke: false,
      craft: true,
    });
    expect(Object.values(parsePlannerQuery({ skip: '' }).allow ?? {})).not.toContain(false);
  });
});

describe('échanges', () => {
  const options = {
    ruleSet: 'NORMAL' as const,
    users: [],
    webDir: join(tmp(), 'absent'),
    cron: '* * * * *',
  };
  const trade: TradeResult = compareForTrade({
    catalog: fixtureCatalog(),
    me: fixturePlayer(),
    other: makePlayer({ name: 'debutant' }),
    now: NOW,
  });
  const tradeService = (impl: (me: string, other: string) => Promise<TradeResult>) =>
    ({ trade: vi.fn(impl) }) as unknown as PlanService;

  it('lit les exemplaires gardés par chaque joueur', () => {
    expect(parseTradeKeep(undefined)).toEqual({});
    expect(parseTradeKeep('')).toEqual({
      golden: false,
      goldenFusions: false,
      constellation: false,
    });
    expect(parseTradeKeep('golden, constellation,yolo')).toEqual({
      golden: true,
      goldenFusions: false,
      constellation: true,
    });
  });

  it('compare deux joueurs avec les réglages de chacun', async () => {
    const service = tradeService(async () => trade);
    const app = createApp(service, null, options);
    const res = await app.request('/api/trade/alexpresso/debutant?otherKeep=golden&fresh=1');
    expect(res.status).toBe(200);
    expect((await res.json()).me.gives.length).toBe(trade.me.gives.length);
    expect(service.trade).toHaveBeenCalledWith(
      'alexpresso',
      'debutant',
      'NORMAL',
      { me: {}, other: { golden: true, goldenFusions: false, constellation: false } },
      { fresh: true },
    );
  });

  it('refuse un échange avec soi-même ou un pseudo invalide', async () => {
    const service = tradeService(async () => trade);
    const app = createApp(service, null, options);
    expect((await app.request('/api/trade/Alice/alice')).status).toBe(400);
    expect((await app.request(`/api/trade/alice/${'x'.repeat(65)}`)).status).toBe(400);
    expect(service.trade).not.toHaveBeenCalled();
  });

  it('dit quel joueur est introuvable, et refuse le Hardcore', async () => {
    const missing = createApp(
      tradeService(async () => {
        throw new PlayerNotFoundError('fantome');
      }),
      null,
      options,
    );
    const res = await missing.request('/api/trade/alice/fantome');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/« fantome » introuvable/);

    const hardcore = createApp(
      tradeService(async () => {
        throw new TradeUnavailableError();
      }),
      null,
      options,
    );
    const closed = await hardcore.request('/api/trade/alice/bob?ruleset=hardcore');
    expect(closed.status).toBe(400);
    expect((await closed.json()).error).toMatch(/Pas d'échanges/);
  });

  it('lit les partenaires à comparer en plus, sans doublon ni pseudo invalide', () => {
    expect(parseTradeNames(undefined)).toEqual([]);
    expect(parseTradeNames(` bob, Bob,,carol ,${'x'.repeat(65)}`)).toEqual(['bob', 'carol']);
    const many = Array.from({ length: 12 }, (_, i) => `p${i}`).join(',');
    expect(parseTradeNames(many)).toHaveLength(10);
  });

  it('cherche les meilleurs partenaires, avec les réglages de chacun', async () => {
    const partners = {
      version: 1,
      partners: [],
      checked: 0,
      failed: [],
    } as unknown as TradePartners;
    const service = { partners: vi.fn(async () => partners) } as unknown as PlanService;
    const app = createApp(service, null, options);
    const res = await app.request('/api/partners/alexpresso?with=bob,carol&keep=golden&fresh=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(partners);
    expect(service.partners).toHaveBeenCalledWith(
      'alexpresso',
      'NORMAL',
      {
        names: ['bob', 'carol'],
        keep: { me: { golden: true, goldenFusions: false, constellation: false }, other: {} },
      },
      { fresh: true },
    );
    expect((await app.request(`/api/partners/${'x'.repeat(65)}`)).status).toBe(400);
    expect(service.partners).toHaveBeenCalledTimes(1);
  });

  it('dit si le joueur qui cherche est introuvable, et refuse le Hardcore', async () => {
    const failing = (error: Error) =>
      createApp(
        {
          partners: vi.fn(async () => {
            throw error;
          }),
        } as unknown as PlanService,
        null,
        options,
      );
    const missing = await failing(new PlayerNotFoundError('fantome')).request(
      '/api/partners/fantome',
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/« fantome » introuvable/);
    const closed = await failing(new TradeUnavailableError()).request(
      '/api/partners/alice?ruleset=hardcore',
    );
    expect(closed.status).toBe(400);
    const busy = await failing(new PlannerBusyError()).request('/api/partners/alice');
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('10');
  });
});

describe('métriques', () => {
  const day = 86_400_000;
  const metricsFor = (file: string | null = null) =>
    new Metrics({
      version: 'test',
      players: new PlayerTracker(file),
      pool: () => ({ threads: 2, busy: 1, queued: 0 }),
    });
  const scrape = async (app: ReturnType<typeof createApp>, init?: RequestInit) => {
    const res = await app.request('/metrics', init);
    return { status: res.status, text: await res.text() };
  };

  it('compte les demandes, les joueurs distincts et les pages vues', async () => {
    const webDir = tmp();
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Ninja</title>');
    const metrics = metricsFor();
    const app = createApp(
      fakeService(async (name) => {
        if (name === 'personne') throw new ZuNotFoundError('/public/user/personne');
        return plan;
      }),
      null,
      { ruleSet: 'NORMAL', users: [], webDir, cron: '* * * * *', metrics },
    );
    await app.request('/api/plan/Alice');
    await app.request('/api/plan/alice');
    await app.request('/api/plan/bob/discord');
    await app.request('/api/plan/personne');
    const navigate = { headers: { 'sec-fetch-mode': 'navigate' } };
    await app.request('/', navigate);
    await app.request('/strategie', navigate);
    // Ni une sonde, ni un aperçu de lien, ni un préchargement ne sont des pages vues.
    await app.request('/', { headers: { 'user-agent': 'Uptime-Kuma/2.0.0' } });
    await app.request('/', {
      headers: { 'sec-fetch-mode': 'navigate', 'sec-purpose': 'prefetch;prerender' },
    });

    const { status, text } = await scrape(app);
    expect(status).toBe(200);
    expect(text).toContain('zuninja_plan_requests_total{source="web",outcome="ok"} 2');
    expect(text).toContain('zuninja_plan_requests_total{source="bot",outcome="ok"} 1');
    expect(text).toContain('zuninja_plan_requests_total{source="web",outcome="not_found"} 1');
    // Alice et alice sont le même joueur ; un joueur introuvable ne compte pas.
    expect(text).toContain('zuninja_players{window="1d"} 2');
    expect(text).toContain('zuninja_page_views_total 2');
    expect(text).toContain('zuninja_planner_threads{state="busy"} 1');
    expect(text).toContain('zuninja_info{version="test"} 1');
    expect(text).toContain('zuninja_process_cpu_seconds_total');
  });

  it('expose les compteurs à zéro dès le démarrage', async () => {
    const text = await metricsFor().registry.metrics();
    expect(text).toContain('zuninja_plan_requests_total{source="web",outcome="ok"} 0');
    expect(text).toContain('zuninja_plan_requests_total{source="bot",outcome="busy"} 0');
    expect(text).toContain('zuninja_plans_computed_total{strategy="vortex",ruleset="HARDCORE"} 0');
  });

  it('protège /metrics par un jeton, et ne l’expose pas sans métriques', async () => {
    const base = {
      ruleSet: 'NORMAL' as const,
      users: [],
      webDir: join(tmp(), 'absent'),
      cron: '* * * * *',
    };
    const service = fakeService(async () => plan);
    const app = createApp(service, null, {
      ...base,
      metrics: metricsFor(),
      metricsToken: 's3cret',
    });
    expect((await scrape(app)).status).toBe(401);
    expect((await scrape(app, { headers: { authorization: 'Bearer s3cret' } })).status).toBe(200);

    const without = createApp(service, null, base);
    expect((await scrape(without)).status).toBe(404);
  });

  it('compte les passages planifiés sans retenir les joueurs suivis', async () => {
    const metrics = metricsFor();
    await runTick(
      fakeService(async () => plan),
      new StateStore(join(tmp(), 's.json')),
      [],
      {
        users: ['alice'],
        ruleSet: 'NORMAL',
        dryRun: true,
        metrics,
      },
    );
    const text = await metrics.registry.metrics();
    expect(text).toContain('zuninja_plan_requests_total{source="cron",outcome="ok"} 1');
    expect(text).toContain('zuninja_players{window="1d"} 0');
  });

  it('garde les joueurs vus entre deux redémarrages, sous forme d’empreintes', () => {
    const file = join(tmp(), 'metrics.json');
    const now = Date.now();
    const tracker = new PlayerTracker(file);
    tracker.see('Alice', now - 3 * day);
    tracker.see('bob', now);
    tracker.see('carol', now - 40 * day);
    tracker.save(now);

    expect(readFileSync(file, 'utf8')).not.toMatch(/alice|bob|carol/i);
    const reloaded = new PlayerTracker(file);
    expect(reloaded.count(day, now)).toBe(1);
    expect(reloaded.count(7 * day, now)).toBe(2);
    // Au-delà de 30 jours, l'empreinte est oubliée.
    expect(reloaded.count(365 * day, now)).toBe(2);
  });

  it('lit la configuration des métriques', () => {
    expect(loadConfig({})).toMatchObject({ metricsEnabled: true, metricsToken: undefined });
    expect(loadConfig({ METRICS: 'false', METRICS_TOKEN: ' t ' })).toMatchObject({
      metricsEnabled: false,
      metricsToken: 't',
    });
    expect(loadConfig({ STATE_FILE: '/data/state.json' }).metricsFile).toBe('/data/metrics.json');
  });
});
