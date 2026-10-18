import { SlidersHorizontal } from 'lucide-react';
import { useId } from 'react';

interface Props {
  onOpenSettings: () => void;
  onHome: () => void;
}

export function Logo({ className = 'size-8' }: { className?: string }) {
  // Identifiant sûr dans un url(#…) SVG, unique par instance.
  const id = `logo${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#eed371" />
          <stop offset="0.35" stopColor="#f8b3ff" />
          <stop offset="0.7" stopColor="#aaa5fa" />
          <stop offset="1" stopColor="#aed8e6" />
        </linearGradient>
      </defs>
      <path
        d="M32 4 39 25 60 32 39 39 32 60 25 39 4 32 25 25Z"
        fill={`url(#${id})`}
        className="drop-shadow-[0_0_6px_rgb(248_179_255/0.45)]"
      />
      <circle cx="32" cy="32" r="5.5" className="fill-ink-950" />
    </svg>
  );
}

const NAV_ITEM =
  'relative inline-flex h-9 items-center px-2.5 text-[11.5px] tracking-[0.06em] uppercase transition sm:px-4';

export function Header({ onOpenSettings, onHome }: Props) {
  return (
    <header className="sticky top-0 z-30 bg-linear-to-b from-ink-950 via-ink-950/85 to-transparent px-3 pt-3 pb-2 sm:px-9 sm:pt-6">
      <div className="zu-appbar mx-auto grid h-16 max-w-[1400px] grid-cols-[1fr_auto_1fr] items-center rounded-md px-2 shadow-[0_8px_24px_rgb(0_0_0/0.45)] sm:px-6">
        {/* Colonne vide : garde le logo centré. */}
        <div />

        <button
          type="button"
          onClick={onHome}
          className="flex items-center gap-2.5 rounded focus-visible:outline-2 focus-visible:outline-zu-500"
          aria-label="ZUnivers Ninja, accueil"
        >
          <Logo className="size-10" />
          <span className="hidden text-sm font-bold tracking-[0.08em] whitespace-nowrap uppercase md:inline">
            ZUnivers <span className="text-chroma">Ninja</span>
          </span>
        </button>

        <div className="flex justify-end">
          <button
            type="button"
            className={`${NAV_ITEM} gap-2 rounded text-white/85 hover:bg-white/[0.08] hover:text-white`}
            onClick={onOpenSettings}
            aria-label="Réglages du planificateur"
            title="Réglages"
          >
            <SlidersHorizontal className="size-[18px]" />
            <span className="hidden sm:inline">Réglages</span>
          </button>
        </div>
      </div>
    </header>
  );
}
