import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newer } from '../src/page/duties.js';
import { OFFICIAL_IMAGE_REPOSITORY } from '../src/setup/gcloud.js';
import { writeReleaseFiles } from '../scripts/release-files.mjs';

// REL (added): what the release pipeline writes is exactly what setup and
// the server read: release.json (the image, pinned by digest) and the feed.
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const digest = `sha256:${'c0'.repeat(32)}`;

describe('the release files', () => {
  it('REL-01 release.json names the official image by its digest, as setup\'s image check requires (added)', () => {
    dir = mkdtempSync(join(tmpdir(), 'release-'));
    writeReleaseFiles({ dir, version: '2.1.0', digest, security: false, feedUrl: 'https://example.invalid/latest.json' });
    const release = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'));
    expect(release.image).toBe(`${OFFICIAL_IMAGE_REPOSITORY}@${digest}`);
    expect(release.image).toMatch(new RegExp(`^${OFFICIAL_IMAGE_REPOSITORY.replace(/[.]/g, '\\.')}@sha256:[0-9a-f]{64}$`));
    expect(release.version).toBe('2.1.0');
    expect(release.feed).toBe('https://example.invalid/latest.json');
  });

  it('REL-01 a tag or a malformed digest is refused: only an exact image is ever released', () => {
    dir = mkdtempSync(join(tmpdir(), 'release-'));
    for (const bad of ['latest', 'sha256:abc', `sha256:${'C0'.repeat(32)}`, `sha512:${'c0'.repeat(32)}`]) {
      expect(() => writeReleaseFiles({ dir: dir!, version: '2.1.0', digest: bad, security: false }), bad).toThrow(/digest/);
    }
    expect(() => writeReleaseFiles({ dir: dir!, version: 'v2.1', digest, security: false })).toThrow(/version/);
  });

  it('REL-02 the feed says the version and whether it is a security release, as the server reads it', () => {
    dir = mkdtempSync(join(tmpdir(), 'release-'));
    writeReleaseFiles({ dir, version: '2.1.0', digest, security: true });
    const feed = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
    expect(feed).toEqual({ version: '2.1.0', security: true });
    expect(newer(feed.version, '2.0.0')).toBe(true);
    expect(newer(feed.version, '2.1.0')).toBe(false);
    expect(newer('2.0.0', '2.0.0-dev')).toBe(true);
    expect(newer('2.0.0-dev', '2.0.0')).toBe(false);
    expect(newer('10.0.0', '9.9.9')).toBe(true);
  });
});

// REL-06 (added): one image store, named once. The one-time setup script
// creates it, the workflow pushes to it, setup trusts only it. If any of the
// three drifts, releases go somewhere setup refuses to install from.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
describe('the release plumbing agrees with itself', () => {
  it('REL-06 the store release-setup.sh creates is the one setup trusts and release.json names', async () => {
    const { REPOSITORY } = await import('../scripts/release-files.mjs');
    expect(REPOSITORY).toBe(OFFICIAL_IMAGE_REPOSITORY);
    const script = read('scripts/release-setup.sh');
    const project = /^PROJECT="\$\{PROJECT:-([^}]+)\}"$/m.exec(script)?.[1];
    const location = /^LOCATION=(\S+)$/m.exec(script)?.[1];
    expect(script).toContain('gcloud artifacts repositories create release ');
    expect(`${location}-docker.pkg.dev/${project}/release/server`).toBe(OFFICIAL_IMAGE_REPOSITORY);
    expect(JSON.parse(read('release.json')).image.startsWith(`${OFFICIAL_IMAGE_REPOSITORY}@sha256:`)).toBe(true);
  });

  it('REL-06 the workflow pushes to that store, publishes through publish-setup.mjs, and serves the feed from the release branch', () => {
    const workflow = read('.github/workflows/release.yml');
    // Read from release-files.mjs, never written out a second time.
    expect(workflow).not.toMatch(/docker\.pkg\.dev\/[^\s"]+\/release\/server/);
    expect(workflow).toContain("import('./scripts/release-files.mjs')");
    expect(workflow).toContain('node scripts/publish-setup.mjs publish ');
    expect(workflow).toContain('git push -f "https://x-access-token:${{ github.token }}@github.com/${{ github.repository }}.git" release');
    expect(workflow).not.toMatch(/pages/i);
    expect(read('scripts/release-setup.sh')).toContain('UPDATE_FEED_URL = https://raw.githubusercontent.com/${REPO}/release/latest.json');
  });
});
