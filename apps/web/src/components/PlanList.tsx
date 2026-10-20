import {
  reserveLabel,
  type Currency,
  type PlanReserve,
  type PlanResult,
  type StepGroup,
} from '@zuninja/core';
import { CalendarX, ChevronRight, CircleCheck, Hourglass, Trophy } from 'lucide-react';
import { CURRENCY_DOT, CURRENCY_SHORT, KIND_ICON, KIND_TINT } from '../lib/game';
import { fmt, signed, signed1 } from '../lib/format';
import { collapseRepeats } from '../lib/repeat';
import { CardChip, CardThumb } from './CardChip';
import { CopyButton } from './CopyButton';

const MAX_THUMBS = 8;
const MAX_CHIPS = 18;

function Deltas({ delta }: { delta: StepGroup['balanceDelta'] }) {
  const entries = (Object.entries(delta) as [Currency, number][]).filter(([, v]) => v !== 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-white/60">
      {entries.map(([c, v]) => (
        <span key={c} className="inline-flex items-center gap-1.5 tabular-nums">
          <span className={`size-1.5 rounded-full ${CURRENCY_DOT[c]}`} />
          <span className={v > 0 ? 'text-zu-400' : ''}>{signed(v)}</span> {CURRENCY_SHORT[c]}
        </span>
      ))}
    </div>
  );
}

function Cards({ group }: { group: StepGroup }) {
  if (group.cards.length === 0) return null;
  if (group.cards.length <= MAX_THUMBS) {
    return (
      <div className="flex flex-wrap gap-2.5 pt-1">
        {group.cards.map((c) => (
          <CardThumb key={`${c.itemId}:${c.shiny}`} card={c} />
        ))}
      </div>
    );
  }
  const rest = group.cards.length - MAX_CHIPS;
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {group.cards.slice(0, MAX_CHIPS).map((c) => (
        <CardChip key={`${c.itemId}:${c.shiny}`} card={c} />
      ))}
      {rest > 0 && <span className="chip text-white/60">+{rest} autres</span>}
    </div>
  );
}

function GainBadge({ group }: { group: StepGroup }) {
  if (Math.abs(group.gain) < 0.05) return null;
  return (
    <span
      className={`shrink-0 rounded px-2 py-0.5 text-xs font-semibold tabular-nums ${
        group.random || group.gain < 0 ? 'bg-white/[0.08] text-white/75' : 'bg-zu-500 text-white'
      }`}
      title={
        group.random
          ? 'Gain espéré : le résultat dépend du tirage'
          : 'Gain de valeur (points de collection + monnaies)'
      }
    >
      {group.random ? '≈ ' : ''}
      {signed1(group.gain)}
    </span>
  );
}

/**
 * Commandes prévues pour une période à venir : simulées avec la collection d'aujourd'hui, à
 * titre indicatif (le plan sera recalculé quand la période arrivera).
 */
