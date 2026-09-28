import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFirestoreStore } from '../../src/licenseService/store.js';

// SUB-12 (design §13.3): the service's records in Firestore, through its REST
// API as the service's own identity (the metadata server gives it a token),
// the way the server saves its secrets. One document per record, its JSON
// in one field, so nothing here depends on Firestore's typed values.
type Seen = { method: string; path: string; headers: IncomingMessage['headers']; body: string };
let server: Server | undefined;
afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined; });

async function fakeGoogle(options: { refuse?: number } = {}) {
  const seen: Seen[] = [];
  const docs = new Map<string, string>();
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url === '/computeMetadata/v1/project/project-id') { res.end('universal-mail-rel-zqrw'); return; }
      if (req.url === '/computeMetadata/v1/instance/service-accounts/default/token') { json(200, { access_token: 'token-from-metadata', expires_in: 3599 }); return; }
      const doc = /^\/v1\/(projects\/universal-mail-rel-zqrw\/databases\/\(default\)\/documents\/([^/?]+)\/([^/?]+))(\?.*)?$/.exec(req.url ?? '');
      if (!doc) { json(404, { error: { message: 'no such route' } }); return; }
      if (options.refuse) { json(options.refuse, { error: { message: 'Permission denied, in words that must not travel' } }); return; }
      const name = doc[1]!;
      if (req.method === 'GET') {
        const stored = docs.get(name);
        if (!stored) { json(404, { error: { code: 404, message: 'Document not found', status: 'NOT_FOUND' } }); return; }
        json(200, { name, fields: { json: { stringValue: stored } } });
        return;
      }
      if (req.method === 'PATCH') {
        docs.set(name, JSON.parse(body).fields.json.stringValue);
        json(200, { name, fields: JSON.parse(body).fields });
        return;
      }
      json(405, {});
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { seen, base, docs };
}

describe('the Firestore store', () => {
  it('SUB-12 put writes one document with the record as JSON; get reads it back; a missing one is undefined', async () => {
    const g = await fakeGoogle();
    const store = createFirestoreStore({ metadata: g.base, api: g.base });
    expect(await store.get('licenses', 'UM-AAAA-BBBB-CCCC')).toBeUndefined();
    await store.put('licenses', 'UM-AAAA-BBBB-CCCC', { code: 'UM-AAAA-BBBB-CCCC', installs: ['a'], paidThrough: '2026-11-01T00:00:00.000Z' });
    expect(await store.get('licenses', 'UM-AAAA-BBBB-CCCC')).toEqual({ code: 'UM-AAAA-BBBB-CCCC', installs: ['a'], paidThrough: '2026-11-01T00:00:00.000Z' });
    const write = g.seen.find(s => s.method === 'PATCH')!;
    expect(write.path).toBe('/v1/projects/universal-mail-rel-zqrw/databases/(default)/documents/licenses/UM-AAAA-BBBB-CCCC');
    expect(write.headers.authorization).toBe('Bearer token-from-metadata');
    expect(g.seen.filter(s => s.path.startsWith('/computeMetadata')).every(s => s.headers['metadata-flavor'] === 'Google')).toBe(true);
    // The project is asked for once.
    expect(g.seen.filter(s => s.path.endsWith('project-id'))).toHaveLength(1);
  });

  it('SUB-12 ids are used as given, so a slash or a query in one can\'t reach another document', async () => {
    const g = await fakeGoogle();
    const store = createFirestoreStore({ metadata: g.base, api: g.base });
    await store.put('installs', 'a/b?c', { code: 'x' });
    expect(g.seen.find(s => s.method === 'PATCH')!.path).toBe('/v1/projects/universal-mail-rel-zqrw/databases/(default)/documents/installs/a%2Fb%3Fc');
    expect(await store.get('installs', 'a/b?c')).toEqual({ code: 'x' });
  });

  it('SUB-12 a refusal carries Google\'s status, never its words', async () => {
    const g = await fakeGoogle({ refuse: 403 });
    const store = createFirestoreStore({ metadata: g.base, api: g.base });
    const error = await store.get('licenses', 'x').then(() => undefined, (e: unknown) => e) as { status?: number; message: string };
    expect(error.status).toBe(403);
    expect(error.message).not.toContain('Permission denied');
    const failed = await store.put('licenses', 'x', {}).then(() => undefined, (e: unknown) => e) as { status?: number };
    expect(failed.status).toBe(403);
  });

  it('SUB-12 a Google that never answers is given up on within the time limit', async () => {
    const held: Array<{ destroy(): void }> = [];
    server = createServer((req) => { held.push(req.socket); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const store = createFirestoreStore({ metadata: base, api: base, timeoutMs: 500 });
    const started = Date.now();
    await expect(store.get('licenses', 'x')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    for (const socket of held) socket.destroy();
  });
});
