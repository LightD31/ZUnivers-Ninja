import {
  CURRENCY_LABEL,
  HORIZON_EVENT_DAYS_MAX,
  HORIZON_SEASONS_MAX,
  type Currency,
} from '@zuninja/core';
import { RotateCcw, X } from 'lucide-react';
import { useEffect } from 'react';
import { DEFAULT_SETTINGS, withStrategy, type Settings } from '../lib/settings';

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
  step?: number;
  /** Valeur affichée, si elle diffère de celle du curseur (pourcentage, unité…). */
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline justify-between text-sm font-medium">
        {props.label}
        <span className="font-mono text-xs text-white/60">
          {props.format ? props.format(props.value) : props.value}
        </span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
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
          <fieldset className="space-y-4">
            <legend className="text-sm font-medium">Anticipation</legend>
            <p className="text-xs text-white/60">
              S'appliquent quand « Anticiper » est cochée sous la recherche : le plan garde les
              monnaies qui rapporteront plus au prochain Vortex ou à un évènement annoncé.
            </p>
            <Slider
              label="Valeur de l'avenir"
              hint="Ce que vaut un gain une saison de Vortex plus tard, face au même gain aujourd'hui. Plus c'est haut, plus le plan attend ; 100 % fait entièrement confiance aux prévisions."
              // Curseur en pour cent, valeur gardée entre 0 et 1.
              value={Math.round(settings.horizonDiscount * 100)}
              min={50}
              max={100}
              step={5}
              format={(v) => `${v} %`}
              onChange={(v) => onChange({ ...settings, horizonDiscount: v / 100 })}
            />
            <Slider
              label="Saisons examinées"
              hint="Prochains Vortex pris en compte. 4 couvre une rotation complète des groupes ; 1 n'attend que le prochain Vortex."
              value={settings.horizonSeasons}
              min={1}
              max={HORIZON_SEASONS_MAX}
              onChange={(horizonSeasons) => onChange({ ...settings, horizonSeasons })}
            />
            <Slider
              label="Évènements annoncés"
              hint="Jours à l'avance où un évènement annoncé peut faire garder de la ZUMonnaie. 0 : aucun."
              value={settings.horizonEventDays}
              min={0}
              max={HORIZON_EVENT_DAYS_MAX}
              step={7}
              format={(v) => `${v} j`}
              onChange={(horizonEventDays) => onChange({ ...settings, horizonEventDays })}
            />
          </fieldset>
        </div>
        <button
          type="button"
          className="btn-ghost mt-auto self-start"
          // La stratégie se choisit sous la recherche : on revient à ses valeurs, sans la changer.
          onClick={() =>
            onChange(
              withStrategy({ ...DEFAULT_SETTINGS, ruleSet: settings.ruleSet }, settings.strategy),
            )
          }
        >
          <RotateCcw className="size-4" />
          Valeurs par défaut
        </button>
      </aside>
    </div>
  );
}
