// Assembles the release branch: what "Open in Cloud Shell" clones and runs.
// Built files only, nothing to install: setup uses Node's built-ins (SET-25).
// Usage (after npm run build): node scripts/publish-setup.mjs <outDir> <version> <sha256:digest> <security:true|false> [feed url]
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReleaseFiles } from './release-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const [out, version, digest, security, feedUrl] = process.argv.slice(2);
if (!out) throw new Error('Usage: node scripts/publish-setup.mjs <outDir> <version> <sha256:digest> <security> [feed url]');

mkdirSync(out, { recursive: true });
writeReleaseFiles({ dir: out, version, digest, security: security === 'true', feedUrl });
cpSync(join(root, 'setup.js'), join(out, 'setup.js'));
cpSync(join(root, 'README.md'), join(out, 'README.md'));
cpSync(join(root, 'dist', 'src'), join(out, 'dist', 'src'), { recursive: true });
// The files are ES modules: without this, Node reads setup.js as CommonJS and its first import fails.
writeFileSync(join(out, 'package.json'), `${JSON.stringify({ name: 'universal-mail-setup', version, private: true, type: 'module' }, null, 2)}\n`);
console.log(`published ${version} to ${out}`);
