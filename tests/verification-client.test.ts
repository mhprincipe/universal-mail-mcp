import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { probeStatus, callReadTool, safeFailure } from '../scripts/verification-client.js';
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.close(() => r()); s.closeAllConnections(); }))); });
it('transmits the actual adversarial Host instead of letting fetch discard it', async () => {
  const server = createServer((req, res) => { res.statusCode = req.headers.host === 'untrusted.invalid' ? 403 : 405; res.end(); });
  servers.push(server); server.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const address = server.address() as { port: number };
  expect(await probeStatus(`http://127.0.0.1:${address.port}/mcp`, { Host: 'untrusted.invalid' })).toBe(403);
});
it('passes the extended timeout through the installed MCP v2 client', async () => {
  const client = new Client({ name: 'timeout-regression', version: '1' });
  const seen: number[] = [];
  client.request = (async (request: any, options: any) => {
    if (request.method === 'tools/list') return { tools: [] };
    seen.push(options?.timeout);
    return { content: [], structuredContent: { ok: true, data: [] } };
  }) as any;
  await callReadTool(client, 'get_thread', { mailbox: 'INBOX', uid: 1 }, 290000);
  expect(seen).toEqual([290000]);
});
it.each(['send_email', 'reply_email', 'trash_email', 'create_draft', 'unknown_tool'])('live verifier blocks %s before dispatch', async name => {
  let dispatched = false;
  const client = { callTool: async () => { dispatched = true; } } as unknown as Client;
  await expect(callReadTool(client, name, {})).rejects.toThrow('READ_ONLY_VERIFIER');
  expect(dispatched).toBe(false);
});
it('retains safe diagnostic codes while excluding provider messages, tokens, and bodies', () => {
  const failure = safeFailure(Object.assign(new Error('private-body secret-token'), { code: -32001 }));
  expect(failure).toEqual({ kind: 'timeout', code: -32001 });
  expect(JSON.stringify(failure)).not.toMatch(/private-body|secret-token/);
});
it('rejects tool error envelopes without returning their private text', async () => {
  const client = { callTool: async () => ({ isError: true, structuredContent: { ok: false, code: 'AUTH_FAILED', message: 'private-body' } }) } as unknown as Client;
  await expect(callReadTool(client, 'get_email', {})).rejects.toMatchObject({ message: 'TOOL_CHECK_FAILED', code: 'AUTH_FAILED' });
});
