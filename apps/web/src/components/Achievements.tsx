import type { PlanResult } from '@zuninja/core';
import { Trophy } from 'lucide-react';
import { fmt, signed } from '../lib/format';
import { Progress } from './Progress';

/** Onglet Succès : ceux que le plan fait progresser, puis les plus proches d'être obtenus. */
export function Achievements({ plan }: { plan: PlanResult }) {
  const unlocked = plan.achievements.filter((a) => a.after >= a.max);
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center gap-2 border-b border-white/[0.08] px-4 py-3">
        <Trophy className="size-4 text-gold" />
        <h2 className="font-bold tracking-wide uppercase">Succès</h2>
        <span className="ml-auto text-xs text-white/60">{plan.achievements.length}</span>
      </header>
      {plan.achievements.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-white/60">
          Aucun succès en cours que le planificateur sait faire progresser.
        </p>
      ) : (
        <>
          {unlocked.length > 0 && (
            <p className="border-b border-white/[0.08] px-4 py-3 text-sm">
              Le plan débloque{' '}
              {unlocked.map((a, i) => (
                <span key={i}>
                  {i > 0 && (i === unlocked.length - 1 ? ' et ' : ', ')}
                  <span className="font-semibold text-gold">{a.name}</span>
                </span>
              ))}{' '}
              : <span className="font-semibold text-zu-400">{signed(plan.gain.achievements)}</span>{' '}
              points de succès.
            </p>
          )}
          <ul className="divide-y divide-white/[0.06]">
            {plan.achievements.map((a, i) => (
              <li key={i} className="space-y-1.5 px-4 py-3 text-sm">
                <div className="flex items-baseline gap-2">
                  <span className={a.after >= a.max ? 'font-medium text-gold' : 'font-medium'}>
                    {a.after >= a.max && <Trophy className="mr-1 inline size-3.5 align-[-2px]" />}
                    {a.name}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
                    {a.after}/{a.max}
                  </span>
                </div>
                <p className="text-xs text-white/60">{a.description}</p>
                <Progress before={a.before} after={a.after} total={a.max} bar="bg-gold" />
                <p className="text-xs text-white/60">
                  {a.after >= a.max ? 'Débloqué par le plan · ' : ''}+{fmt(a.score)} points
                  {a.reward > 0 ? ` · +${fmt(a.reward)} poudre` : ''}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
