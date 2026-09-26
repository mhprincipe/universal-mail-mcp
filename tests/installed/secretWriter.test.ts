import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretWriter } from '../../src/secretWriter.js';

// INS-06 (added): the server saves universal-mail-state through Secret
// Manager's REST API, as its own Google identity (the Cloud Run metadata
// server gives it a token). Only the newest two versions are kept, so saving
// never costs anything: Google's free tier covers six.
type Seen = { method: string; path: string; headers: IncomingMessage['headers']; body: string };
let server: Server | undefined;
afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined; });

async function fakeGoogle(options: { versions?: number[]; addStatus?: number } = {}) {
  const seen: Seen[] = [];
  let versions = [...(options.versions ?? [1])];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url === '/computeMetadata/v1/project/project-id') { res.end('universal-mail-4f2a'); return; }
      if (req.url === '/computeMetadata/v1/instance/service-accounts/default/token') { json(200, { access_token: 'token-from-metadata', expires_in: 3599, token_type: 'Bearer' }); return; }
      const base = '/v1/projects/universal-mail-4f2a/secrets/universal-mail-state';
      if (req.url === `${base}:addVersion` && req.method === 'POST') {
        if (options.addStatus) { json(options.addStatus, { error: { message: 'Permission denied on secret, which quotes nothing useful' } }); return; }
        const next = Math.max(0, ...versions) + 1;
        versions.push(next);
        json(200, { name: `projects/123/secrets/universal-mail-state/versions/${next}`, state: 'ENABLED' });
        return;
      }
      if (req.url?.startsWith(`${base}/versions?`) && req.method === 'GET') {
        json(200, { versions: [...versions].reverse().map(v => ({ name: `projects/123/secrets/universal-mail-state/versions/${v}`, state: 'ENABLED' })) });
        return;
      }
      const destroy = new RegExp(`^${base}/versions/(\\d+):destroy$`).exec(req.url ?? '');
      if (destroy && req.method === 'POST') { versions = versions.filter(v => v !== Number(destroy[1])); json(200, { state: 'DESTROYED' }); return; }
      json(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { seen, base, versions: () => versions };
}

describe('saving the state', () => {
  it('INS-06 a save adds a version, as the server\'s own identity, with the whole state as its data (added)', async () => {
    const g = await fakeGoogle();
    const save = createSecretWriter({ secret: 'universal-mail-state', metadata: g.base, api: g.base });
    await save('{"version":1,"grants":{}}');
    const metadata = g.seen.filter(s => s.path.startsWith('/computeMetadata'));
    expect(metadata.every(s => s.headers['metadata-flavor'] === 'Google')).toBe(true);
    const add = g.seen.find(s => s.path.endsWith(':addVersion'))!;
    expect(add.headers.authorization).toBe('Bearer token-from-metadata');
    expect(Buffer.from(JSON.parse(add.body).payload.data, 'base64').toString('utf8')).toBe('{"version":1,"grants":{}}');
    expect(g.versions()).toEqual([1, 2]);
  });

  it('INS-06 only the newest two versions are kept, so saving stays in Google\'s free tier', async () => {
    const g = await fakeGoogle({ versions: [1, 2, 3, 4] });
    const save = createSecretWriter({ secret: 'universal-mail-state', metadata: g.base, api: g.base });
    await save('{}');
    expect(g.versions()).toEqual([4, 5]);
    await save('{}');
    expect(g.versions()).toEqual([5, 6]);
    // The project is asked for once.
    expect(g.seen.filter(s => s.path.endsWith('project-id'))).toHaveLength(1);
  });

  it('INS-06 a refusal carries Google\'s status, never its words; nothing is destroyed', async () => {
    const g = await fakeGoogle({ versions: [1, 2, 3], addStatus: 403 });
    const save = createSecretWriter({ secret: 'universal-mail-state', metadata: g.base, api: g.base });
    const error = await save('{}').then(() => undefined, (e: unknown) => e) as { status?: number; message: string };
    expect(error.status).toBe(403);
    expect(error.message).not.toContain('Permission denied');
    expect(g.versions()).toEqual([1, 2, 3]);
  });

  it('INS-06 a Google that accepts but never answers: given up on within the time limit', async () => {
    const held: Array<{ destroy(): void }> = [];
    server = createServer((req) => { held.push(req.socket); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const save = createSecretWriter({ secret: 'universal-mail-state', metadata: base, api: base, timeoutMs: 500 });
    const started = Date.now();
    await expect(save('{}')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    for (const socket of held) socket.destroy();
  });

  it('INS-06 no metadata server (not on Cloud Run): a plain failure, not a hang', async () => {
    const save = createSecretWriter({ secret: 'universal-mail-state', metadata: 'http://127.0.0.1:1', api: 'http://127.0.0.1:1', timeoutMs: 2_000 });
    const started = Date.now();
    await expect(save('{}')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
