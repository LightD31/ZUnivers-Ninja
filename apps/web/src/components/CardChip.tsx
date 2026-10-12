import type { PlanCard } from '@zuninja/core';
import { useState } from 'react';
import { RARITY_TINT } from '../lib/game';
import { CardLightbox } from './CardLightbox';

const SHINY_RING = ['ring-white/10', 'ring-gold', 'ring-[#aaa5fa]'];
const SHINY_SUFFIX = ['', '+', '*'];

/** Vignette de carte : visuel, numéro et brillance. Un clic l'affiche en grand. */
export function CardThumb({ card }: { card: PlanCard }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative block w-14 shrink-0 cursor-zoom-in rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zu-500"
        title={`${card.name} (${card.identifier}${SHINY_SUFFIX[card.shiny]})`}
        aria-label={`Voir ${card.name} en grand`}
      >
        <span
          className={`block aspect-[5/7] overflow-hidden rounded bg-ink-700 ring-2 ${SHINY_RING[card.shiny]}`}
        >
          {card.image ? (
            <img
              src={card.image}
              alt=""
              loading="lazy"
              className="size-full object-cover transition group-hover:scale-105"
            />
          ) : (
            <span className="grid size-full place-items-center text-[10px] text-white/45">
              {card.identifier}
            </span>
          )}
        </span>
        {card.count > 1 && (
          <span className="absolute -top-1.5 -right-1.5 rounded bg-zu-500 px-1.5 text-[10px] leading-4 font-bold text-white">
            ×{card.count}
          </span>
        )}
        <span
          className={`mt-1 block truncate text-center font-mono text-[10px] ${RARITY_TINT[card.rarity] ?? ''}`}
        >
          {card.identifier}
          {SHINY_SUFFIX[card.shiny]}
        </span>
      </button>
      {open && <CardLightbox card={card} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Version compacte, pour les longues listes. Un clic affiche la carte en grand. */
export function CardChip({ card }: { card: PlanCard }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="chip cursor-zoom-in transition hover:bg-white/[0.12] focus-visible:outline-2 focus-visible:outline-zu-500"
        title={card.name}
        aria-label={`Voir ${card.name} en grand`}
      >
        <span className={`font-mono font-semibold ${RARITY_TINT[card.rarity] ?? ''}`}>
          {card.identifier}
          {SHINY_SUFFIX[card.shiny]}
        </span>
        <span className="max-w-36 truncate text-white/65">{card.name}</span>
        {card.count > 1 && <span className="font-semibold text-zu-400">×{card.count}</span>}
      </button>
      {open && <CardLightbox card={card} onClose={() => setOpen(false)} />}
    </>
  );
}
