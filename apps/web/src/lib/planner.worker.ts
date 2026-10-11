/// <reference lib="webworker" />
import {
  createClient,
  createPlan,
  fetchCatalog,
  fetchPlayer,
  ZuNotFoundError,
  ZuSchemaError,
  type Catalog,
  type PlannerOptionsInput,
  type RuleSet,
} from '@zuninja/core';

const CATALOG_TTL_MS = 15 * 60_000;
const catalogs = new Map<RuleSet, { value: Promise<Catalog>; expires: number }>();

function catalogFor(ruleSet: RuleSet, fresh: boolean): Promise<Catalog> {
  const cached = catalogs.get(ruleSet);
  if (!fresh && cached && cached.expires > Date.now()) return cached.value;
  const value = fetchCatalog(createClient({ ruleSet }));
  catalogs.set(ruleSet, { value, expires: Date.now() + CATALOG_TTL_MS });
  value.catch(() => catalogs.delete(ruleSet));
  return value;
}

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
      catalogFor(ruleSet, fresh),
      fetchPlayer(createClient({ ruleSet }), user),
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