function Preview({ reserve }: { reserve: PlanReserve }) {
  if (reserve.preview.length === 0) return null;
  return (
    <div className="mt-2 ml-5 space-y-2 border-l border-white/[0.12] pl-3">
      <p className="text-xs text-white/60">
        Prévision faite avec ta collection d'aujourd'hui : à refaire quand{' '}
        {reserve.kind === 'vortex' ? 'le Vortex ouvrira' : 'les essais seront crédités'}.
      </p>
      <ol className="space-y-2">
        {collapseRepeats(reserve.preview).map(({ group, repeat, first }) => (
          <li key={first} className="space-y-1">
            <p className="text-xs font-medium text-white/80">
              {group.title}
              {repeat > 1 && <span className="ml-1.5 font-mono text-zu-400">×{repeat}</span>}
            </p>
            <code className="block overflow-x-auto font-mono text-xs whitespace-nowrap text-white/70 [scrollbar-width:thin]">
              {group.command}
            </code>
            {group.cards.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {group.cards.slice(0, MAX_CHIPS).map((c) => (
                  <CardChip key={`${c.itemId}:${c.shiny}`} card={c} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Monnaies que le plan garde pour plus tard (option « Anticiper ») : en tête du plan, pour
 * comprendre tout de suite pourquoi il ne dépense pas tout.
 */
function Reserves({ plan, className }: { plan: PlanResult; className: string }) {
  const reserves = plan.horizon?.reserves ?? [];
  if (reserves.length === 0) return null;
  return (
    <div className={`space-y-2 border-white/[0.08] bg-gold/[0.04] px-4 py-3 ${className}`}>
      <p className="label flex items-center gap-1.5 text-gold">
        <Hourglass className="size-3.5" />À garder pour plus tard
      </p>
      <ul className="space-y-1.5 text-sm">
        {reserves.map((r, i) => (
          <li key={i}>
            <details className="group">
              <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 gap-y-0.5 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 shrink-0 self-center text-white/45 transition group-open:rotate-90" />
                <span className="inline-flex items-center gap-1.5 font-semibold tabular-nums">
                  <span className={`size-1.5 rounded-full ${CURRENCY_DOT[r.currency]}`} />
                  {fmt(r.amount)} {CURRENCY_SHORT[r.currency]}
                </span>
                <span className="text-white/75">{reserveLabel(r)}</span>
                <span className="text-xs text-zu-400 tabular-nums">~{signed(r.value)} pts</span>
                <span className="text-xs text-white/45 underline-offset-2 group-hover:underline">
                  voir le plan prévu
                </span>
              </summary>
              <Preview reserve={r} />
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PlanList({ plan }: { plan: PlanResult }) {
  if (plan.closed) {
    return (
      <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
        <CalendarX className="size-10 text-white/50" />
        <p className="text-lg font-semibold uppercase">Pas de saison Hardcore en cours</p>
        <p className="max-w-md text-sm text-white/60">
          La dernière saison Hardcore est terminée : rien à jouer en attendant la prochaine. Repasse
          en mode Normal pour ton plan du jour.
        </p>
      </div>
    );
  }

  if (plan.groups.length === 0) {
    // Plan vide parce qu'il garde des monnaies pour plus tard : le dire, plutôt que « rien à faire ».
    const waiting = (plan.horizon?.reserves.length ?? 0) > 0;
    return (
      <div className="card overflow-hidden">
        <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
          <CircleCheck className="size-10 text-zu-500" />
          <p className="text-lg font-semibold uppercase">
            {waiting ? "Rien à dépenser aujourd'hui" : 'Rien à faire pour le moment'}
          </p>
          <p className="max-w-md text-sm text-white/60">
            {waiting
              ? 'Tes monnaies rapporteront plus tard : ton plan les garde pour la suite.'
              : 'Aucune action ne fait progresser ta collection avec tes ressources actuelles. Reviens après ton prochain /journa !'}
          </p>
        </div>
        <Reserves plan={plan} className="border-t" />
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-3">
        <div>
          <h2 className="font-bold tracking-wide uppercase">Plan d'action</h2>
          <p className="text-xs text-white/60">
            {plan.groups.length} commande{plan.groups.length > 1 ? 's' : ''} à taper dans l'ordre
            sur le Discord de ZeratoR
          </p>
        </div>
        <CopyButton text={plan.commands.join('\n')} label="Tout copier" className="ml-auto" />
      </div>
      <Reserves plan={plan} className="border-b" />
      <ol className="divide-y divide-white/[0.06]">
        {collapseRepeats(plan.groups).map(({ group, repeat, first }, index) => {
          const Icon = KIND_ICON[group.kind];
          return (
            <li
              key={first}
              className="animate-fade-up flex gap-3 px-4 py-3.5"
              style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }}
            >
              <div className="flex flex-col items-center gap-1">
                <span className={`grid size-9 place-items-center rounded ${KIND_TINT[group.kind]}`}>
                  <Icon className="size-[18px]" />
                </span>
                <span className="font-mono text-[10px] text-white/45">{first + 1}</span>
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium leading-tight">
                      {group.title}
                      {repeat > 1 && (
                        <span
                          className="ml-2 inline-block rounded bg-zu-500/15 px-2 py-0.5 align-[1px] text-xs font-semibold text-zu-400 tabular-nums"
                          title={`À taper ${repeat} fois d'affilée`}
                        >
                          <span className="font-mono">×</span>
                          {repeat}
                        </span>
                      )}
                    </p>
                    {group.detail && <p className="mt-0.5 text-xs text-white/60">{group.detail}</p>}
                    {group.achievements.length > 0 && (
                      <p className="mt-1 flex items-start gap-1.5 text-xs font-medium text-gold">
                        <Trophy className="mt-px size-3.5 shrink-0" />
                        <span>Succès débloqué : {group.achievements.join(', ')}</span>
                      </p>
                    )}
                  </div>
                  <GainBadge group={group} />
                </div>
                <div className="surface flex items-center gap-1 border-l-2 border-zu-500 pl-3">
                  <code className="min-w-0 flex-1 overflow-x-auto py-1.5 font-mono text-[13px] whitespace-nowrap text-white/90 [scrollbar-width:thin]">
                    {group.command}
                  </code>
                  <CopyButton text={group.command} />
                </div>
                <Cards group={group} />
                <Deltas delta={group.balanceDelta} />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
