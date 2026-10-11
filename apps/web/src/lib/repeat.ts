import type { Currency, PlanCard, StepGroup } from '@zuninja/core';

export interface RepeatedGroup {
  /** Commande fusionnée : gains, monnaies et cartes additionnés. */
  group: StepGroup;
  /** Nombre de fois que la commande est à taper d'affilée. */
  repeat: number;
  /** Position de la première commande dans le plan (à partir de 0). */
  first: number;
}

function merge(a: StepGroup, b: StepGroup): StepGroup {
  const cards = new Map<string, PlanCard>();
  for (const c of [...a.cards, ...b.cards]) {
    const key = `${c.itemId}:${c.shiny}`;
    const existing = cards.get(key);
    cards.set(key, existing ? { ...existing, count: existing.count + c.count } : c);
  }
  const balanceDelta = { ...a.balanceDelta };
  for (const [k, v] of Object.entries(b.balanceDelta) as [Currency, number][])
    balanceDelta[k] = (balanceDelta[k] ?? 0) + v;
  return {
    ...a,
    cards: [...cards.values()],
    gain: a.gain + b.gain,
    random: a.random || b.random,
    auto: a.auto && b.auto,
    balanceDelta,
    size: a.size + b.size,
  };
}

/** Regroupe les commandes identiques consécutives (une série de /im, par exemple). */
export function collapseRepeats(groups: StepGroup[]): RepeatedGroup[] {
  const out: RepeatedGroup[] = [];
  groups.forEach((group, index) => {
    const last = out.at(-1);
    if (last && last.group.kind === group.kind && last.group.command === group.command) {
      last.group = merge(last.group, group);
      last.repeat++;
    } else out.push({ group, repeat: 1, first: index });
  });
  return out;
}
