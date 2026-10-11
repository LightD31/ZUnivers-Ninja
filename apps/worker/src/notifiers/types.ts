import type { PlanResult } from '@zuninja/core';

export interface Notifier {
  name: string;
  notify(plan: PlanResult): Promise<void>;
}
