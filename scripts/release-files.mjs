// The files a release publishes, written by the release pipeline
// (.github/workflows/release.yml) once the server image is pushed and signed:
//   release.json  what setup installs: the image, pinned by its digest
//   latest.json   the update feed the server reads (src/page/duties.ts)
// Usage: node scripts/release-files.mjs <dir> <version> <sha256:digest> <security:true|false> [feed url]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must match OFFICIAL_IMAGE_REPOSITORY in src/setup/gcloud.ts (REL-01 checks it).
const REPOSITORY = 'us-docker.pkg.dev/universal-mail/release/server';

export function writeReleaseFiles({ dir, version, digest, security, feedUrl }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`Not a release version: ${version}`);
  // Only an exact image is ever released: a digest, never a tag.
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('The image must be named by its sha256 digest');
  const release = { version, image: `${REPOSITORY}@${digest}`, ...(feedUrl ? { feed: feedUrl } : {}) };
  writeFileSync(join(dir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify({ version, security: security === true })}\n`);
  return release;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, version, digest, security, feedUrl] = process.argv.slice(2);
  const release = writeReleaseFiles({ dir, version, digest, security: security === 'true', feedUrl });
  console.log(JSON.stringify(release));
}
