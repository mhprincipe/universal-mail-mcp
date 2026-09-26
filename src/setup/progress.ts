import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Where setup got to, kept in Cloud Shell's home folder so a closed tab can
// pick up where it stopped (design §4.3). Never a password or a key.
export type Progress = {
  step: number;
  accounts?: Array<{ address: string; name: string; providerId: string; providerName: string; safeMove: boolean }>;
  signIn?: string;
  project?: string;
  key?: string;
  sent?: Record<string, 'yahoo' | 'append'>;
  trialReminder?: boolean;
  // Converting a version 1 deployment (design §10): its project is used, not a new one.
  fromV1?: boolean;
  // When the settings were first saved (the free-trial reminder counts from here).
  installedAt?: string;
};

export type ProgressStore = { load(): Progress | undefined; save(progress: Progress): void };

export function createProgressStore(home: string): ProgressStore {
  const dir = join(home, '.universal-mail');
  const file = join(dir, 'progress.json');
  return {
    load() {
      try { return JSON.parse(readFileSync(file, 'utf8')) as Progress; } catch { return undefined; }
    },
    save(progress) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(progress, null, 2));
    }
  };
}
