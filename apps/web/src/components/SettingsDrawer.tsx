import { CURRENCY_LABEL, STRATEGIES, STRATEGY_IDS, type Currency } from '@zuninja/core';
import { RotateCcw, X } from 'lucide-react';
import { useEffect } from 'react';
import { DEFAULT_SETTINGS, isCustomized, withStrategy, type Settings } from '../lib/settings';

interface Props {
  open: boolean;
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}

function Slider(props: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline justify-between text-sm font-medium">
        {props.label}
        <span className="font-mono text-xs text-white/60">{props.value}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full accent-zu-500"
      />
      <span className="block text-xs text-white/60">{props.hint}</span>
    </label>
  );
}

export function SettingsDrawer({ open, settings, onChange, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!open) return null;
  const setWeight = (c: Currency, v: number) =>
    onChange({ ...settings, weights: { ...settings.weights, [c]: v } });

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Réglages"
    >
      <button
        type="button"
        aria-label="Fermer"
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="animate-fade-up relative flex h-full w-full max-w-sm flex-col overflow-y-auto bg-ink-800 p-5 shadow-[-8px_0_24px_rgb(0_0_0/0.45)]">
        <div className="mb-5 flex items-center">
          <h2 className="text-lg font-bold tracking-wide uppercase">Réglages</h2>
          <button
            type="button"
            className="btn-ghost ml-auto px-2"
            onClick={onClose}
            aria-label="Fermer"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="space-y-6">
          <fieldset className="space-y-2">
            <legend className="mb-2 flex w-full items-baseline justify-between text-sm font-medium">
              Stratégie
              {isCustomized(settings) && (
                <span className="text-xs font-normal text-white/60">réglages modifiés</span>
              )}
            </legend>
            {STRATEGY_IDS.map((id) => {
              const strategy = STRATEGIES[id];
              const checked = settings.strategy === id;
              return (
                <label
                  key={id}
                  className={`flex cursor-pointer gap-3 rounded border px-3 py-2 transition ${
                    checked ? 'border-zu-500 bg-zu-500/10' : 'border-white/10 hover:border-white/25'
                  }`}
                >
                  <input
                    type="radio"
                    name="strategy"
                    value={id}
                    checked={checked}
                    onChange={() => onChange(withStrategy(settings, id))}
                    className="mt-1 accent-zu-500"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">{strategy.label}</span>
                    <span className="block text-xs text-white/60">{strategy.description}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <Slider
            label="Largeur du faisceau"
            hint="Nombre de plans explorés en parallèle. Plus c'est grand, meilleur (et plus lent) est le résultat. 1 = glouton."
            value={settings.beamWidth}
            min={1}
            max={64}
            onChange={(beamWidth) => onChange({ ...settings, beamWidth })}
          />
          <Slider
            label="Ramifications"
            hint="Actions candidates essayées depuis chaque état."
            value={settings.branching}
            min={1}
            max={16}
            onChange={(branching) => onChange({ ...settings, branching })}
          />
          <Slider
            label="Doublons gardés pour l'échange"
            hint="Exemplaires conservés en plus, jamais recyclés ni consommés."
            value={settings.keepExtra}
            min={0}
            max={5}
            onChange={(keepExtra) => onChange({ ...settings, keepExtra })}
          />
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Valeur des monnaies</legend>
            <p className="text-xs text-white/60">
              Points de collection attribués à chaque unité conservée. Une valeur haute pousse à
              économiser, une valeur basse à dépenser.
            </p>
            {(Object.keys(settings.weights) as Currency[]).map((c) => (
              <label key={c} className="flex items-center gap-3 text-sm">
                <span className="flex-1 text-white/75">{CURRENCY_LABEL[c]}</span>
                <input
                  type="number"
                  step="0.001"
                  min={0}
                  value={settings.weights[c]}
                  onChange={(e) => setWeight(c, Math.max(0, Number(e.target.value) || 0))}
                  className="field w-24 bg-ink-700 px-2 py-1 text-right font-mono text-xs"
                />
              </label>
            ))}
          </fieldset>
        </div>
        <button
          type="button"
          className="btn-ghost mt-auto self-start"
          onClick={() => onChange({ ...DEFAULT_SETTINGS, ruleSet: settings.ruleSet })}
        >
          <RotateCcw className="size-4" />
          Valeurs par défaut
        </button>
      </aside>
    </div>
  );
}
