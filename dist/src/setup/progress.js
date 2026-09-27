import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function createProgressStore(home) {
    const dir = join(home, '.universal-mail');
    const file = join(dir, 'progress.json');
    return {
        load() {
            try {
                return JSON.parse(readFileSync(file, 'utf8'));
            }
            catch {
                return undefined;
            }
        },
        save(progress) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(file, JSON.stringify(progress, null, 2));
        }
    };
}
//# sourceMappingURL=progress.js.map