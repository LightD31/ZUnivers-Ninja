import type { PlannerOptionsInput } from './context';

/**
 * Stratégies : préréglages des options du planificateur selon la préférence du joueur.
 * Les options explicites (poids, doublons gardés…) restent prioritaires sur le préréglage.
 */
export const STRATEGY_IDS = [
  'equilibre',
  'prudent',
  'epargne',
  'vortex',
  'collectionneur',
  'echangeur',
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

export interface Strategy {
  id: StrategyId;
  label: string;
  description: string;
  options: PlannerOptionsInput;
}

export const DEFAULT_STRATEGY: StrategyId = 'equilibre';

export const STRATEGIES: Record<StrategyId, Strategy> = {
  equilibre: {
    id: 'equilibre',
    label: 'Équilibré',
    description: 'Le plus de points de collection possible, tirages compris en espérance.',
    options: {},
  },
  prudent: {
    id: 'prudent',
    label: 'Prudent',
    description:
      'Privilégie les points garantis : les invocations et ascensions ne comptent que pour moitié.',
    options: { evFactor: 0.5 },
  },
  epargne: {
    id: 'epargne',
    label: 'Épargne',
    description:
      'Garde des monnaies pour un évènement ou un nouveau pack : ne dépense que pour les actions très rentables.',
    // Poids par défaut × 15.
    options: { weights: { balance: 0.03, loreDust: 0.15, loreFragment: 0.15, upgradeDust: 0.75 } },
  },
  vortex: {
    id: 'vortex',
    label: 'Vortex',
    description:
      "Monte dans la tour d'Ascension : la réputation vaut plus, la poudre est réservée aux ascensions.",
    options: { reputationWeight: 0.05, weights: { loreDust: 0.005 } },
  },
  collectionneur: {
    id: 'collectionneur',
    label: 'Collectionneur',
    description: 'Les cartes jamais possédées passent avant les constellations.',
    options: { newCardBonus: 25 },
  },
  echangeur: {
    id: 'echangeur',
    label: 'Échangeur',
    description: 'Garde deux doublons de chaque carte pour les échanges.',
    options: { keepExtra: 2 },
  },
};

export const isStrategy = (value: unknown): value is StrategyId =>
  typeof value === 'string' && (STRATEGY_IDS as readonly string[]).includes(value);
