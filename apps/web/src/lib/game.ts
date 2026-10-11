import type { ActionKind, Currency, Shiny } from '@zuninja/core';
import {
  CalendarCheck,
  Dices,
  Gift,
  Hammer,
  Merge,
  Mountain,
  Recycle,
  Sparkles,
  Star,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';

export const KIND_ICON: Record<ActionKind, LucideIcon> = {
  daily: Gift,
  weekly: CalendarCheck,
  recycle: Recycle,
  craft: Hammer,
  enchant: Sparkles,
  fusion: Merge,
  constellation: Star,
  invoke: Dices,
  ascension: Mountain,
  evolution: TrendingUp,
};

export const KIND_TINT: Record<ActionKind, string> = {
  daily: 'text-zu-400 bg-zu-500/15',
  weekly: 'text-zu-400 bg-zu-500/15',
  recycle: 'text-sky-400 bg-sky-400/12',
  craft: 'text-orange-400 bg-orange-400/12',
  enchant: 'text-gold bg-gold/12',
  fusion: 'text-fuchsia-400 bg-fuchsia-400/12',
  constellation: 'text-violet-400 bg-violet-400/12',
  invoke: 'text-pink-400 bg-pink-400/12',
  ascension: 'text-teal-300 bg-teal-300/12',
  evolution: 'text-lime-400 bg-lime-400/12',
};

export const RARITY_LABEL: Record<number, string> = {
  1: '★',
  2: '★★',
  3: '★★★',
  4: '★★★★',
  5: '★★★★★',
  6: 'STAR',
};

export const RARITY_TINT: Record<number, string> = {
  1: 'text-rarity-1',
  2: 'text-rarity-2',
  3: 'text-rarity-3',
  4: 'text-rarity-4',
  5: 'text-rarity-5',
  6: 'text-rarity-6',
};

export const SHINY_NAME: Record<Shiny, string> = { 0: 'Normales', 1: 'Dorées', 2: 'Chromas' };
export const SHINY_BAR: Record<Shiny, string> = {
  0: 'bg-zu-500',
  1: 'bg-gold',
  2: 'bg-chroma',
};

export const CURRENCY_SHORT: Record<Currency, string> = {
  balance: 'ZUMonnaie',
  loreDust: 'Poudre',
  loreFragment: 'Cristaux',
  upgradeDust: 'Éclats',
};

export const CURRENCY_DOT: Record<Currency, string> = {
  balance: 'bg-yellow-400',
  loreDust: 'bg-sky-400',
  loreFragment: 'bg-fuchsia-400',
  upgradeDust: 'bg-violet-400',
};
