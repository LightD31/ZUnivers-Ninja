import { z } from 'zod';

/**
 * Schémas des réponses de l'API publique ZUnivers.
 *
 * Volontairement tolérants : les champs inconnus sont conservés (`looseObject`) et les champs
 * secondaires ont des valeurs par défaut, pour qu'un ajout côté API ne casse pas l'application.
 * Un champ indispensable qui disparaît produit en revanche une erreur explicite.
 */

const num = z.number();
const flag = z.boolean().default(false);

export const PackSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  slug: z.string().default(''),
  year: z.number().nullish(),
});

export const ItemSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  slug: z.string().default(''),
  genre: z.string().default(''),
  rarity: num,
  identifier: num,
  pack: PackSchema,
  urls: z.array(z.string()).default([]),
  scores: z.record(z.string(), num).default({}),
  shinyLevels: z.record(z.string(), z.boolean()).default({}),
  isRecyclable: flag,
  isTradable: flag,
  isCounting: flag,
  isCraftable: flag,
  isInvocable: flag,
  isGoldable: flag,
  isUpgradable: flag,
});
export type ApiItem = z.infer<typeof ItemSchema>;

export const FusionSchema = z.looseObject({
  item: ItemSchema,
  items: z.array(ItemSchema),
});
export type ApiFusion = z.infer<typeof FusionSchema>;

export const RecycleConfigSchema = z.array(
  z.looseObject({
    rarity: num,
    shinyLevel: num,
    recycleValue: num,
    craftValue: num,
  }),
);
export type ApiRecycleConfig = z.infer<typeof RecycleConfigSchema>;

export const SettingsSchema = z.looseObject({
  dailyReward: num.default(1000),
  weeklyReward: num.default(1000),
  dailyLoreDust: num.default(10),
  gameFeatures: z.array(z.string()).default([]),
  currentEventId: z.string().nullish(),
  /** La dernière saison Hardcore est terminée (aucune en cours). */
  lastHardcoreSeasonDone: z.boolean().nullish(),
});
export type ApiSettings = z.infer<typeof SettingsSchema>;

export const EventSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  pack: PackSchema.nullish(),
  items: z.array(ItemSchema).default([]),
  balanceCost: num.default(0),
  loreDustCost: num.default(0),
  isOneTime: flag,
  isActive: z.boolean().default(true),
  invokeCount: num.default(10),
  beginDate: z.string(),
  endDate: z.string(),
  imageUrl: z.string().nullish(),
});
export const EventsSchema = z.array(EventSchema);
export type ApiEvent = z.infer<typeof EventSchema>;

export const TowerSchema = z.looseObject({
  id: z.string(),
  index: num.default(0),
  name: z.string(),
  group: z.string().default(''),
  imageUrl: z.string().nullish(),
  pack: PackSchema,
  towerFloors: z
    .array(
      z.looseObject({
        index: num,
        rate: num,
        dropRates: z
          .array(z.looseObject({ rarity: num, shinyLevel: num.default(0), rate: num }))
          .default([]),
      }),
    )
    .default([]),
});
export const TowersSchema = z.array(TowerSchema);
export type ApiTower = z.infer<typeof TowerSchema>;

export const TowerSeasonSchema = z.looseObject({
  id: z.string(),
  index: num.default(0),
  beginDate: z.string(),
  endDate: z.string(),
  tower: TowerSchema,
});
export type ApiTowerSeason = z.infer<typeof TowerSeasonSchema>;

export const UserSchema = z.looseObject({
  user: z.looseObject({
    id: z.string(),
    discordId: z.string().nullish(),
    discordUserName: z.string(),
    discordGlobalName: z.string().nullish(),
    discordAvatar: z.string().nullish(),
    balance: num.default(0),
    loreDust: num.default(0),
    loreFragment: num.default(0),
    upgradeDust: num.default(0),
    ruleSetType: z.string().nullish(),
  }),
  inventoryCount: num.default(0),
  inventoryUniqueCount: num.default(0),
  inventoryUniqueGoldenCount: num.default(0),
  itemCount: num.default(0),
  tradeCountToday: num.default(0),
  tradeLimit: num.default(2),
  subscriptionBonusCount: num.default(0),
  subscriptionBonusLimit: num.default(0),
  isSubscribed: z.boolean().optional(),
  /** Abonnement premium en cours, absent sinon. */
  subscription: z.looseObject({ beginDate: z.string(), endDate: z.string() }).nullish(),
  /**
   * Bons d'invocation gratuite (« Bons à utiliser » du profil) : un par invocation, à faire avec
   * `/im <nom de l'évènement>`. Ignorés s'ils deviennent illisibles : ils ne sont qu'un bonus.
   */
  vouchers: z
    .array(
      z.looseObject({
        event: z.looseObject({
          id: z.string(),
          name: z.string(),
          packs: z.array(PackSchema).default([]),
          isInversePack: flag,
          isPityEnabled: z.boolean().default(true),
          isActive: z.boolean().default(true),
          invokeCount: num.default(10),
        }),
      }),
    )
    .catch([]),
  currentLootStreak: num.default(0),
  maxLootStreak: num.default(0),
  userCorporation: z
    .looseObject({
      corporation: z.looseObject({ id: z.string(), name: z.string().default('') }).nullish(),
    })
    .nullish(),
});
export type ApiUser = z.infer<typeof UserSchema>;

