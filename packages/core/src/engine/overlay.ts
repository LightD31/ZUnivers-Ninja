/**
 * Map persistante légère : chaque `fork()` crée une couche qui ne stocke que ses modifications.
 * Permet au planificateur de cloner des états en O(1) au lieu de copier tout l'inventaire.
 * Les chaînes trop longues sont aplaties pour garder des lectures rapides.
 */
export class OverlayMap<K, V> {
  private readonly own = new Map<K, V>();
  /** Nombre d'écritures dans cette couche, pour invalider ce qui a été calculé avant. */
  private writes = 0;
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
      // Une seule recherche par couche : les valeurs stockées ne sont jamais `undefined`.
      const value = layer.own.get(key);
      if (value !== undefined) return value;
      layer = layer.parent;
    }
    return undefined;
  }

  /**
   * Identité du contenu : la couche la plus proche qui a des modifications, et son nombre
   * d'écritures. Deux maps qui renvoient la même `snapshot()` ont les mêmes entrées, ce qui permet
   * de mettre en cache des calculs coûteux le long des couches vides (une invocation ne touche
   * aucune carte).
   */
  snapshot(): { layer: object; writes: number } {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let layer: OverlayMap<K, V> = this;
    while (layer.own.size === 0 && layer.parent) layer = layer.parent;
    return { layer, writes: layer.writes };
  }

  /**
   * Modifications de la couche de `snapshot()`, et la map sans elles (`null` pour la première
   * couche) : un calcul sur toutes les entrées peut repartir de celui de `base`, déjà en cache, en
   * ne revoyant que les entrées modifiées.
   */
  diff(): { changes: ReadonlyMap<K, V>; base: OverlayMap<K, V> | null } {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let layer: OverlayMap<K, V> = this;
    while (layer.own.size === 0 && layer.parent) layer = layer.parent;
    return { changes: layer.own, base: layer.parent };
  }

  /** À n'appeler que sur une couche fraîchement créée par `fork()`. */
  set(key: K, value: V): void {
    this.own.set(key, value);
    this.writes++;
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
