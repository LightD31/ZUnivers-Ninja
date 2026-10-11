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
      'Aucun tirage : ni invocation ni ascension, seulement des points garantis. La ZUMonnaie est gardée.',
    // Les tirages ne comptent pas : simplement réduire leur espérance ne changeait presque aucun
    // plan réel, la poudre allant déjà d'abord aux dépenses garanties.
    options: { evFactor: 0 },
  },
  epargne: {
    id: 'epargne',
    label: 'Épargne',
    description:
      'Garde des monnaies pour un évènement ou un nouveau pack : ne dépense que pour les actions très rentables.',
    // Poids par défaut × 15, et × 50 pour la ZUMonnaie : sinon les invocations, dont les doublons
    // se recyclent en poudre, convertissaient la ZUMonnaie en poudre au lieu de la garder.
    options: { weights: { balance: 0.1, loreDust: 0.15, loreFragment: 0.15, upgradeDust: 0.75 } },
  },
  vortex: {
    id: 'vortex',
    label: 'Vortex',
    description:
      "Monte dans la tour d'Ascension : la poudre va aux ascensions avant les petites créations.",
    // Réputation × 50, poudre × 5. Simulé sur des joueurs réels : × 5 fait ~90 % des ascensions
    // qu'Équilibré laisse de côté pour quelques points ; × 10 les fait toutes mais garde des
    // dizaines de milliers de poudres.
    options: { reputationWeight: 0.05, weights: { loreDust: 0.05 } },
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
