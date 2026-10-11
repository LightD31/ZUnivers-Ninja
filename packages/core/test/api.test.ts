import { describe, expect, it, vi } from 'vitest';
import { createClient, ZuApiError, ZuNotFoundError, ZuSchemaError } from '../src';
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
