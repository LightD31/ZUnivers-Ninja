import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './logger';

export interface UserState {
  /** Empreinte du dernier plan notifié. */
  hash: string | null;
  notifiedAt: string | null;
  checkedAt: string | null;
  lastError: string | null;
}

interface StoreData {
  version: 1;
  users: Record<string, UserState>;
  lastTick: string | null;
}

/** Petit état persistant (fichier JSON écrit de façon atomique). */
export class StateStore {
  private data: StoreData = { version: 1, users: {}, lastTick: null };
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoreData;
      if (parsed.version === 1) this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn(`État illisible (${file}), on repart de zéro`, error);
    }
  }

  user(name: string): UserState {
    return (
      this.data.users[name.toLowerCase()] ?? {
        hash: null,
        notifiedAt: null,
        checkedAt: null,
        lastError: null,
      }
    );
  }

  update(name: string, patch: Partial<UserState>) {
    this.data.users[name.toLowerCase()] = { ...this.user(name), ...patch };
  }

  get lastTick() {
    return this.data.lastTick;
  }

  set lastTick(value: string | null) {
    this.data.lastTick = value;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
