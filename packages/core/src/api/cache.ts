export interface ApiCacheOptions {
  /** Durée pendant laquelle une réponse est réutilisée. */
  ttlMs: number;
  /**
   * Âge minimal d'une réponse pour qu'une demande `fresh` la recharge : évite de relancer tous
   * les appels à chaque clic sur « Actualiser ».
   */
  freshMinMs?: number;
  /** Nombre de réponses gardées, les plus anciennes sont oubliées d'abord. */
  maxSize?: number;
  now?: () => number;
}

/**
 * Réponses récentes de l'API ZUnivers, pour ne pas la solliciter plus que nécessaire. Un appel
 * en cours est partagé par toutes les demandes identiques ; un appel échoué est oublié.
 */
export class ApiCache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; at: number }>();
  private readonly ttlMs: number;
  private readonly freshMinMs: number;
  private readonly maxSize: number;
  private readonly now: () => number;

  constructor(options: ApiCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.freshMinMs = options.freshMinMs ?? 0;
    this.maxSize = options.maxSize ?? 200;
    this.now = options.now ?? Date.now;
  }

  get(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.at < (fresh ? this.freshMinMs : this.ttlMs)) {
      return entry.value;
    }
    const value = load();
    const created = { value, at: this.now() };
    // Réinsérée en dernier : l'ordre de la Map reste celui des chargements.
    this.entries.delete(key);
    this.entries.set(key, created);
    value.catch(() => {
      if (this.entries.get(key) === created) this.entries.delete(key);
    });
    if (this.entries.size > this.maxSize) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
}
