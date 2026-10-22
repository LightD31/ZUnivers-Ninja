/// <reference lib="webworker" />
import {
  ApiCache,
  compareForTrade,
  createClient,
  createPlan,
  fetchCatalog,
  fetchMarketOffer,
  fetchPlayer,
  tradesAvailable,
  ZuNotFoundError,
  ZuSchemaError,
  type Catalog,
  type MarketOffer,
  type Player,
  type PlannerOptionsInput,
  type RuleSet,
  type TradeKeep,
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
/** Annonces du marché, pour les échanges. */
const markets = new ApiCache<MarketOffer | null>({ ttlMs: 60_000, freshMinMs: 15_000 });

type Request = { id: number; ruleSet: RuleSet; fresh: boolean } & (
  | { type: 'plan'; user: string; options: PlannerOptionsInput }
  | {
      type: 'trade';
      me: string;
      other: string;
      keep: { me: TradeKeep; other: TradeKeep };
    }
);

/** Erreur à montrer telle quelle au joueur. */
class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const catalog = (ruleSet: RuleSet, fresh: boolean) =>
  catalogs.get(ruleSet, () => fetchCatalog(createClient({ ruleSet })), fresh);

function player(name: string, ruleSet: RuleSet, fresh: boolean) {
  return players
    .get(
      `${ruleSet}|${name.toLowerCase()}`,
      () => fetchPlayer(createClient({ ruleSet }), name),
      fresh,
    )
    .catch((error: unknown) => {
      throw error instanceof ZuNotFoundError
        ? new RequestError(`Joueur « ${name} » introuvable sur ZUnivers (${ruleSet}).`, 404)
        : error;
    });
}

const market = (name: string, ruleSet: RuleSet, fresh: boolean) =>
  markets.get(
    `${ruleSet}|${name.toLowerCase()}`,
    () => fetchMarketOffer(createClient({ ruleSet }), name),
    fresh,
  );

async function handle(request: Request) {
  const { ruleSet, fresh } = request;
  if (request.type === 'plan') {
    const [c, p] = await Promise.all([
      catalog(ruleSet, fresh),
      player(request.user, ruleSet, fresh),
    ]);
    return createPlan({ catalog: c, player: p, options: request.options });
  }
  const c = await catalog(ruleSet, fresh);
  if (!tradesAvailable(c)) throw new RequestError("Pas d'échanges dans ce mode de jeu.", 400);
  const [me, other, meMarket, otherMarket] = await Promise.all([
    player(request.me, ruleSet, fresh),
    player(request.other, ruleSet, fresh),
    market(request.me, ruleSet, fresh),
    market(request.other, ruleSet, fresh),
  ]);
  return compareForTrade({
    catalog: c,
    me,
    other,
    keep: request.keep,
    market: { me: meMarket, other: otherMarket },
  });
}

self.addEventListener('message', async (event: MessageEvent<Request>) => {
  const { id } = event.data;
  try {
    self.postMessage({ id, ok: true, result: await handle(event.data) });
  } catch (error) {
    const status =
      error instanceof RequestError ? error.status : error instanceof ZuSchemaError ? 502 : 500;
    const message =
      error instanceof RequestError
        ? error.message
        : error instanceof ZuSchemaError
          ? "L'API ZUnivers a changé de format, ZUnivers Ninja doit être mis à jour."
          : "L'API ZUnivers ne répond pas pour le moment, réessaie dans un instant.";
    self.postMessage({ id, ok: false, error: message, status });
  }
});
