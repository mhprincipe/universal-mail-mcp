import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/mail/imap.js';

// Found live (2026-10-01): on Yahoo, every sender showed unsubscribe "none",
// LinkedIn included, though its raw headers have a List-Unsubscribe link. The
// same code worked on Gmail and on the test server, which match header names
// in any case. Yahoo answered nothing to names asked for in lower case, while
// the thread scan, asking for "References" as written, always worked on it.
// So headers are asked for as they're written. This stand-in for Yahoo
// returns a header only when it's asked for in exactly its own case.
const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
afterEach(() => vi.restoreAllMocks());

const stored = [
  'List-Unsubscribe: <https://jobs.example.com/unsubscribe?id=1>',
  'References: <earlier@example.invalid>'
];
// What Yahoo returns for BODY.PEEK[HEADER.FIELDS (...)]: only exact names.
const yahooHeaders = (asked: string[]) => Buffer.from(stored.filter(line => asked.includes(line.slice(0, line.indexOf(':')))).map(line => `${line}\r\n`).join('') + '\r\n');

function yahoo() {
  const gateway = new ImapGateway(config);
  const row = (uid: number, query: { headers?: string[] }) => ({
    uid, flags: new Set(), envelope: { messageId: `<m${uid}@x>`, from: [{ name: 'Jobs', address: 'alerts@jobs.example.com' }] },
    headers: yahooHeaders(query.headers ?? [])
  });
  const client = {
    mailbox: { path: 'INBOX', readOnly: true, exists: 1 },
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    fetchOne: vi.fn(async (uid: number, query: { headers?: string[] }) => row(uid, query)),
    fetchAll: vi.fn(async (_range: unknown, query: { headers?: string[] }) => [row(1, query)]),
    noop: vi.fn()
  };
  vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as never));
  return gateway;
}

describe('headers asked for as they are written', () => {
  it('UNS-12 on a server that matches header names exactly (Yahoo), the sender summary sees the unsubscribe link (added: 2.4.4, found live)', async () => {
    const [row] = await yahoo().senderStats('INBOX', 10);
    expect(row).toMatchObject({ unsubscribe: 'link' });
  });

  it('UNS-12 and the unsubscribe tool reads the same headers', async () => {
    expect(await yahoo().fetchListHeaders('INBOX', 1)).toMatchObject({ listUnsubscribe: '<https://jobs.example.com/unsubscribe?id=1>' });
  });

  it('UNS-12 and a reply reads the References it needs to join the conversation', async () => {
    expect((await yahoo().fetchReplyHeaders('INBOX', 1)).references).toEqual(['<earlier@example.invalid>']);
  });
});
