import { describe, expect, it, vi } from 'vitest';
import {
  ApiCache,
  createClient,
  fetchMarketOffer,
  ZuApiError,
  ZuNotFoundError,
  ZuSchemaError,
} from '../src';
import { rawCatalog, rawPlayer } from './helpers';

function fakeFetch(responses: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (url: string | URL | Request) => {
    const path = String(url).replace('https://api.test', '');
    const r = responses[path] ?? { status: 404 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}

describe('fixtures', () => {
  it("valident les schémas (instantané réel de l'API)", () => {
    const catalog = rawCatalog();
    expect(catalog.items.length).toBeGreaterThan(500);
    expect(catalog.fusions.length).toBeGreaterThan(10);
    expect(catalog.season?.tower.towerFloors).toHaveLength(6);
    const player = rawPlayer();
    expect(player.user.user.discordUserName).toBe('alexpresso');
    expect(player.inventory.length).toBeGreaterThan(100);
  });
});

describe('client API', () => {
  it("envoie l'en-tête de mode de jeu", async () => {
    const fetch = fakeFetch({ '/app/settings': { status: 200, body: { dailyReward: 1000 } } });
    const client = createClient({ baseUrl: 'https://api.test', fetch, ruleSet: 'HARDCORE' });
    const settings = await client.settings();
    expect(settings.dailyReward).toBe(1000);
    expect(settings.dailyLoreDust).toBe(10);
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-zunivers-rulesettype']).toBe('HARDCORE');
  });

  it('signale un joueur inconnu par une ZuNotFoundError', async () => {
    const client = createClient({ baseUrl: 'https://api.test', fetch: fakeFetch({}) });
    await expect(client.user('personne')).rejects.toBeInstanceOf(ZuNotFoundError);
  });

  it("signale clairement un changement de format de l'API", async () => {
    const fetch = fakeFetch({
      '/public/item': { status: 200, body: [{ id: 'x', name: 'Sans rareté' }] },
    });
    const client = createClient({ baseUrl: 'https://api.test', fetch });
    await expect(client.items()).rejects.toBeInstanceOf(ZuSchemaError);
  });

  it('réessaie sur erreur serveur puis échoue proprement', async () => {
    const fetch = fakeFetch({ '/public/fusion': { status: 503 } });
    const client = createClient({ baseUrl: 'https://api.test', fetch, retries: 1 });
    await expect(client.fusions()).rejects.toBeInstanceOf(ZuApiError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('renvoie null quand il n’y a pas de saison de Vortex (204)', async () => {
    const fetch = fakeFetch({ '/public/tower/season': { status: 204 } });
    const client = createClient({ baseUrl: 'https://api.test', fetch });
    await expect(client.towerSeason()).resolves.toBeNull();
  });

  it('renvoie null pour une ressource facultative absente (404, régression Hardcore)', async () => {
    // En Hardcore, l'API répond 404 sans saison de Vortex : le catalogue entier échouait, et
    // le serveur annonçait le joueur introuvable.
    const fetch = fakeFetch({});
    const client = createClient({ baseUrl: 'https://api.test', fetch });
    await expect(client.towerSeason()).resolves.toBeNull();
    await expect(client.evolution('alice')).resolves.toBeNull();
    await expect(client.user('alice')).rejects.toBeInstanceOf(ZuNotFoundError);
  });
});

describe('marché', () => {
  it('lit l’annonce d’un joueur, ou rien quand il n’en a pas (404)', async () => {
    const entry = (id: string) => ({ quantity: 1, item: { id, name: id, identifier: 1001 } });
    const fetch = fakeFetch({
      '/public/market/search?discordUserName=grewa': {
        status: 200,
        body: {
          id: 'offre',
          date: '2026-10-19T13:58:01',
          entriesSell: [entry('a')],
          entriesBuy: [entry('b'), entry('c')],
          sellCount: 1,
          buyCount: 2,
        },
      },
    });
    const client = createClient({ baseUrl: 'https://api.test', fetch });
    await expect(fetchMarketOffer(client, 'grewa')).resolves.toEqual({
      offers: ['a'],
      wants: ['b', 'c'],
    });
    await expect(fetchMarketOffer(client, 'personne')).resolves.toBeNull();
  });

  it('ignore un marché qui ne répond pas', async () => {
    const fetch = fakeFetch({ '/public/market/search?discordUserName=grewa': { status: 503 } });
    const client = createClient({ baseUrl: 'https://api.test', fetch, retries: 0 });
    await expect(fetchMarketOffer(client, 'grewa')).resolves.toBeNull();
  });
});

describe('cache des réponses', () => {
  function setup() {
    let now = 0;
    const cache = new ApiCache<number>({
      ttlMs: 60_000,
      freshMinMs: 15_000,
      maxSize: 2,
      now: () => now,
    });
    let calls = 0;
    const load = vi.fn(async () => ++calls);
    return { cache, load, tick: (ms: number) => (now += ms) };
  }

  it('réutilise une réponse tant qu’elle est fraîche, et partage un appel en cours', async () => {
    const { cache, load, tick } = setup();
    const [a, b] = [cache.get('alice', load), cache.get('alice', load)];
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    tick(59_000);
    expect(await cache.get('alice', load)).toBe(1);
    tick(1_000);
    expect(await cache.get('alice', load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('ne recharge à la demande qu’une réponse assez ancienne', async () => {
    const { cache, load, tick } = setup();
    await cache.get('alice', load);
    tick(10_000);
    expect(await cache.get('alice', load, true)).toBe(1);
    tick(5_000);
    expect(await cache.get('alice', load, true)).toBe(2);
  });

  it('oublie un appel échoué et les réponses les plus anciennes', async () => {
    const { cache, load } = setup();
    const failing = vi.fn(async () => {
      throw new Error('panne');
    });
    await expect(cache.get('alice', failing)).rejects.toThrow('panne');
    expect(await cache.get('alice', load)).toBe(1);
    await cache.get('bob', load);
    await cache.get('carol', load);
    expect(await cache.get('alice', load)).toBe(4);
  });
});
