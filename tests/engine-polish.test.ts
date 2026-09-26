import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MailError } from '../src/errors.js';
import { ImapGateway } from '../src/yahoo/imap.js';

// Phase 5's engine paths, against a fake IMAP client: what the gateway asks
// the server, and how it decides when the answer is missing or wrong. The
// same paths against real Dovecot: polish.protocol.test.ts.
afterEach(() => vi.restoreAllMocks());

const config = (env: NodeJS.ProcessEnv = {}) => loadConfig({ YAHOO_EMAIL: 'me@example.invalid', YAHOO_APP_PASSWORD: 'unit-test-password', MCP_ACCESS_SECRET: 'unit-tests-only-not-a-secret', IMAP_HOST: '127.0.0.1', IMAP_TLS: 'none', SMTP_HOST: '127.0.0.1', ...env });
const envelope = (uid: number) => ({ uid, envelope: { messageId: uid === 13 ? '<x@system.universal-mail.invalid>' : `<m${uid}@example.invalid>` }, flags: new Set<string>(), size: 10 });

function fakeClient(options: { uids?: number[]; search?: () => Promise<number[]>; store?: () => Promise<boolean>; flagged?: (uid: number) => boolean } = {}) {
  const asked: unknown[] = [];
  const uidsOf = (range: unknown) => Array.isArray(range) ? range as number[] : String(range).split(',').map(Number);
  const client = {
    asked,
    getMailboxLock: async () => ({ release: () => undefined }),
    search: vi.fn(async (query: unknown) => { asked.push(query); return options.search ? options.search() : options.uids ?? []; }),
    fetchAll: vi.fn(async (range: unknown, query: { flags?: boolean }) => uidsOf(range).map(uid => ({
      ...envelope(uid), flags: new Set(query.flags && options.flagged?.(uid) ? ['\\Flagged'] : [])
    }))),
    messageFlagsAdd: vi.fn(async () => options.store ? options.store() : true),
    messageFlagsRemove: vi.fn(async () => true),
    close: vi.fn()
  };
  vi.spyOn(ImapGateway.prototype, 'run').mockImplementation(async fn => fn(client as never));
  vi.spyOn(ImapGateway.prototype, 'read').mockImplementation(async fn => fn(client as never));
  return client;
}

describe('the engine, polished', () => {
  it('POL-06 a page: newest first, with the cursor at its oldest UID; the next page asks only below it', async () => {
    const all = Array.from({ length: 130 }, (_, i) => i + 1);
    const client = fakeClient({ uids: all });
    const gateway = new ImapGateway(config());
    const first = await gateway.searchPage({ mailbox: 'INBOX', limit: 50 });
    expect(first.messages.map(m => m.uid)).toEqual(all.slice(80).reverse());
    expect(first.next).toBe(81);
    await gateway.searchPage({ mailbox: 'INBOX', limit: 50, beforeUid: 81 });
    expect(client.asked.at(-1)).toMatchObject({ uid: '1:80' });
    // Everything fits: no cursor.
    expect((await new ImapGateway(config()).searchPage({ mailbox: 'INBOX', limit: 200 })).next).toBeUndefined();
  });

  it('POL-06 a cursor at the very start asks nothing; system emails are never in a page', async () => {
    const client = fakeClient({ uids: [11, 12, 13, 14] });
    const gateway = new ImapGateway(config());
    expect(await gateway.searchPage({ mailbox: 'INBOX', limit: 10, beforeUid: 1 })).toEqual({ messages: [] });
    expect(client.search).not.toHaveBeenCalled();
    expect((await gateway.searchPage({ mailbox: 'INBOX', limit: 10 })).messages.map(m => m.uid)).toEqual([14, 12, 11]);
  });

  it('POL-09 a search past its time limit is stopped: SEARCH_TOO_SLOW, and the connection closed, not reused', async () => {
    const client = fakeClient({ search: () => new Promise<number[]>(() => undefined) });
    const gateway = new ImapGateway(config({ SEARCH_TIMEOUT_MS: '50' }));
    await expect(gateway.searchPage({ mailbox: 'INBOX', limit: 10, text: 'needle' })).rejects.toMatchObject({ code: 'SEARCH_TOO_SLOW' });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('POL-05 a batch of flags is one command for every UID', async () => {
    const client = fakeClient();
    await new ImapGateway(config()).setFlags('INBOX', [3, 4, 5], '\\Flagged', true);
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('3,4,5', ['\\Flagged'], { uid: true });
  });

  it('POL-05 an unconfirmed batch is read back: all as asked is success; anything else is unknown, not retried', async () => {
    const broken = () => Promise.reject(new Error('connection lost'));
    let client = fakeClient({ store: broken, flagged: () => true });
    await expect(new ImapGateway(config()).setFlags('INBOX', [3, 4], '\\Flagged', true)).resolves.toBeUndefined();
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    client = fakeClient({ store: broken, flagged: uid => uid === 3 });
    await expect(new ImapGateway(config()).setFlags('INBOX', [3, 4], '\\Flagged', true)).rejects.toMatchObject({ code: 'OPERATION_STATUS_UNKNOWN' });
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
  });

  it('POL-05 a batch that includes a system email is refused before any change', async () => {
    const client = fakeClient();
    const error = await new ImapGateway(config()).setFlags('INBOX', [12, 13], '\\Seen', true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailError);
    expect(error).toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });
});
