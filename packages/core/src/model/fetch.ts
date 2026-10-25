import type { ZuClient } from '../api/client';
import type { ApiAchievementEntry } from '../api/schemas';
import { PREMIUM_BOOSTER } from '../rules/constants';
import { normalizeCatalog, normalizePlayer, type RawCatalog, type RawPlayer } from './normalize';
import type { Catalog, ItemOwner, MarketListing, MarketOffer, Player } from './types';

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

/**
 * Joueur réduit à ce qu'un échange regarde : son profil et sa collection, en deux appels au lieu
 * d'une quinzaine. Défis, récompenses, Vortex, succès et corporation restent vides : ce joueur
 * sert à comparer des collections, pas à calculer un plan.
 */
export async function fetchTradePlayer(client: ZuClient, name: string): Promise<Player> {
  const [user, inventory] = await Promise.all([client.user(name), client.inventory(name)]);
  return normalizePlayer(
    {
      user,
      inventory,
      challenges: [],
      loot: {},
      tower: { towerStats: [] },
      evolution: null,
      corporation: null,
    },
    client.ruleSet,
  );
}

/**
 * Annonces du marché, la plus récente d'abord. Échoue si le marché ne répond pas : l'appelant s'en
 * passe, sans garder cette absence en cache.
 */
export async function fetchMarketListings(client: ZuClient): Promise<MarketListing[]> {
  const listings = await client.market();
  return listings
    .map((l) => ({ name: l.user.discordUserName, date: l.date.slice(0, 19) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Plus gros possesseurs d'une carte, 50 par brillance : aucun si la carte n'a pas de fiche. Échoue
 * si l'API ne répond pas, pour ne pas garder cette absence en cache.
 */
export async function fetchItemOwners(client: ZuClient, slug: string): Promise<ItemOwner[]> {
  const page = await client.itemOwners(slug);
  if (!page) return [];
  return Object.entries(page.userInventories).flatMap(([level, owners]) => {
    const shiny = Number(level);
    if (shiny !== 0 && shiny !== 1 && shiny !== 2) return [];
    return owners.map((o) => ({ name: o.user.discordUserName, shiny, quantity: o.quantity }));
  });
}

/**
 * Annonce du joueur sur le marché. Facultative : `null` sans annonce, ou si le marché ne répond
 * pas (elle ne sert qu'à mettre en avant les cartes recherchées).
 */
export async function fetchMarketOffer(
  client: ZuClient,
  name: string,
): Promise<MarketOffer | null> {
  const offer = await client.marketOffer(name).catch(() => null);
  if (!offer) return null;
  return {
    offers: offer.entriesSell.map((e) => e.item.id),
    wants: offer.entriesBuy.map((e) => e.item.id),
  };
}
