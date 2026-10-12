import type { PlanCard } from '@zuninja/core';
import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { RARITY_LABEL, RARITY_TINT, zuniversCardUrl } from '../lib/game';

const SHINY_RING = ['ring-white/10', 'ring-gold', 'ring-[#aaa5fa]'];
const SHINY_SUFFIX = ['', '+', '*'];
const SHINY_LABEL = ['Normale', 'Dorée', 'Chroma'];

/**
 * Visuel d'une carte en grand, avec un lien vers sa fiche sur ZUnivers (nouvel onglet). Échap, la
 * croix ou un clic à côté la referment.
 */
export function CardLightbox({ card, onClose }: { card: PlanCard; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Pas de `close()` au démontage : retirer la fenêtre de la page la ferme déjà, et son événement
  // `close` refermait aussitôt la carte quand React (StrictMode) rejoue l'effet.
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  const url = zuniversCardUrl(card);

  return (
    <dialog
      ref={dialog}
      aria-label={card.name}
      onClose={onClose}
      // Un clic sur le fond (hors de la fiche) arrive sur le <dialog> lui-même.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="m-auto w-[min(22rem,calc(100vw-2rem))] overflow-visible bg-transparent p-0 text-white backdrop:bg-black/75 backdrop:backdrop-blur-[2px]"
    >
      <div className="animate-fade-up surface relative space-y-3 p-3">
        <button
          type="button"
          className="btn-ghost absolute top-1.5 right-1.5 z-10 bg-black/40 px-2"
          onClick={onClose}
          aria-label="Fermer"
        >
          <X className="size-5" />
        </button>
        <div
          className={`mx-auto aspect-[5/7] max-h-[68vh] overflow-hidden rounded bg-ink-700 ring-2 ${SHINY_RING[card.shiny]}`}
        >
          {card.image ? (
            <img src={card.image} alt={card.name} className="size-full object-cover" />
          ) : (
            <div className="grid size-full place-items-center font-mono text-white/45">
              {card.identifier}
            </div>
          )}
        </div>
        <div className="space-y-0.5 px-1">
          <p className="leading-tight font-semibold">{card.name}</p>
          <p className="text-xs text-white/60">
            <span className={`font-mono font-semibold ${RARITY_TINT[card.rarity] ?? ''}`}>
              {card.identifier}
              {SHINY_SUFFIX[card.shiny]}
            </span>
            {' · '}
            {RARITY_LABEL[card.rarity] ?? `${card.rarity} ★`}
            {' · '}
            <span
              className={card.shiny === 2 ? 'text-chroma' : card.shiny === 1 ? 'text-gold' : ''}
            >
              {SHINY_LABEL[card.shiny]}
            </span>
          </p>
        </div>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="btn-primary w-full">
            Voir sur ZUnivers
            <ExternalLink className="size-4" />
          </a>
        )}
      </div>
    </dialog>
  );
}
