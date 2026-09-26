#!/usr/bin/env node
// Universal Mail setup. In Google Cloud Shell, type:  node setup.js
// This launcher only finds the release's pinned server image and starts the
// built setup (dist/src/setup/main.js); everything else is in src/setup.
import { existsSync, readFileSync } from 'node:fs';

const release = JSON.parse(readFileSync(new URL('./release.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);

if (args[0] === '--which-image') {
  process.stdout.write(`${release.image}\n`);
} else if (!existsSync(new URL('./dist/src/setup/main.js', import.meta.url))) {
  process.stdout.write('  This copy of Universal Mail has not been built yet.\n  Type  npm ci && npm run build  and then  node setup.js  again.\n');
  process.exitCode = 1;
} else {
  const { main } = await import('./dist/src/setup/main.js');
  process.exitCode = await main(args, { env: process.env, stdin: process.stdin, stdout: process.stdout, image: release.image });
}
