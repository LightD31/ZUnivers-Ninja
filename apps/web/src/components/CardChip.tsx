import type { PlanCard } from '@zuninja/core';
import { RARITY_TINT } from '../lib/game';

const SHINY_RING = ['ring-zinc-200 dark:ring-ink-700', 'ring-amber-400', 'ring-violet-500'];
const SHINY_SUFFIX = ['', '+', '*'];

/** Vignette de carte : visuel, numéro et brillance. */
export function CardThumb({ card }: { card: PlanCard }) {
  return (
    <figure
      className="group relative w-14 shrink-0"
      title={`${card.name} (${card.identifier}${SHINY_SUFFIX[card.shiny]})`}
    >
      <div
        className={`aspect-[5/7] overflow-hidden rounded-md bg-zinc-100 ring-2 dark:bg-ink-800 ${SHINY_RING[card.shiny]}`}
      >
        {card.image ? (
          <img
            src={card.image}
            alt={card.name}
            loading="lazy"
            className="size-full object-cover transition group-hover:scale-105"
          />
        ) : (
          <div className="grid size-full place-items-center text-[10px] text-zinc-400">
            {card.identifier}
          </div>
        )}
      </div>
      {card.count > 1 && (
        <span className="absolute -top-1.5 -right-1.5 rounded-full bg-accent-500 px-1.5 text-[10px] leading-4 font-bold text-white">
          ×{card.count}
        </span>
      )}
      <figcaption
        className={`mt-1 truncate text-center font-mono text-[10px] ${RARITY_TINT[card.rarity] ?? ''}`}
      >
        {card.identifier}
        {SHINY_SUFFIX[card.shiny]}
      </figcaption>
    </figure>
  );
}

/** Version compacte, pour les longues listes. */
export function CardChip({ card }: { card: PlanCard }) {
  return (
    <span className="chip" title={card.name}>
      <span className={`font-mono font-semibold ${RARITY_TINT[card.rarity] ?? ''}`}>
        {card.identifier}
        {SHINY_SUFFIX[card.shiny]}
      </span>
      <span className="max-w-36 truncate text-zinc-600 dark:text-zinc-400">{card.name}</span>
      {card.count > 1 && <span className="font-semibold text-accent-500">×{card.count}</span>}
    </span>
  );
}
