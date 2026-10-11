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
  daily: 'text-emerald-500 bg-emerald-500/10',
  weekly: 'text-emerald-500 bg-emerald-500/10',
  recycle: 'text-sky-500 bg-sky-500/10',
  craft: 'text-orange-500 bg-orange-500/10',
  enchant: 'text-amber-500 bg-amber-500/10',
  fusion: 'text-fuchsia-500 bg-fuchsia-500/10',
  constellation: 'text-violet-500 bg-violet-500/10',
  invoke: 'text-accent-500 bg-accent-500/10',
  ascension: 'text-teal-500 bg-teal-500/10',
  evolution: 'text-lime-600 bg-lime-500/10',
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
  1: 'text-zinc-500',
  2: 'text-emerald-500',
  3: 'text-sky-500',
  4: 'text-violet-500',
  5: 'text-amber-500',
  6: 'text-pink-500',
};

export const SHINY_NAME: Record<Shiny, string> = { 0: 'Normales', 1: 'Dorées', 2: 'Chromas' };
export const SHINY_BAR: Record<Shiny, string> = {
  0: 'bg-zinc-400 dark:bg-zinc-500',
  1: 'bg-amber-400',
  2: 'bg-gradient-to-r from-pink-400 via-violet-500 to-sky-400',
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
