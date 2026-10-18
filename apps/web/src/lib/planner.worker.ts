/// <reference lib="webworker" />
import {
  ApiCache,
  createClient,
  createPlan,
  fetchCatalog,
  fetchPlayer,
  ZuNotFoundError,
  ZuSchemaError,
  type Catalog,
  type Player,
  type PlannerOptionsInput,
  type RuleSet,
} from '@zuninja/core';

/**
 * Le catalogue (cartes, fusions, évènements…) change rarement : « Actualiser » ne le recharge
 * que s'il date de plus de 5 minutes.
 */
const catalogs = new ApiCache<Catalog>({ ttlMs: 15 * 60_000, freshMinMs: 5 * 60_000 });
/**
 * Données du joueur : réutilisées quand seuls les réglages changent, rechargées par
 * « Actualiser » sauf si elles ont moins de 15 secondes.
 */
const players = new ApiCache<Player>({ ttlMs: 60_000, freshMinMs: 15_000, maxSize: 20 });

interface Request {
  id: number;
  user: string;
  ruleSet: RuleSet;
  options: PlannerOptionsInput;
  fresh: boolean;
}

self.addEventListener('message', async (event: MessageEvent<Request>) => {
  const { id, user, ruleSet, options, fresh } = event.data;
  try {
    const [catalog, player] = await Promise.all([
      catalogs.get(ruleSet, () => fetchCatalog(createClient({ ruleSet })), fresh),
      players.get(
        `${ruleSet}|${user.toLowerCase()}`,
        () => fetchPlayer(createClient({ ruleSet }), user),
        fresh,
      ),
    ]);
    const plan = createPlan({ catalog, player, options });
    self.postMessage({ id, ok: true, plan });
  } catch (error) {
    const status =
      error instanceof ZuNotFoundError ? 404 : error instanceof ZuSchemaError ? 502 : 500;
    const message =
      error instanceof ZuNotFoundError
        ? `Joueur « ${user} » introuvable sur ZUnivers (${ruleSet}).`
        : error instanceof ZuSchemaError
          ? "L'API ZUnivers a changé de format, ZUnivers Ninja doit être mis à jour."
          : "L'API ZUnivers ne répond pas pour le moment, réessaie dans un instant.";
    self.postMessage({ id, ok: false, error: message, status });
  }
});
