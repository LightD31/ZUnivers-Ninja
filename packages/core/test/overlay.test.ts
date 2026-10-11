import { describe, expect, it } from 'vitest';
import { OverlayMap } from '../src/engine/overlay';

describe('OverlayMap', () => {
  it('lit à travers les couches et garde le parent intact', () => {
    const root = OverlayMap.from([
      ['a', 1],
      ['b', 2],
    ]);
    const child = root.fork();
    child.set('a', 10);
    expect(child.get('a')).toBe(10);
    expect(child.get('b')).toBe(2);
    expect(root.get('a')).toBe(1);
    expect(child.get('z')).toBeUndefined();
  });

  it('aplatit les longues chaînes sans perdre de valeur', () => {
    let map = OverlayMap.from<string, number>([['a', 0]]);
    for (let i = 1; i <= 60; i++) {
      map = map.fork();
      map.set(`k${i}`, i);
    }
    expect(map.get('a')).toBe(0);
    expect(map.get('k1')).toBe(1);
    expect(map.get('k60')).toBe(60);
    expect(map.entries().size).toBe(61);
  });

  it('partage la même empreinte tant qu’aucune couche ne change (cache des invocations)', () => {
    const root = OverlayMap.from([['a', 1]]);
    const empty = root.fork().fork();
    expect(empty.snapshot()).toEqual(root.snapshot());

    const changed = empty.fork();
    changed.set('a', 2);
    expect(changed.snapshot()).not.toEqual(root.snapshot());
    expect(changed.fork().snapshot()).toEqual(changed.snapshot());
  });

  it('change d’empreinte à chaque écriture dans la même couche', () => {
    const layer = OverlayMap.from([['a', 1]]).fork();
    layer.set('a', 2);
    const before = layer.snapshot();
    layer.set('a', 3);
    expect(layer.snapshot().layer).toBe(before.layer);
    expect(layer.snapshot().writes).not.toBe(before.writes);
  });
});