export const InventoryEntrySchema = z.looseObject({
  id: z.string().optional(),
  item: ItemSchema,
  quantity: num,
  shinyLevel: num.nullish(),
  /** Ancien format de l'API, avant l'arrivée des cartes chromatiques. */
  isGolden: z.boolean().nullish(),
  upgradeLevel: num.nullish(),
});
export const InventorySchema = z.array(InventoryEntrySchema);
export type ApiInventoryEntry = z.infer<typeof InventoryEntrySchema>;

export const ChallengeSchema = z.looseObject({
  id: z.string(),
  beginDate: z.string().nullish(),
  endDate: z.string().nullish(),
  challenge: z.looseObject({
    id: z.string(),
    description: z.string().default(''),
    type: z.string().default('UNKNOWN'),
    score: num.default(0),
    rewardLoreDust: num.default(0),
  }),
  progress: z.looseObject({ type: z.string().nullish(), current: num, max: num }).nullish(),
  challengeLog: z.unknown().nullish(),
});
export const ChallengesSchema = z.array(ChallengeSchema);
export type ApiChallenge = z.infer<typeof ChallengeSchema>;

export const LootSchema = z.record(
  z.string(),
  z.array(
    z.looseObject({
      amount: num.default(0),
      type: z.string(),
      date: z.string().nullish(),
    }),
  ),
);
export type ApiLoot = z.infer<typeof LootSchema>;

export const UserTowerSchema = z.looseObject({
  towerStats: z
    .array(
      z.looseObject({
        /** Dernier étage atteint (0 = étage 1), absent tant que le joueur n'est pas entré. */
        maxFloorIndex: num.nullish(),
        towerLogCount: num.default(0),
        towerSeasonIndex: num.nullish(),
        isCurrentTowerSeason: z.boolean().default(false),
        towerSeasonBeginDate: z.string(),
        towerSeasonEndDate: z.string(),
        towerName: z.string().nullish(),
      }),
    )
    .default([]),
});
export type ApiUserTower = z.infer<typeof UserTowerSchema>;

/**
 * `/public/inventory/{pseudo}/logs` : cartes reçues, par date d'opération. Seules les dates servent
 * (invocations premium déjà faites pendant l'abonnement).
 */
export const InventoryLogsSchema = z.record(z.string(), z.array(z.unknown()));
export type ApiInventoryLogs = z.infer<typeof InventoryLogsSchema>;

/** `/public/user/{pseudo}/overview` : seul le compteur de bienveillance sert au planificateur. */
export const UserOverviewSchema = z.looseObject({
  /** Cartes à invoquer avant la carte 4 ★ garantie (la 210ᵉ sans 4 ★). */
  invokeBeforePity: num.nullish(),
});
export type ApiUserOverview = z.infer<typeof UserOverviewSchema>;

export const EvolutionSchema = z.looseObject({
  upgradeDust: num.nullish(),
  evolutionUpgradeDustCost: z.array(num).default([]),
  evolutionItems: z
    .array(z.looseObject({ item: ItemSchema, isOwned: z.boolean().default(false) }))
    .default([]),
});
export type ApiEvolution = z.infer<typeof EvolutionSchema>;

export const CorporationSchema = z.looseObject({
  id: z.string(),
  name: z.string().default(''),
  corporationBonuses: z
    .array(z.looseObject({ type: z.string(), level: num.default(0) }))
    .nullish()
    .transform((v) => v ?? []),
});
export type ApiCorporation = z.infer<typeof CorporationSchema>;

/** `/public/achievement/{pseudo}/category` : catégories de succès et progression globale. */
export const AchievementCategorySchema = z.looseObject({
  id: z.string(),
  name: z.string().default(''),
  doneCount: num.default(0),
  totalCount: num.default(0),
});
export const AchievementCategoriesSchema = z.array(AchievementCategorySchema);
export type ApiAchievementCategory = z.infer<typeof AchievementCategorySchema>;

/** `/public/achievement/{pseudo}/{catégorie}` : un succès, obtenu (`date`) ou en cours. */
export const AchievementEntrySchema = z.looseObject({
  /** Date d'obtention, absente tant que le succès n'est pas obtenu. */
  date: z.string().nullish(),
  /**
   * Date de retrait d'un succès « supprimable » : quand une carte rejoint sa collection, le succès
   * est retiré (avec ses points) jusqu'à ce que la collection soit de nouveau complète.
   */
  deleteDate: z.string().nullish(),
  achievement: z.looseObject({
    id: z.string(),
    name: z.string().default(''),
    description: z.string().default(''),
    score: num.default(0),
    rewardLoreDust: num.nullish(),
  }),
  progress: z.looseObject({ type: z.string().nullish(), current: num, max: num }).nullish(),
});
export const AchievementEntriesSchema = z.array(AchievementEntrySchema);
export type ApiAchievementEntry = z.infer<typeof AchievementEntrySchema>;

/**
 * `/public/market/search?discordUserName=…` : annonce du joueur sur le marché (404 sans annonce).
 * Seul l'identifiant des cartes sert : la liste générale du marché en donne une fiche réduite.
 */
const MarketEntriesSchema = z
  .array(z.looseObject({ quantity: num.default(1), item: z.looseObject({ id: z.string() }) }))
  .default([]);
export const MarketOfferSchema = z.looseObject({
  /** Cartes proposées à l'échange. */
  entriesSell: MarketEntriesSchema,
  /** Cartes recherchées. */
  entriesBuy: MarketEntriesSchema,
});
export type ApiMarketOffer = z.infer<typeof MarketOfferSchema>;
