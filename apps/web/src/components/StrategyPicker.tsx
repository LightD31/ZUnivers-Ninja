import { STRATEGIES, STRATEGY_IDS } from '@zuninja/core';
import { Minus, Plus } from 'lucide-react';
import { isCustomized, withStrategy, type Settings } from '../lib/settings';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

/** Doublons gardés pour l'échange au plus. */
const KEEP_EXTRA_MAX = 5;

/**
 * Choix de la stratégie et des réglages de conservation, sous la recherche : un clic recalcule le
 * plan.
 */
export function StrategyPicker({ settings, onChange }: Props) {
  const current = STRATEGIES[settings.strategy];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Stratégie">
        <span className="mr-1 text-xs tracking-[0.06em] text-white/60 uppercase">Stratégie</span>
        {STRATEGY_IDS.map((id) => {
          const checked = settings.strategy === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={checked}
              title={STRATEGIES[id].description}
              onClick={() => onChange(withStrategy(settings, id))}
              className={`rounded border px-2.5 py-1 text-sm transition ${
                checked
                  ? 'border-zu-500 bg-zu-500/15 font-medium text-white'
                  : 'border-white/10 text-white/70 hover:border-white/25 hover:text-white'
              }`}
            >
              {STRATEGIES[id].label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-white/60">
        {current.description}
        {isCustomized(settings) && ' · réglages modifiés'}
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <div
          className="flex items-center gap-1.5"
          title="Exemplaires conservés en plus, jamais recyclés ni consommés."
        >
          <span className="text-white/70">Doublons gardés pour l'échange</span>
          <button
            type="button"
            aria-label="Garder un doublon de moins"
            disabled={settings.keepExtra <= 0}
            onClick={() => onChange({ ...settings, keepExtra: settings.keepExtra - 1 })}
            className="rounded border border-white/10 p-1 text-white/70 transition hover:border-white/25 hover:text-white disabled:opacity-40"
          >
            <Minus className="size-3.5" />
          </button>
          <span className="w-4 text-center font-mono text-xs" aria-live="polite">
            {settings.keepExtra}
          </span>
          <button
            type="button"
            aria-label="Garder un doublon de plus"
            disabled={settings.keepExtra >= KEEP_EXTRA_MAX}
            onClick={() => onChange({ ...settings, keepExtra: settings.keepExtra + 1 })}
            className="rounded border border-white/10 p-1 text-white/70 transition hover:border-white/25 hover:text-white disabled:opacity-40"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <label
          className="flex cursor-pointer items-center gap-2"
          title="Ne recycle pas les exemplaires normaux à enchanter pour monter la constellation dorée, même si elle n'est pas rentable aujourd'hui. Décoché, seul celui de la première dorée est gardé : plus de poudre tout de suite, mais des cartes à recréer plus tard."
        >
          <input
            type="checkbox"
            checked={settings.keepForGolden}
            onChange={(e) => onChange({ ...settings, keepForGolden: e.target.checked })}
            className="size-4 accent-zu-500"
          />
          <span className="text-white/70">Garder pour les constellations dorées</span>
        </label>
      </div>
    </div>
  );
}
