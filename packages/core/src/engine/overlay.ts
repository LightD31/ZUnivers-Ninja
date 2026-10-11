/**
 * Map persistante légère : chaque `fork()` crée une couche qui ne stocke que ses modifications.
 * Permet au planificateur de cloner des états en O(1) au lieu de copier tout l'inventaire.
 * Les chaînes trop longues sont aplaties pour garder des lectures rapides.
 */
export class OverlayMap<K, V> {
  private readonly own = new Map<K, V>();
  private readonly parent: OverlayMap<K, V> | null;
  private readonly depth: number;

  private constructor(parent: OverlayMap<K, V> | null, depth: number) {
    this.parent = parent;
    this.depth = depth;
  }

  static from<K, V>(entries: Iterable<readonly [K, V]>): OverlayMap<K, V> {
    const map = new OverlayMap<K, V>(null, 0);
    for (const [k, v] of entries) map.own.set(k, v);
    return map;
  }

  get(key: K): V | undefined {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let layer: OverlayMap<K, V> | null = this;
    while (layer) {
      if (layer.own.has(key)) return layer.own.get(key);
      layer = layer.parent;
    }
    return undefined;
  }

  /** À n'appeler que sur une couche fraîchement créée par `fork()`. */
  set(key: K, value: V): void {
    this.own.set(key, value);
  }

  fork(): OverlayMap<K, V> {
    if (this.depth >= 24) {
      const flat = new OverlayMap<K, V>(null, 0);
      for (const [k, v] of this.entries()) flat.own.set(k, v);
      return new OverlayMap(flat, 1);
    }
    return new OverlayMap(this, this.depth + 1);
  }

  entries(): Map<K, V> {
    const layers: OverlayMap<K, V>[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let layer: OverlayMap<K, V> | null = this;
    while (layer) {
      layers.push(layer);
      layer = layer.parent;
    }
    const result = new Map<K, V>();
    for (let i = layers.length - 1; i >= 0; i--)
      for (const [k, v] of layers[i]!.own) result.set(k, v);
    return result;
  }
}
