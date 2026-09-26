import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../../src/app.js';
import { startFaultProxy, type FaultProxy, type FaultRules } from './faultProxy.js';
import { startImapServer, type ImapServer } from './imapServer.js';
import type { ProfileName } from './profiles.js';
import { startSmtpCapture, type SmtpCapture } from './smtpCapture.js';

export type ToolResult = { result: any; isError?: boolean };
export type Product = {
  server: ImapServer;
  smtp: SmtpCapture;
  // Present when started with imapFault.
  proxy?: FaultProxy;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  // Like call, but throws with the tool's own answer if it did not succeed.
  ok(name: string, args?: Record<string, unknown>): Promise<any>;
  stop(): Promise<void>;
};
export type ProductOptions = {
  sentCopyMode?: 'append' | 'yahoo';
  // The SMTP server files each delivery in Sent itself, as Yahoo does.
  serverSavesSent?: boolean;
  // The SMTP server takes the message, then cuts the connection before confirming.
  smtpDropsAfterData?: boolean;
  // Put a fault proxy between the product and the mail server.
  imapFault?: FaultRules;
  // Extra server settings (such as a short SEARCH_TIMEOUT_MS).
  env?: NodeJS.ProcessEnv;
};

export type AccountSpec = { name: string; server: ImapServer; user: string; password?: string };
export type MultiProduct = Omit<Product, 'server' | 'proxy'>;

// Several accounts in one product. Accounts on the same test server are kept
// apart by user name: each user has its own mailbox. A wrong password makes a
// broken account.
export async function startMultiProduct(accounts: AccountSpec[]): Promise<MultiProduct> {
  const smtp = await startSmtpCapture();
  const token = randomBytes(24).toString('hex');
  const http: Server = createApp({
    MCP_ACCESS_SECRET: token,
    MAIL_ACCOUNTS: JSON.stringify(accounts.map(a => ({
      name: a.name, email: a.user, sentCopyMode: 'append',
      imap: { host: a.server.host, port: a.server.port, tls: 'none' },
      smtp: { host: smtp.host, port: smtp.port, tls: 'none' }
    }))),
    MAIL_PASSWORDS: JSON.stringify(Object.fromEntries(accounts.map(a => [a.name, a.password ?? a.server.password])))
  }).listen(0, '127.0.0.1');
  const { call, ok, close } = await connectClient(http, token);
  return { smtp, call, ok, stop: async () => { await close(); await smtp.stop(); } };
}

async function connectClient(http: Server, token: string) {
  await new Promise<void>(resolve => http.listening ? resolve() : http.once('listening', resolve));
  const client = new Client({ name: 'protocol-tier', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
  ));
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const response = await client.callTool({ name, arguments: args });
    return { result: response.structuredContent, isError: response.isError as boolean | undefined };
  };
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const { result, isError } = await call(name, args);
    if (isError || !result?.ok) throw new Error(`${name} did not succeed: ${JSON.stringify(result)}`);
    return result.data;
  };
  const close = async () => {
    await client.close().catch(() => undefined);
    await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
  };
  return { call, ok, close };
}

// TK-13: the whole product as an AI app reaches it (HTTP, bearer token, MCP),
// against a real mail server and a capturing SMTP server.
export async function startProduct(profile: ProfileName, options: ProductOptions = {}): Promise<Product> {
  const server = await startImapServer(profile);
  const smtp = await startSmtpCapture({
    ...(options.serverSavesSent ? { saveTo: { server, mailbox: 'Sent' } } : {}),
    dropAfterData: options.smtpDropsAfterData
  });
  const token = randomBytes(24).toString('hex');
  const proxy = options.imapFault ? await startFaultProxy(server, options.imapFault) : undefined;
  const imap = proxy ?? server;
  const http: Server = createApp({
    YAHOO_EMAIL: server.user, YAHOO_APP_PASSWORD: server.password, MCP_ACCESS_SECRET: token,
    IMAP_HOST: imap.host, IMAP_PORT: String(imap.port), IMAP_TLS: 'none',
    SMTP_HOST: smtp.host, SMTP_PORT: String(smtp.port), SMTP_TLS: 'none',
    SENT_COPY_MODE: options.sentCopyMode ?? 'append', ...options.env
  }).listen(0, '127.0.0.1');
  const { call, ok, close } = await connectClient(http, token);
  return {
    server, smtp, proxy, call, ok,
    stop: async () => {
      await close();
      await smtp.stop();
      await proxy?.stop();
      await server.stop();
    }
  };
}
