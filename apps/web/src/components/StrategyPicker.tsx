import { OPTIONAL_ACTIONS, STRATEGIES, STRATEGY_IDS, type OptionalAction } from '@zuninja/core';
import { Minus, Plus } from 'lucide-react';
import { KIND_ICON } from '../lib/game';
import { isCustomized, withStrategy, type Settings } from '../lib/settings';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

/** Doublons gardés pour l'échange au plus. */
const KEEP_EXTRA_MAX = 5;

const ACTION_LABEL: Record<OptionalAction, string> = {
  recycle: 'Recyclage',
  craft: 'Création',
  enchant: 'Enchantement',
  fusion: 'Fusion',
  constellation: 'Constellation',
  invoke: 'Invocation',
  ascension: 'Ascension',
  evolution: 'Évolution',
};

const LABEL = 'mr-1 w-20 shrink-0 text-xs tracking-[0.06em] text-white/60 uppercase';

const choice = (checked: boolean) =>
  `rounded border px-2.5 py-1 text-sm transition ${
    checked
      ? 'border-zu-500 bg-zu-500/15 font-medium text-white'
      : 'border-white/10 text-white/70 hover:border-white/25 hover:text-white'
  }`;

/**
 * Choix du mode de jeu, de la stratégie, des actions voulues et des réglages de conservation, sous
 * la recherche : un clic recalcule le plan.
 */
export function StrategyPicker({ settings, onChange }: Props) {
  const current = STRATEGIES[settings.strategy];
  const toggle = (action: OptionalAction) =>
    onChange({
      ...settings,
      skip: settings.skip.includes(action)
        ? settings.skip.filter((a) => a !== action)
        : [...settings.skip, action],
    });
  // Sans recyclage, rien n'est recyclé : garder les normales à enchanter ne change plus rien.
  const recycles = !settings.skip.includes('recycle');
  return (
    <div className="space-y-2">
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="radiogroup"
        aria-label="Mode de jeu"
      >
        <span className={LABEL}>Mode</span>
        {(['NORMAL', 'HARDCORE'] as const).map((ruleSet) => (
          <button
            key={ruleSet}
            type="button"
            role="radio"
            aria-checked={settings.ruleSet === ruleSet}
            onClick={() => onChange({ ...settings, ruleSet })}
            className={choice(settings.ruleSet === ruleSet)}
          >
            {ruleSet === 'NORMAL' ? 'Normal' : 'Hardcore'}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Stratégie">
        <span className={LABEL}>Stratégie</span>
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
              className={choice(checked)}
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
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Actions">
        <span className={LABEL}>Actions</span>
        {OPTIONAL_ACTIONS.map((action) => {
          const allowed = !settings.skip.includes(action);
          const Icon = KIND_ICON[action];
          return (
            <button
              key={action}
              type="button"
              aria-pressed={allowed}
              title={
                allowed
                  ? 'Cliquer pour ne plus proposer cette action'
                  : 'Cliquer pour proposer à nouveau cette action'
              }
              onClick={() => toggle(action)}
              className={`${choice(allowed)} inline-flex items-center gap-1.5 ${allowed ? '' : 'line-through'}`}
            >
              <Icon className="size-3.5" />
              {ACTION_LABEL[action]}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-white/60">
        {settings.skip.length === 0
          ? 'Décoche les actions que tu ne veux pas faire : le plan est calculé sans elles.'
          : `Plan calculé sans ${settings.skip
              .map((a) => ACTION_LABEL[a].toLowerCase())
              .join(', ')}${recycles ? '' : ', avec la poudre et les cristaux que tu as déjà'}.`}
      </p>
      <div className="flex flex-wrap items-start gap-x-5 gap-y-2 text-sm">
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
          className={`flex items-start gap-2 ${recycles ? 'cursor-pointer' : 'opacity-40'}`}
          title="Décoché, seules les normales que le plan du jour enchante sont gardées : plus de poudre tout de suite, mais des cartes à recréer les jours suivants pour les enchanter."
        >
          <input
            type="checkbox"
            checked={settings.keepForGolden}
            disabled={!recycles}
            onChange={(e) => onChange({ ...settings, keepForGolden: e.target.checked })}
            className="mt-0.5 size-4 shrink-0 accent-zu-500"
          />
          <span>
            <span className="block text-white/70">Garder les normales à enchanter</span>
            <span className="block text-xs text-white/50">
              pour les constellations et fusions dorées, au lieu de les recycler
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
