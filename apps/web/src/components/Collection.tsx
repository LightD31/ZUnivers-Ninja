import type { PlanResult } from '@zuninja/core';
import { Hammer, Merge } from 'lucide-react';
import { CURRENCY_SHORT, RARITY_LABEL, RARITY_TINT } from '../lib/game';
import { fmt } from '../lib/format';
import { CardThumb } from './CardChip';

const SHINY_SUFFIX = ['', '+', '*'];

export function Collection({ plan }: { plan: PlanResult }) {
  const { fusions, missing } = plan.insights;
  return (
    <div className="space-y-4">
      <section className="card overflow-hidden">
        <header className="flex items-center gap-2 border-b border-white/[0.08] px-4 py-3">
          <Merge className="size-4 text-fuchsia-400" />
          <h2 className="font-bold tracking-wide uppercase">Fusions à compléter</h2>
          <span className="ml-auto text-xs text-white/60">{fusions.length}</span>
        </header>
        {fusions.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-white/60">
            Toutes les fusions sont faites. Bravo !
          </p>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {fusions.map((f) => {
              const done = f.inputs.filter((i) => i.have >= i.need).length;
              return (
                <li key={f.result.itemId} className="flex gap-4 px-4 py-3">
                  <CardThumb card={f.result} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="truncate font-medium">{f.result.name}</p>
                      <span className="ml-auto shrink-0 font-mono text-xs text-white/60">
                        {done}/{f.inputs.length} composants
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {f.inputs.map((i) => (
                        <span
                          key={i.card.itemId}
                          className={`chip ${i.have >= i.need ? 'bg-zu-500/15 ring-1 ring-zu-500/40' : ''}`}
                          title={`${i.have} possédé(s), ${i.need} nécessaire(s) en gardant un exemplaire`}
                        >
                          <span
                            className={`font-mono font-semibold ${RARITY_TINT[i.card.rarity] ?? ''}`}
                          >
                            {i.card.identifier}
                          </span>
                          <span className="max-w-32 truncate text-white/65">{i.card.name}</span>
                          <span
                            className={`font-mono ${i.have >= i.need ? 'text-zu-400' : 'text-danger'}`}
                          >
                            {i.have}/{i.need}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card overflow-hidden">
        <header className="flex items-center gap-2 border-b border-white/[0.08] px-4 py-3">
          <Hammer className="size-4 text-orange-400" />
          <h2 className="font-bold tracking-wide uppercase">
            Cartes manquantes les plus rentables
          </h2>
        </header>
        {missing.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-white/60">Collection complète !</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs tracking-wide text-white/60 uppercase">
                <tr>
                  <th className="px-4 py-2 font-medium">Carte</th>
                  <th className="px-2 py-2 font-medium">Rareté</th>
                  <th className="px-2 py-2 text-right font-medium">Points</th>
                  <th className="px-4 py-2 text-right font-medium">Forge</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {missing.map((m) => (
                  <tr key={`${m.card.itemId}:${m.card.shiny}`}>
                    <td className="px-4 py-2">
                      <span className="font-mono text-xs text-white/60">
                        {m.card.identifier}
                        {SHINY_SUFFIX[m.card.shiny]}
                      </span>{' '}
                      {m.card.name}
                      {m.card.shiny === 1 && (
                        <span className="ml-1.5 text-xs text-gold">dorée</span>
                      )}
                      {m.card.shiny === 2 && (
                        <span className="ml-1.5 text-chroma text-xs">chroma</span>
                      )}
                    </td>
                    <td className={`px-2 py-2 text-xs ${RARITY_TINT[m.card.rarity] ?? ''}`}>
                      {RARITY_LABEL[m.card.rarity] ?? m.card.rarity}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{fmt(m.points)}</td>
                    <td className="px-4 py-2 text-right text-xs whitespace-nowrap text-white/60">
                      {m.craftCost !== null && m.currency
                        ? `${fmt(m.craftCost)} ${CURRENCY_SHORT[m.currency]}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
