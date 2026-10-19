import { pct } from '../lib/format';

/** Barre de progression : avant le plan (pleine) et après (estompée). */
export function Progress({
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
    <div className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.12]">
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
