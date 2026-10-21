import type { ZuClient } from '../api/client';
import type { ApiAchievementEntry } from '../api/schemas';
import { PREMIUM_BOOSTER } from '../rules/constants';
import { normalizeCatalog, normalizePlayer, type RawCatalog, type RawPlayer } from './normalize';
import type { Catalog, Player } from './types';

/** Données communes à tous les joueurs (cartes, fusions, évènements, Vortex…). */
export async function fetchRawCatalog(client: ZuClient): Promise<RawCatalog> {
  const [settings, items, fusions, config, events, season, towers, nextTower] = await Promise.all([
    client.settings(),
    client.items(),
    client.fusions(),
    client.recycleConfig(),
    client.events(),
    client.towerSeason(),
    client.towers(),
    // Facultatif : sans elle, l'anticipation prévoit le prochain Vortex d'après l'historique.
    client.nextTower().catch(() => null),
  ]);
  return { settings, items, fusions, config, events, season, towers, nextTower };
}

export async function fetchRawPlayer(client: ZuClient, name: string): Promise<RawPlayer> {
  // `user` en premier : renvoie une ZuNotFoundError claire si le pseudo n'existe pas.
  const user = await client.user(name);
  const corporationId = user.userCorporation?.corporation?.id;
  const [
    inventory,
    challenges,
    loot,
    tower,
    evolution,
    overview,
    achievements,
    corporation,
    premiumLogs,
  ] = await Promise.all([
    client.inventory(name),
    client.challenges(name),
    client.loot(name),
    client.userTower(name),
    client.evolution(name),
    client.overview(name),
    fetchAchievements(client, name),
    corporationId ? client.corporation(corporationId) : null,
    // Invocations premium déjà faites : la prochaine est-elle disponible, le premier mois offert ?
    client.invocationLogs(name, PREMIUM_BOOSTER).catch(() => null),
  ]);
  return {
    user,
    inventory,
    challenges,
    loot,
    tower,
    evolution,
    corporation,
    overview,
    achievements,
    premiumLogs,
  };
}

/**
 * Succès du joueur, catégorie par catégorie. Seules les catégories pas encore terminées sont
 * chargées : les succès obtenus ne servent pas au planificateur. `null` si l'API ne les donne pas.
 */
export async function fetchAchievements(
  client: ZuClient,
  name: string,
): Promise<ApiAchievementEntry[] | null> {
  const categories = await client.achievementCategories(name);
  if (!categories) return null;
  const lists = await Promise.all(
    categories
      .filter((c) => c.doneCount < c.totalCount)
      .map((c) => client.achievements(name, c.id)),
  );
  return lists.flatMap((list) => list ?? []);
}

export async function fetchCatalog(client: ZuClient): Promise<Catalog> {
  return normalizeCatalog(await fetchRawCatalog(client), client.ruleSet);
}

export async function fetchPlayer(client: ZuClient, name: string): Promise<Player> {
  return normalizePlayer(await fetchRawPlayer(client, name), client.ruleSet);
}
