import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { ImapGateway } from '../../src/mail/imap.js';

// The whole tool layer over real HTTP and MCP, with the mail server replaced
// by an in-memory mailbox (ImapGateway's methods): fast enough for the unit
// tier. What the engine does on the wire is the protocol tier's job.
export type Row = { mailbox: string; uid: number; raw: Buffer; messageId: string; read: boolean; flagged: boolean };

// What fetchReplyHeaders reads from a real server, read here from the raw message.
export async function replyHeaders(raw: Buffer) {
  const parsed = await simpleParser(raw);
  const list = (a: unknown) => ((Array.isArray(a) ? a : a ? [a] : []) as Array<{ value: Array<{ name?: string; address?: string }> }>).flatMap(x => x.value).filter(x => x.address).map(x => ({ name: x.name || undefined, address: x.address! }));
  const refs = parsed.references;
  return { messageId: parsed.messageId, subject: parsed.subject, from: list(parsed.from), replyTo: list(parsed.replyTo), to: list(parsed.to), cc: list(parsed.cc), references: Array.isArray(refs) ? refs : refs ? [refs] : [] };
}

export async function startToolFixture(options: { env?: NodeJS.ProcessEnv } = {}) {
  const folders = ['INBOX', 'Draft', 'Sent', 'Archive', 'Trash'].map(path => ({
    path, specialUse: path === 'INBOX' ? '\\Inbox' : path === 'Draft' ? '\\Drafts' : `\\${path}`, selectable: true
  }));
  let nextUid = 1;
  const rows = new Map<number, Row>();
  const append = async (mailbox: string, raw: Buffer) => {
    const uid = nextUid++;
    rows.set(uid, { mailbox, uid, raw, messageId: (await simpleParser(raw)).messageId!, read: false, flagged: false });
    return uid;
  };
  const get = (mailbox: string, uid: number) => {
    const row = rows.get(uid);
    if (!row || row.mailbox !== mailbox) throw new Error('Fixture message missing');
    return row;
  };
  const summary = (row: Row) => ({ mailbox: row.mailbox, uid: row.uid, messageId: row.messageId, subject: 'Fixture', from: [{ address: 'self@example.invalid' }], to: [], read: row.read, flagged: row.flagged, untrustedContent: true as const });
  vi.spyOn(ImapGateway.prototype, 'run').mockRejectedValue(new Error('EXTERNAL_IO_FORBIDDEN'));
  vi.spyOn(ImapGateway.prototype, 'read').mockImplementation(fn => fn({} as never));
  vi.spyOn(ImapGateway.prototype, 'listFolders').mockImplementation(async () => folders);
  vi.spyOn(ImapGateway.prototype, 'search').mockImplementation(async input => [...rows.values()].filter(r => r.mailbox === input.mailbox).map(summary));
  vi.spyOn(ImapGateway.prototype, 'searchPage').mockImplementation(async input => ({ messages: [...rows.values()].filter(r => r.mailbox === input.mailbox).map(summary) }));
  vi.spyOn(ImapGateway.prototype, 'fetchSummary').mockImplementation(async (mailbox, uid) => summary(get(mailbox, uid)));
  vi.spyOn(ImapGateway.prototype, 'fetchRaw').mockImplementation(async (mailbox, uid) => ({ summary: summary(get(mailbox, uid)), raw: get(mailbox, uid).raw, envelope: {} }));
  vi.spyOn(ImapGateway.prototype, 'fetchReplyHeaders').mockImplementation(async (mailbox, uid) => replyHeaders(get(mailbox, uid).raw));
  vi.spyOn(ImapGateway.prototype, 'findByMessageId').mockImplementation(async (mailbox, id) => [...rows.values()].filter(r => r.mailbox === mailbox && r.messageId === id).map(r => r.uid));
  vi.spyOn(ImapGateway.prototype, 'findThreadUids').mockImplementation(async (mailbox, id) => [...rows.values()].filter(r => r.mailbox === mailbox && r.raw.toString().includes(id)).map(r => r.uid));
  vi.spyOn(ImapGateway.prototype, 'append').mockImplementation(append);
  vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail: vi.fn(async (o: { envelope: { to: string[] } }) => ({ accepted: o.envelope.to, rejected: [] })), verify: async () => true } as never);

  const token = 'fixture-token-at-least-24-characters';
  const server: Server = createApp({
    AUTH_MODE: 'bearer', YAHOO_EMAIL: 'self@example.invalid', YAHOO_APP_PASSWORD: 'fixture-password', MCP_ACCESS_SECRET: token,
    SENT_COPY_MODE: 'append', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1', ...options.env
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const client = new Client({ name: 'tool-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));

  // A message with these headers and body, in this folder.
  const seed = async (mailbox: string, fields: { subject?: string; text?: string; html?: string; messageId?: string; references?: string }) => {
    const id = fields.messageId ?? `<${Math.random().toString(36).slice(2)}@fixture.invalid>`;
    const headers = [`From: sender@example.invalid`, `To: self@example.invalid`, `Subject: ${fields.subject ?? 'Fixture'}`, `Message-ID: ${id}`,
      ...(fields.references ? [`References: ${fields.references}`, `In-Reply-To: ${fields.references.split(' ').at(-1)}`] : []), 'MIME-Version: 1.0'];
    const body = fields.html !== undefined
      ? ['Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8', '', fields.text ?? 'plain', '--b1', 'Content-Type: text/html; charset=utf-8', '', fields.html, '--b1--']
      : ['Content-Type: text/plain; charset=utf-8', '', fields.text ?? 'plain'];
    return { uid: await append(mailbox, Buffer.from([...headers, ...body].join('\r\n'))), messageId: id };
  };
  // A whole message as it would arrive (attachments and all), in this folder.
  const seedRaw = async (mailbox: string, raw: Buffer) => ({ uid: await append(mailbox, raw) });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const content = (response.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    const text = content[0]?.text ?? '';
    return { result: response.structuredContent as any, isError: response.isError as boolean | undefined, size: text.length, content };
  };
  return {
    rows, seed, seedRaw, call, client,
    tools: async () => (await client.listTools()).tools,
    stop: async () => {
      await client.close().catch(() => undefined);
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      vi.restoreAllMocks();
    }
  };
}
