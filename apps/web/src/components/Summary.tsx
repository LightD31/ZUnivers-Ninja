import { CURRENCY_LABEL, type Currency, type PlanResult, type Shiny } from '@zuninja/core';
import { Lightbulb, Mountain, Target, Trophy } from 'lucide-react';
import type { ReactNode } from 'react';
import { CURRENCY_DOT, SHINY_BAR, SHINY_NAME } from '../lib/game';
import { fmt, formatDate, signed } from '../lib/format';
import { Progress } from './Progress';

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card p-4">
      <h3 className="label mb-3 flex items-center gap-1.5">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

export function Summary({ plan }: { plan: PlanResult }) {
  const currencies = Object.keys(plan.before.balances) as Currency[];
  const unlocked = plan.achievements.filter((a) => a.after >= a.max);
  return (
    <div className="space-y-4">
      <Section title="Monnaies">
        <ul className="space-y-2 text-sm">
          {currencies.map((c) => {
            const before = plan.before.balances[c];
            const after = plan.after.balances[c];
            return (
              <li key={c} className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${CURRENCY_DOT[c]}`} />
                <span className="text-white/75">{CURRENCY_LABEL[c]}</span>
                <span className="ml-auto font-mono text-xs text-white/45 tabular-nums">
                  {fmt(before)}
                </span>
                <span className="text-white/30">→</span>
                <span className="w-16 text-right font-mono font-semibold tabular-nums">
                  {fmt(after)}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Collection">
        <div className="space-y-3 text-sm">
          {([0, 1, 2] as Shiny[]).map((s) => (
            <div key={s} className="space-y-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-white/75">{SHINY_NAME[s]}</span>
                {plan.after.unique[s] !== plan.before.unique[s] && (
                  <span
                    className={`text-xs font-semibold ${plan.after.unique[s] > plan.before.unique[s] ? 'text-zu-400' : 'text-danger'}`}
                  >
                    {signed(plan.after.unique[s] - plan.before.unique[s])}
                  </span>
                )}
                <span className="ml-auto font-mono text-xs tabular-nums">
                  {fmt(plan.after.unique[s])}{' '}
                  <span className="text-white/45">/ {fmt(plan.after.total[s])}</span>
                </span>
              </div>
              <Progress
                before={plan.before.unique[s]}
                after={plan.after.unique[s]}
                total={plan.after.total[s]}
                bar={SHINY_BAR[s]}
              />
            </div>
          ))}
          <div className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-white/75">Constellations</span>
              {plan.after.constellationLevels > plan.before.constellationLevels && (
                <span className="text-xs font-semibold text-zu-400">
                  {signed(plan.after.constellationLevels - plan.before.constellationLevels)}
                </span>
              )}
              <span className="ml-auto font-mono text-xs tabular-nums">
                {fmt(plan.after.constellationLevels)}{' '}
                <span className="text-white/45">/ {fmt(plan.after.constellationMax)}</span>
              </span>
            </div>
            <Progress
              before={plan.before.constellationLevels}
              after={plan.after.constellationLevels}
              total={plan.after.constellationMax}
              bar="bg-chroma"
            />
          </div>
          <p className="flex items-baseline justify-between border-t border-white/[0.08] pt-3">
            <span className="text-white/75">Points de collection</span>
            <span className="font-mono font-semibold tabular-nums">
              {fmt(plan.after.points)}
              {plan.gain.points !== 0 && (
                <span className="ml-1.5 text-xs text-zu-400">{signed(plan.gain.points)}</span>
              )}
            </span>
          </p>
        </div>
      </Section>

      {plan.challenges.length > 0 && (
        <Section title="Défis de la semaine" icon={<Target className="size-3.5" />}>
          <ul className="space-y-3 text-sm">
            {plan.challenges.map((c, i) => (
              <li key={i} className="space-y-1.5">
                <div className="flex items-baseline gap-2">
                  <span className={c.after >= c.max ? 'text-white/45 line-through' : ''}>
                    {c.description}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
                    {c.after}/{c.max}
                  </span>
                </div>
                <Progress before={c.before} after={c.after} total={c.max} bar="bg-zu-500" />
                <p className="text-xs text-white/60">
                  {c.score > 0 ? `+${fmt(c.score)} points · ` : ''}+{c.reward} poudre
                  {!c.plannable && c.after < c.max ? ' · à faire toi-même' : ''}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {unlocked.length > 0 && (
        <Section title="Succès débloqués" icon={<Trophy className="size-3.5" />}>
          <p className="mb-3 text-sm">
            Le plan rapporte{' '}
            <span className="font-semibold text-zu-400">{signed(plan.gain.achievements)}</span>{' '}
            points de succès.
          </p>
          <ul className="space-y-2 text-sm">
            {unlocked.map((a, i) => (
              <li key={i} className="flex items-start gap-2">
                <Trophy className="mt-0.5 size-3.5 shrink-0 text-gold" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-gold">{a.name}</span>
                  <span className="block text-xs text-white/60">
                    +{fmt(a.score)} points
                    {a.reward > 0 ? ` · +${fmt(a.reward)} poudre` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {plan.season && (
        <Section title="Vortex" icon={<Mountain className="size-3.5" />}>
          <p className="font-medium">{plan.season.name}</p>
          <p className="mt-1 text-sm text-white/60">
            {plan.season.summit ? (
              'Sommet atteint'
            ) : (
              <>
                Étage {plan.season.floor} · {plan.season.ascensionsLeft} essai
                {plan.season.ascensionsLeft > 1 ? 's' : ''} restant
                {plan.season.ascensionsLeft > 1 ? 's' : ''} après le plan
              </>
            )}{' '}
            · jusqu'au {formatDate(plan.season.end)}
          </p>
          <p className="mt-2 text-xs text-white/60">
            Forge ouverte aux cartes du groupe « {plan.season.group} ».
          </p>
          {plan.horizon && plan.horizon.seasons.length > 0 && (
            <div className="mt-3 border-t border-white/[0.08] pt-3">
              <p className="mb-1.5 text-xs text-white/60">Prochains Vortex (prévision)</p>
              <ul className="space-y-1 text-sm">
                {plan.horizon.seasons.map((s) => (
                  <li key={s.begin} className="flex items-baseline gap-2">
                    <span className="text-white/75">{s.group}</span>
                    {s.probability < 0.9 && (
                      <span className="text-xs text-white/45">{fmt(s.probability * 100)} %</span>
                    )}
                    <span className="ml-auto font-mono text-xs text-white/45 tabular-nums">
                      {formatDate(s.begin)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {plan.advice.length > 0 && (
        <Section title="Conseils" icon={<Lightbulb className="size-3.5" />}>
          <ul className="space-y-2 text-sm text-white/75">
            {plan.advice.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-zu-500" />
                {a}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
