import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, type Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app.js';
import { MailService } from '../src/yahoo/mailService.js';

const env = { YAHOO_EMAIL: 'dummy@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' };
const expected = ['search_email','get_email','get_thread','create_draft','update_draft','send_email','reply_email','move_email','archive_email','mark_read','mark_unread','flag_email','trash_email','restore_email','list_folders','create_folder'].sort();
const servers: Server[] = [];
async function start(settings: NodeJS.ProcessEnv = env) {
  const server = createApp(settings).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }))); });
describe('HTTP and live MCP contract with dummy credentials', () => {
  it('health works without secrets and returns no mailbox details', async () => {
    const response = await fetch(`${await start({})}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'yahoo-mail-mcp', version: '0.1.0' });
  });
  it.each(['/mcp', '/ready'])('%s rejects missing and wrong bearer credentials', async path => {
    const base = await start();
    for (const headers of ([{}, { Authorization: 'Bearer wrong' }] as Record<string, string>[])) {
      expect((await fetch(base + path, { headers })).status).toBe(401);
    }
  });
  it('rejects malicious Host and Origin with a valid bearer', async () => {
    const base = await start();
    for (const extra of ([{ Host: 'attacker.invalid' }, { Origin: 'https://attacker.invalid' }] as Record<string, string>[])) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(base + '/mcp', { headers: { Authorization: `Bearer ${env.MCP_ACCESS_SECRET}`, ...extra } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      expect(status).toBe(403);
    }
  });
  it('ready invokes IMAP and SMTP verification after authentication', async () => {
    const check = vi.spyOn(MailService.prototype, 'verifyConnectivity').mockResolvedValue({ imap: true, smtp: true, folders: 3 });
    const response = await fetch(`${await start()}/ready`, { headers: { Authorization: `Bearer ${env.MCP_ACCESS_SECRET}` } });
    expect(response.status).toBe(200); expect(check).toHaveBeenCalledTimes(1);
  });
  it('ready failure does not expose secrets or server text', async () => {
    vi.spyOn(MailService.prototype, 'verifyConnectivity').mockRejectedValue(new Error('secret password and body'));
    const response = await fetch(`${await start()}/ready`, { headers: { Authorization: `Bearer ${env.MCP_ACCESS_SECRET}` } });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('secret');
  });
  it('malformed JSON does not expose the body or invoke the default error logger', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await fetch(`${await start()}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MCP_ACCESS_SECRET}` }, body: '{private-mail-body' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('private-mail-body');
    expect(logger).not.toHaveBeenCalled();
  });
  it('discovers exactly 16 tools over HTTP without opening mail connections', async () => {
    const connection = vi.spyOn(MailService.prototype, 'verifyConnectivity').mockRejectedValue(new Error('must not connect'));
    const client = new Client({ name: 'local-contract-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${await start()}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${env.MCP_ACCESS_SECRET}` } } }));
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(expected);
      expect(connection).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });
});
