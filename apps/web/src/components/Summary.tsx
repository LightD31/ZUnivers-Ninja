import { CURRENCY_LABEL, type Currency, type PlanResult, type Shiny } from '@zuninja/core';
import { Lightbulb, Mountain, Target } from 'lucide-react';
import type { ReactNode } from 'react';
import { CURRENCY_DOT, SHINY_BAR, SHINY_NAME } from '../lib/game';
import { fmt, formatDate, pct, signed } from '../lib/format';

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

function Progress({
  before,
  after,
  total,
  bar,
}: {
  before: number;
  after: number;
  total: number;
  bar: string;
}) {
  return (
    <div className="relative h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-ink-800">
      <div
        className={`absolute inset-y-0 left-0 rounded-full opacity-35 ${bar}`}
        style={{ width: `${pct(after, total)}%` }}
      />
      <div
        className={`absolute inset-y-0 left-0 rounded-full ${bar}`}
        style={{ width: `${pct(before, total)}%` }}
      />
    </div>
  );
}

export function Summary({ plan }: { plan: PlanResult }) {
  const currencies = Object.keys(plan.before.balances) as Currency[];
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
                <span className="text-zinc-600 dark:text-zinc-300">{CURRENCY_LABEL[c]}</span>
                <span className="ml-auto font-mono text-xs text-zinc-400 tabular-nums">
                  {fmt(before)}
                </span>
                <span className="text-zinc-300 dark:text-ink-600">→</span>
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
                <span className="text-zinc-600 dark:text-zinc-300">{SHINY_NAME[s]}</span>
                {plan.after.unique[s] !== plan.before.unique[s] && (
                  <span
                    className={`text-xs font-semibold ${plan.after.unique[s] > plan.before.unique[s] ? 'text-emerald-500' : 'text-accent-500'}`}
                  >
                    {signed(plan.after.unique[s] - plan.before.unique[s])}
                  </span>
                )}
                <span className="ml-auto font-mono text-xs tabular-nums">
                  {fmt(plan.after.unique[s])}{' '}
                  <span className="text-zinc-400">/ {fmt(plan.after.total[s])}</span>
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
              <span className="text-zinc-600 dark:text-zinc-300">Constellations</span>
              {plan.after.constellationLevels > plan.before.constellationLevels && (
                <span className="text-xs font-semibold text-emerald-500">
                  {signed(plan.after.constellationLevels - plan.before.constellationLevels)}
                </span>
              )}
              <span className="ml-auto font-mono text-xs tabular-nums">
                {fmt(plan.after.constellationLevels)}{' '}
                <span className="text-zinc-400">/ {fmt(plan.after.constellationMax)}</span>
              </span>
            </div>
            <Progress
              before={plan.before.constellationLevels}
              after={plan.after.constellationLevels}
              total={plan.after.constellationMax}
              bar="bg-violet-500"
            />
          </div>
          <p className="flex items-baseline justify-between border-t border-zinc-100 pt-3 dark:border-ink-800">
            <span className="text-zinc-600 dark:text-zinc-300">Points de collection</span>
            <span className="font-mono font-semibold tabular-nums">
              {fmt(plan.after.points)}
              {plan.gain.points !== 0 && (
                <span className="ml-1.5 text-xs text-emerald-500">{signed(plan.gain.points)}</span>
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
                  <span className={c.after >= c.max ? 'text-zinc-400 line-through' : ''}>
                    {c.description}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
                    {c.after}/{c.max}
                  </span>
                </div>
                <Progress before={c.before} after={c.after} total={c.max} bar="bg-emerald-500" />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  +{c.reward} poudre{!c.plannable && c.after < c.max ? ' · à faire toi-même' : ''}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {plan.season && (
        <Section title="Vortex" icon={<Mountain className="size-3.5" />}>
          <p className="font-medium">{plan.season.name}</p>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Étage {plan.season.floor} · {plan.season.ascensionsLeft} essai
            {plan.season.ascensionsLeft > 1 ? 's' : ''} restant
            {plan.season.ascensionsLeft > 1 ? 's' : ''} après le plan · jusqu'au{' '}
            {formatDate(plan.season.end)}
          </p>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Forge ouverte aux cartes du groupe « {plan.season.group} ».
          </p>
        </Section>
      )}

      {plan.advice.length > 0 && (
        <Section title="Conseils" icon={<Lightbulb className="size-3.5" />}>
          <ul className="space-y-2 text-sm text-zinc-600 dark:text-zinc-300">
            {plan.advice.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-accent-500" />
                {a}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
