import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlan, type CreatePlanInput } from '@zuninja/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureCatalog, fixturePlayer, NOW } from '../../../packages/core/test/helpers';
import { setLogLevel } from '../src/logger';
import { PlanAbortedError, PlannerBusyError, PlannerPool, PlannerTimeoutError } from '../src/pool';
import { PlanService } from '../src/service';

setLogLevel('error');

// Glouton : rapide, le résultat exact n'importe pas ici.
const input: CreatePlanInput = {
  catalog: fixtureCatalog(),
  player: fixturePlayer(),
  now: NOW,
  options: { beamWidth: 1 },
};

const opened: { close: () => Promise<void> }[] = [];
function track<T extends { close: () => Promise<void> }>(value: T): T {
  opened.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close()));
});

describe('pool de threads', { timeout: 30_000 }, () => {
  it('calcule le même plan que sur le thread principal', async () => {
    const pool = track(new PlannerPool({ threads: 1, queueLimit: 0, timeoutMs: 0 }));
    const plan = await pool.run(input);
    expect(plan.hash).toBe(createPlan(input).hash);
  });

  it('refuse un calcul quand les threads et la file sont pleins', async () => {
    const pool = track(new PlannerPool({ threads: 1, queueLimit: 1, timeoutMs: 0 }));
    const running = pool.run(input);
    const queued = pool.run(input);
    expect(pool.saturated).toBe(true);
    await expect(pool.run(input)).rejects.toBeInstanceOf(PlannerBusyError);
    await expect(running).resolves.toHaveProperty('hash');
    await expect(queued).resolves.toHaveProperty('hash');
    expect(pool.saturated).toBe(false);
  });

  it('libère le thread quand un calcul est abandonné', async () => {
    const pool = track(new PlannerPool({ threads: 1, queueLimit: 1, timeoutMs: 0 }));
    const running = new AbortController();
    const queued = new AbortController();
    const first = pool.run(input, running.signal);
    const second = pool.run(input, queued.signal);
    queued.abort();
    await expect(second).rejects.toBeInstanceOf(PlanAbortedError);
    running.abort();
    await expect(first).rejects.toBeInstanceOf(PlanAbortedError);
    expect(pool.saturated).toBe(false);
    await expect(pool.run(input)).resolves.toHaveProperty('hash');
  });

  it('arrête un calcul trop long puis continue avec un nouveau thread', async () => {
    const pool = track(new PlannerPool({ threads: 1, queueLimit: 1, timeoutMs: 1 }));
    await expect(pool.run(input)).rejects.toBeInstanceOf(PlannerTimeoutError);
    const patient = track(new PlannerPool({ threads: 1, queueLimit: 0, timeoutMs: 0 }));
    await expect(patient.run(input)).resolves.toHaveProperty('hash');
  });
});

/** Fausse API ZUnivers servie depuis les fixtures. */
function fixtureApi() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/test/fixtures');
  const c = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
  const p = JSON.parse(readFileSync(join(dir, 'player.json'), 'utf8'));
  const routes: [RegExp, unknown][] = [
    [/^\/app\/settings$/, c.settings],
    [/^\/public\/item$/, c.items],
    [/^\/public\/fusion$/, c.fusions],
    [/^\/public\/recycle\/config$/, c.config],
    [/^\/public\/event\/current$/, c.events],
    [/^\/public\/tower\/season$/, c.season],
    [/^\/public\/tower$/, c.towers],
    [/^\/public\/user\/[^/]+\/overview$/, { invokeBeforePity: 160 }],
    [/^\/public\/user\//, p.user],
    [/^\/public\/inventory\//, p.inventory],
    [/^\/public\/challenge\//, p.challenges],
    [/^\/public\/loot\//, p.loot],
    [/^\/public\/tower\//, p.tower],
    [/^\/public\/evolution\//, p.evolution],
    [/^\/public\/corporation\//, p.corporation],
  ];
  return vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    const route = routes.find(([re]) => re.test(path));
    if (!route) return new Response(null, { status: 404 });
    // Ressource facultative absente (saison, évolution…) : 204, comme l'API.
    if (route[1] == null) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(route[1]), {
      headers: { 'content-type': 'application/json' },
    });
  });
}

function service(fetch: ReturnType<typeof fixtureApi>) {
  return track(
    new PlanService({
      apiBaseUrl: 'https://zunivers.test',
      catalogTtlMs: 60_000,
      planner: { beamWidth: 1 },
      threads: 1,
      queueLimit: 2,
      timeLimitMs: 0,
      fetch: fetch as unknown as typeof globalThis.fetch,
    }),
  );
}
/** Requêtes du profil joueur (`/public/user/{pseudo}`) : une par calcul de plan. */
const userCalls = (fetch: ReturnType<typeof fixtureApi>) =>
  fetch.mock.calls.filter(([url]) => /\/public\/user\/[^/]+$/.test(new URL(String(url)).pathname))
    .length;

describe('service de plans', { timeout: 30_000 }, () => {
  it('partage le calcul entre des requêtes identiques simultanées', async () => {
    const fetch = fixtureApi();
    const plans = service(fetch);
    const [a, b] = await Promise.all([
      plans.plan('alexpresso', 'NORMAL', {}, { fresh: true }),
      plans.plan('alexpresso', 'NORMAL', {}, { fresh: true }),
    ]);
    expect(a).toBe(b);
    expect(userCalls(fetch)).toBe(1);
  });

  it("n'annule le calcul partagé que lorsque tout le monde est parti", async () => {
    const fetch = fixtureApi();
    const plans = service(fetch);
    const leaving = new AbortController();
    const staying = new AbortController();
    const left = plans.plan('alexpresso', 'NORMAL', {}, { signal: leaving.signal });
    const stayed = plans.plan('alexpresso', 'NORMAL', {}, { signal: staying.signal });
    leaving.abort();
    await expect(left).rejects.toBeInstanceOf(PlanAbortedError);
    await expect(stayed).resolves.toHaveProperty('hash');
    expect(userCalls(fetch)).toBe(1);
  });

  it('relance un nouveau calcul après un abandon', async () => {
    const fetch = fixtureApi();
    const plans = service(fetch);
    const gone = new AbortController();
    const abandoned = plans.plan('alexpresso', 'NORMAL', {}, { signal: gone.signal });
    gone.abort();
    await expect(abandoned).rejects.toBeInstanceOf(PlanAbortedError);
    await expect(plans.plan('alexpresso', 'NORMAL')).resolves.toHaveProperty('hash');
    // Le calcul est relancé, mais les données du joueur déjà chargées sont réutilisées.
    expect(userCalls(fetch)).toBe(1);
  });

  it("ne rappelle pas l'API ZUnivers quand seuls les réglages changent", async () => {
    const fetch = fixtureApi();
    const plans = service(fetch);
    await plans.plan('alexpresso', 'NORMAL');
    await plans.plan('alexpresso', 'NORMAL', { strategy: 'prudent' });
    await plans.plan('alexpresso', 'NORMAL', {}, { fresh: true });
    expect(userCalls(fetch)).toBe(1);
  });
});
