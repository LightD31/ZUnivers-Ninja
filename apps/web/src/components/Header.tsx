import type { RuleSet } from '@zuninja/core';
import { Moon, SlidersHorizontal, Sun } from 'lucide-react';

interface Props {
  ruleSet: RuleSet;
  onRuleSet: (r: RuleSet) => void;
  dark: boolean;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onHome: () => void;
}

export function Logo({ className = 'size-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="14" className="fill-ink-900 dark:fill-ink-800" />
      <path d="M32 8 38 26 56 32 38 38 32 56 26 38 8 32 26 26Z" className="fill-accent-500" />
      <circle cx="32" cy="32" r="5" className="fill-ink-900 dark:fill-ink-800" />
    </svg>
  );
}

export function Header({ ruleSet, onRuleSet, dark, onToggleTheme, onOpenSettings, onHome }: Props) {
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200/80 bg-zinc-50/80 backdrop-blur-md dark:border-ink-800 dark:bg-ink-950/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <button
          type="button"
          onClick={onHome}
          className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-accent-500"
        >
          <Logo />
          <span className="hidden text-[15px] font-bold tracking-tight whitespace-nowrap min-[420px]:inline">
            ZUnivers <span className="text-accent-500">Ninja</span>
          </span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <div
            role="radiogroup"
            aria-label="Mode de jeu"
            className="mr-1 flex rounded-xl border border-zinc-200 p-0.5 text-xs font-semibold dark:border-ink-700"
          >
            {(['NORMAL', 'HARDCORE'] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={ruleSet === r}
                onClick={() => onRuleSet(r)}
                className={`rounded-[10px] px-2.5 py-1 transition ${
                  ruleSet === r
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {r === 'NORMAL' ? 'Normal' : 'Hardcore'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost px-2"
            onClick={onOpenSettings}
            aria-label="Réglages du planificateur"
            title="Réglages"
          >
            <SlidersHorizontal className="size-[18px]" />
          </button>
          <button
            type="button"
            className="btn-ghost px-2"
            onClick={onToggleTheme}
            aria-label="Changer de thème"
            title="Thème"
          >
            {dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
          </button>
        </div>
      </div>
    </header>
  );
}
