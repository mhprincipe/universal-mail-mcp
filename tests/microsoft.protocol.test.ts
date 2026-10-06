import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app.js';
import { startImapServer, type ImapServer } from '../testkit/src/imapServer.js';
import { startSmtpCapture, type SmtpCapture } from '../testkit/src/smtpCapture.js';

// A Microsoft account on a real mail server (2.5): Dovecot accepting only
// XOAUTH2 with an access token, as Outlook does; an SMTP server accepting only
// that token; and a stand-in for Microsoft's token endpoint, which swaps the
// saved refresh token for that access token. Through the tools, over the wire.
describe('a Microsoft account on a real mail server', () => {
  let imap: ImapServer;
  let smtp: SmtpCapture;
  let microsoft: Server;
  let app: Server;
  let client: Client;
  const asked: Array<Record<string, string>> = [];
  let answer: 'right' | 'refused' = 'right';

  beforeAll(async () => {
    imap = await startImapServer('outlook-like');
    smtp = await startSmtpCapture({ accessToken: imap.password });
    microsoft = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        asked.push(Object.fromEntries(new URLSearchParams(body)));
        res.setHeader('content-type', 'application/json');
        if (answer === 'refused') { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
        res.end(JSON.stringify({ access_token: imap.password, refresh_token: 'refresh-2', expires_in: 3600 }));
      });
    }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => microsoft.once('listening', resolve));
    const token = randomBytes(24).toString('hex');
    app = createApp({
      AUTH_MODE: 'bearer', MCP_ACCESS_SECRET: token,
      MICROSOFT_CLIENT_ID: 'client-123', MICROSOFT_AUTHORITY: `http://127.0.0.1:${(microsoft.address() as AddressInfo).port}/consumers`,
      MAIL_ACCOUNTS: JSON.stringify([{ name: 'outlook', email: imap.user, auth: 'microsoft', sentCopyMode: 'append',
        imap: { host: imap.host, port: imap.port, tls: 'none' }, smtp: { host: smtp.host, port: smtp.port, tls: 'none' } }]),
      MAIL_PASSWORDS: JSON.stringify({ outlook: 'refresh-1-saved' })
    }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => app.once('listening', resolve));
    client = new Client({ name: 'protocol-tier', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  });
  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await new Promise<void>(resolve => { app?.close(() => resolve()); app?.closeAllConnections(); });
    await new Promise<void>(resolve => { microsoft?.close(() => resolve()); microsoft?.closeAllConnections(); });
    await smtp?.stop();
    await imap?.stop();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })).structuredContent as any;

  it('MS-16 reads with XOAUTH2: the saved refresh token is swapped for an access token, and Outlook\'s folders are found (added: 2.5)', async () => {
    const folders = await call('list_folders');
    expect(folders.ok).toBe(true);
    expect(folders.data.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['INBOX', 'Sent Items', 'Deleted Items', 'Junk Email']));
    expect(asked[0]).toMatchObject({ client_id: 'client-123', grant_type: 'refresh_token', refresh_token: 'refresh-1-saved' });
  });

  it('MS-16 sends with SMTP XOAUTH2, and files the Sent copy in Sent Items', async () => {
    const sent = await call('send_email', { to: [imap.user], subject: 'Token mail', text: 'Sent with an access token.' });
    expect(sent).toMatchObject({ ok: true });
    expect(smtp.messages.at(-1)!.raw.toString('utf8')).toContain('Subject: Token mail');
    const filed = await call('search_email', { mailbox: 'Sent Items', subject: 'Token mail' });
    expect(filed.data).toHaveLength(1);
  });

  it('MS-16 a refresh token Microsoft refuses: AUTH_FAILED, nothing guessed', async () => {
    answer = 'refused';
    // A new connection is needed for a new token: the next one after the kept one is dropped.
    const app2 = createApp({
      AUTH_MODE: 'bearer', MCP_ACCESS_SECRET: 'x'.repeat(24),
      MICROSOFT_CLIENT_ID: 'client-123', MICROSOFT_AUTHORITY: `http://127.0.0.1:${(microsoft.address() as AddressInfo).port}/consumers`,
      MAIL_ACCOUNTS: JSON.stringify([{ name: 'outlook', email: imap.user, auth: 'microsoft', sentCopyMode: 'append',
        imap: { host: imap.host, port: imap.port, tls: 'none' }, smtp: { host: smtp.host, port: smtp.port, tls: 'none' } }]),
      MAIL_PASSWORDS: JSON.stringify({ outlook: 'refresh-revoked' })
    }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => app2.once('listening', resolve));
    const c2 = new Client({ name: 'protocol-tier', version: '1' });
    await c2.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app2.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${'x'.repeat(24)}` } } }));
    try {
      const refused = (await c2.callTool({ name: 'list_folders', arguments: {} })).structuredContent as any;
      expect(refused).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
    } finally {
      await c2.close().catch(() => undefined);
      await new Promise<void>(resolve => { app2.close(() => resolve()); app2.closeAllConnections(); });
      answer = 'right';
    }
  });
});
