import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerLookups } from '@zuninja/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureCatalog, fixturePlayer, NOW } from '../../../packages/core/test/helpers';
import { setLogLevel } from '../src/logger';
import { PlannerBusyError } from '../src/pool';
import { PlanService } from '../src/service';

setLogLevel('error');

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/test/fixtures');
const read = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const c = read('catalog.json');
const p = read('player.json');

// Deux des cartes dont la recherche cherche les plus gros possesseurs pour alexpresso.
const lookups = ownerLookups(fixtureCatalog(), fixturePlayer(), {}, NOW);
const shiny = lookups[0]!.wants[0]!.shiny;
const wanted = lookups
  .filter((l) => l.wants.some((w) => w.shiny === shiny))
  .slice(0, 2)
  .map((l) => c.items.find((i: { id: string }) => i.id === l.item.id));

/** « debutant » a neuf exemplaires de chacune : de quoi en céder, même sa constellation montée. */
const debutant = {
  user: { ...p.user, user: { ...p.user.user, id: 'debutant', discordUserName: 'debutant' } },
  inventory: wanted.map((item) => ({ item, quantity: 9, shinyLevel: shiny, upgradeLevel: 0 })),
};

/** Fausse API ZUnivers : alexpresso et ses fixtures, debutant, le marché et les fiches de cartes. */
function fakeApi() {
  const routes: [RegExp, unknown][] = [
    [/^\/app\/settings$/, c.settings],
    [/^\/public\/item$/, c.items],
    [/^\/public\/fusion$/, c.fusions],
    [/^\/public\/recycle\/config$/, c.config],
    [/^\/public\/event\/current$/, c.events],
    [/^\/public\/tower\/season$/, c.season],
    [/^\/public\/tower$/, c.towers],
    [/^\/public\/market$/, [{ user: { discordUserName: 'vendeur' }, date: '2026-10-20T10:00:00' }]],
    [
      new RegExp(`^/public/item/${wanted[0].slug}$`),
      { userInventories: { [shiny]: [{ user: { discordUserName: 'debutant' }, quantity: 9 }] } },
    ],
    [/^\/public\/user\/debutant$/, debutant.user],
    [/^\/public\/inventory\/debutant$/, debutant.inventory],
    [/^\/public\/user\/alexpresso\/overview$/, { invokeBeforePity: 160 }],
    [/^\/public\/user\/alexpresso$/, p.user],
    [/^\/public\/inventory\/alexpresso$/, p.inventory],
    [/^\/public\/challenge\/alexpresso$/, p.challenges],
    [/^\/public\/loot\/alexpresso$/, p.loot],
    [/^\/public\/tower\/alexpresso$/, p.tower],
    [/^\/public\/evolution\/alexpresso$/, p.evolution],
    [/^\/public\/corporation\//, p.corporation],
  ];
  return vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    const route = routes.find(([re]) => re.test(path));
    if (!route) return new Response(null, { status: 404 });
    if (route[1] == null) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(route[1]), {
      headers: { 'content-type': 'application/json' },
    });
  });
}

const calls = (fetch: ReturnType<typeof fakeApi>, re: RegExp) =>
  fetch.mock.calls.filter(([url]) => re.test(new URL(String(url)).pathname)).length;

const opened: PlanService[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close()));
});

function service(fetch: ReturnType<typeof fakeApi>) {
  const created = new PlanService({
    apiBaseUrl: 'https://zunivers.test',
    catalogTtlMs: 60_000,
    planner: {},
    threads: 1,
    queueLimit: 1,
    timeLimitMs: 0,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  opened.push(created);
  return created;
}

describe('recherche de partenaires', () => {
  it('trouve les gros possesseurs des cartes qui manquent, chargés en deux appels', async () => {
    expect(wanted).toHaveLength(2);
    const fetch = fakeApi();
    const plans = service(fetch);
    const result = await plans.partners('alexpresso', 'NORMAL');
    expect(result.partners.map((p) => p.player.name)).toEqual(['debutant']);
    expect(result.partners[0]).toMatchObject({ sources: ['owner'], holding: 1 });
    expect(result.partners[0]!.copies).toBeGreaterThan(0);
    // Le vendeur du marché n'existe plus : signalé, sans empêcher la recherche.
    expect(result.failed).toEqual(['vendeur']);
    // Ni défis, ni récompenses, ni Vortex pour l'autre joueur : son profil et sa collection.
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('debutant'))).toHaveLength(2);

    // L'échange avec lui réutilise sa collection, et la recherche suivante les fiches des cartes.
    const trade = await plans.trade('alexpresso', 'debutant', 'NORMAL');
    expect(trade.other.gives.map((c) => c.itemId).sort()).toEqual(wanted.map((i) => i.id).sort());
    await plans.partners('alexpresso', 'NORMAL');
    expect(calls(fetch, /^\/public\/inventory\/debutant$/)).toBe(1);
    expect(calls(fetch, new RegExp(`^/public/item/${wanted[0].slug}$`))).toBe(1);
  });

  it('refuse une recherche de plus quand deux sont déjà en cours', async () => {
    const plans = service(fakeApi());
    const running = [
      plans.partners('alexpresso', 'NORMAL'),
      plans.partners('alexpresso', 'NORMAL'),
    ];
    await expect(plans.partners('alexpresso', 'NORMAL')).rejects.toBeInstanceOf(PlannerBusyError);
    await Promise.all(running);
    // Les recherches terminées libèrent leur place.
    await expect(plans.partners('alexpresso', 'NORMAL')).resolves.toHaveProperty('partners');
  });
});
