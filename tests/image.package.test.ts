import { execFileSync } from 'node:child_process';
import { pdfOf } from '../testkit/src/attachments.js';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// REL-03 (added): the server image the release ships, built from the
// Dockerfile and started the way Cloud Run starts it: the two saved records
// as environment variables, PORT set, no shell, not as root.
const root = fileURLToPath(new URL('..', import.meta.url));
const TAG = 'universal-mail-test:local';
const docker = (...args: string[]) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000 }).trim();
const started: string[] = [];

beforeAll(() => { docker('build', '--build-arg', 'UPDATE_FEED_URL=https://updates.example.invalid/latest.json', '-t', TAG, '.'); }, 900_000);
afterAll(() => { for (const id of started) try { docker('rm', '-f', id); } catch { /* already gone */ } });

function records() {
  const state = {
    version: 1, key: 'image-test-key-0123456789ab', signInAddress: 'me@example.invalid',
    accounts: [{ name: 'me', email: 'me@example.invalid', imap: { host: 'imap.example.invalid', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.example.invalid', port: 587, tls: 'starttls' }, sentCopyMode: 'yahoo' }],
    grants: {}, fingerprints: []
  };
  const credentials = {
    passwords: { me: 'image-test-app-password' },
    signingKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
    encryptionKey: randomBytes(32).toString('base64url')
  };
  return { UNIVERSAL_MAIL_STATE: JSON.stringify(state), UNIVERSAL_MAIL_CREDENTIALS: JSON.stringify(credentials) };
}

async function run(env: Record<string, string>) {
  const id = docker('run', '-d', '-p', '127.0.0.1::8080', '-e', 'PORT=8080', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), TAG);
  started.push(id);
  const port = docker('port', id, '8080/tcp').split(':').at(-1)!;
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/health`); return { id, base }; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error(`the container never answered: ${docker('logs', id)}`);
}

describe('the server image', () => {
  it('REL-03 before Google gives it an address: healthy and waiting, not crashed (added)', async () => {
    const { id, base } = await run(records());
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'starting' });
    expect(docker('logs', id)).toContain('"event":"waiting_for_address"');
  }, 120_000);

  it('REL-03 with its address: it serves sign-in discovery as itself, and runs as an ordinary user', async () => {
    const { id, base } = await run({ ...records(), PUBLIC_URL: 'https://universal-mail-test-uc.a.run.app' });
    const discovery = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(discovery.issuer).toBe('https://universal-mail-test-uc.a.run.app');
    expect(docker('exec', id, 'id', '-u')).not.toBe('0');
    expect(docker('exec', id, 'printenv', 'UPDATE_FEED_URL')).toBe('https://updates.example.invalid/latest.json');
  }, 120_000);

  it('ACT-06 asked to stop (as Cloud Run does, with SIGTERM), it saves what is waiting and exits cleanly at once, not killed at the deadline (added: activity log)', async () => {
    const { id } = await run({ ...records(), PUBLIC_URL: 'https://universal-mail-test-uc.a.run.app' });
    const started = Date.now();
    docker('stop', '--time', '8', id);
    expect(docker('inspect', '-f', '{{.State.ExitCode}}', id)).toBe('0');
    expect(Date.now() - started).toBeLessThan(6000);
  }, 120_000);

  it('ATT-10 in the built image, the sandbox reads a PDF attachment: the reader and its libraries ship with it (added: reading attachments)', async () => {
    const { id } = await run(records());
    const pdf = pdfOf('Invoice total 42.00 EUR').toString('base64');
    const raw = ['Subject: x', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'hi', '--b',
      'Content-Type: application/pdf; name="i.pdf"', 'Content-Disposition: attachment; filename="i.pdf"', 'Content-Transfer-Encoding: base64', '', pdf, '--b--', ''].join('\r\n');
    const script = `import('/app/dist/src/safeParse.js').then(async m => { const p = m.createSafeParser(); const r = await p.attachment(Buffer.from(process.argv[1], 'base64'), 0); console.log(JSON.stringify(r)); await p.close(); })`;
    const out = docker('exec', id, 'node', '-e', script, Buffer.from(raw).toString('base64'));
    expect(JSON.parse(out)).toMatchObject({ filename: 'i.pdf', kind: 'text', text: expect.stringContaining('Invoice total 42.00 EUR') });
  }, 120_000);

  it('REL-03 damaged settings: unhealthy, with the setting named in its log, never a value', async () => {
    const env = records();
    const { id, base } = await run({ ...env, UNIVERSAL_MAIL_STATE: '{not json', PUBLIC_URL: 'https://universal-mail-test-uc.a.run.app' });
    expect((await fetch(`${base}/health`)).status).toBe(503);
    const logs = docker('logs', id);
    expect(logs).toContain('"setting":"UNIVERSAL_MAIL_STATE"');
    expect(logs).not.toContain('image-test-app-password');
  }, 120_000);
});
