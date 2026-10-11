import { describe, expect, it } from 'vitest';
import type { StepGroup } from '@zuninja/core';
import { collapseRepeats } from '../src/lib/repeat';

const group = (command: string, overrides: Partial<StepGroup> = {}): StepGroup => ({
  kind: 'invoke',
  command,
  title: command,
  detail: null,
  cards: [],
  gain: 10,
  random: true,
  auto: false,
  balanceDelta: { balance: -1000 },
  size: 1,
  ...overrides,
});

describe('collapseRepeats', () => {
  it('fusionne les commandes identiques consécutives seulement', () => {
    const rows = collapseRepeats([
      group('/im'),
      group('/im'),
      group('/im', { gain: 5 }),
      group('/im évènement:chroma', { balanceDelta: { balance: -2000 } }),
      group('/im'),
    ]);
    expect(rows.map((r) => [r.group.command, r.repeat, r.first])).toEqual([
      ['/im', 3, 0],
      ['/im évènement:chroma', 1, 3],
      ['/im', 1, 4],
    ]);
    expect(rows[0]!.group.gain).toBe(25);
    expect(rows[0]!.group.balanceDelta).toEqual({ balance: -3000 });
    expect(rows[0]!.group.size).toBe(3);
  });

  it('additionne les cartes d’une même série', () => {
    const card = { itemId: 'a', identifier: 1001, name: 'A', rarity: 1, image: null } as const;
    const [row] = collapseRepeats([
      group('/fusion carte:1001', { kind: 'fusion', cards: [{ ...card, shiny: 0, count: 1 }] }),
      group('/fusion carte:1001', { kind: 'fusion', cards: [{ ...card, shiny: 0, count: 2 }] }),
    ]);
    expect(row!.repeat).toBe(2);
    expect(row!.group.cards).toEqual([{ ...card, shiny: 0, count: 3 }]);
  });
});
