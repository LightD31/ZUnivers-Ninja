import { STRATEGIES, STRATEGY_IDS } from '@zuninja/core';
import { isCustomized, withStrategy, type Settings } from '../lib/settings';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

/** Choix de la stratégie, sous la recherche : un clic recalcule le plan. */
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
    </div>
  );
}
