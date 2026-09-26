import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { success } from '../src/errors.js';
import { createAccountServices, createMultiMail, type AccountService } from '../src/multiMail.js';
import type { MessageSummary } from '../src/types.js';

const config = (address: string) => loadConfig({ YAHOO_EMAIL: address, YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
const folderList = (path: string) => ({ list: async () => [{ path, specialUse: '', flags: new Set<string>(), delimiter: '/' }] }) as any;

const row = (uid: number, date: string): MessageSummary => ({ mailbox: 'INBOX', uid, date, from: [], to: [], read: false, flagged: false, untrustedContent: true });
const fake = (rows: MessageSummary[]): AccountService => ({
  searchEmail: vi.fn(async () => success(rows)),
  moveEmail: vi.fn()
}) as unknown as AccountService;

afterEach(() => vi.restoreAllMocks());

describe('multi-account search', () => {
  it('ENG-05 a search with no account covers every reachable account and tags each result', async () => {
    const mail = createMultiMail(new Map([
      ['personal', fake([row(1, '2026-09-01T10:00:00.000Z')])],
      ['fleet', fake([row(7, '2026-09-02T10:00:00.000Z')])]
    ]));
    const result = await mail.search({ mailbox: 'INBOX', limit: 25 }, ['personal', 'fleet']);
    expect(result.data).toHaveLength(2);
    expect(result.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ account: 'personal', uid: 1 }),
      expect.objectContaining({ account: 'fleet', uid: 7 })
    ]));
  });

  it('ENG-06 search-all merges results newest first across accounts', async () => {
    const mail = createMultiMail(new Map([
      ['personal', fake([row(1, '2026-09-01T10:00:00.000Z'), row(2, '2026-09-03T10:00:00.000Z')])],
      ['fleet', fake([row(7, '2026-09-02T10:00:00.000Z'), row(8, '2026-08-30T10:00:00.000Z')])]
    ]));
    const result = await mail.search({ mailbox: 'INBOX', limit: 25 }, ['personal', 'fleet']);
    expect(result.data!.map(r => `${r.account}:${r.uid}`)).toEqual(['personal:2', 'fleet:7', 'personal:1', 'fleet:8']);
  });

  it('ENG-07 one account failing during search-all returns the others plus a warning', async () => {
    const broken = fake([]);
    vi.mocked(broken.searchEmail).mockRejectedValue(Object.assign(new Error('connection closed'), { code: 'ECONNRESET' }));
    const mail = createMultiMail(new Map([
      ['personal', fake([row(1, '2026-09-01T10:00:00.000Z')])],
      ['fleet', broken]
    ]));
    const result = await mail.search({ mailbox: 'INBOX', limit: 25 }, ['personal', 'fleet']);
    expect(result).toMatchObject({ ok: true, status: 'SUCCESS' });
    expect(result.data!.map(r => `${r.account}:${r.uid}`)).toEqual(['personal:1']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain('fleet');
    expect(result.warnings![0]).not.toContain('ECONNRESET');
  });
});

describe('multi-account moves', () => {
  it('ENG-09 a move between accounts is refused and changes nothing', async () => {
    const personal = fake([]);
    const fleet = fake([]);
    const mail = createMultiMail(new Map([['personal', personal], ['fleet', fleet]]));
    await expect(mail.move({ account: 'personal', mailbox: 'INBOX', uid: 1, destination: 'Archive', destinationAccount: 'fleet' }))
      .rejects.toMatchObject({ code: 'MAIL-CROSS-ACCOUNT', status: 'FAILED' });
    expect(personal.moveEmail).not.toHaveBeenCalled();
    expect(fleet.moveEmail).not.toHaveBeenCalled();
  });

  it('ENG-13 a move within one account goes to that account and no other', async () => {
    const personal = fake([]);
    const fleet = fake([]);
    const mail = createMultiMail(new Map([['personal', personal], ['fleet', fleet]]));
    await mail.move({ account: 'fleet', mailbox: 'INBOX', uid: 5, destination: 'Archive' });
    await mail.move({ account: 'fleet', mailbox: 'INBOX', uid: 6, destination: 'Archive', destinationAccount: 'fleet' });
    expect(vi.mocked(fleet.moveEmail).mock.calls).toEqual([['INBOX', 5, 'Archive'], ['INBOX', 6, 'Archive']]);
    expect(personal.moveEmail).not.toHaveBeenCalled();
  });
});

describe('per-account services', () => {
  it('ENG-08 each account has its own folder cache', async () => {
    const services = createAccountServices([
      { name: 'personal', config: config('personal@example.invalid') },
      { name: 'fleet', config: config('fleet@example.invalid') }
    ]);
    const personal = services.get('personal');
    const fleet = services.get('fleet');
    expect(personal).toBeDefined();
    expect(fleet).toBeDefined();
    vi.spyOn(personal!.imap, 'run').mockImplementation(fn => fn(folderList('Personal-Only')));
    vi.spyOn(fleet!.imap, 'run').mockImplementation(fn => fn(folderList('Fleet-Only')));
    expect((await personal!.imap.listFolders()).map(f => f.path)).toEqual(['Personal-Only']);
    expect((await fleet!.imap.listFolders()).map(f => f.path)).toEqual(['Fleet-Only']);
  });

  it('ENG-10 search-all over five accounts opens exactly one connection per account', async () => {
    const names = ['personal', 'work', 'fleet', 'apple', 'sailing'];
    const services = createAccountServices(names.map(name => ({ name, config: config(`${name}@example.invalid`) })));
    const connections = new Map<string, number>();
    const emptyInbox = { getMailboxLock: async () => ({ release: () => undefined }), search: async () => [] } as any;
    for (const name of names) {
      vi.spyOn(services.get(name)!.imap, 'run').mockImplementation(fn => {
        connections.set(name, (connections.get(name) ?? 0) + 1);
        return fn(emptyInbox);
      });
    }
    await createMultiMail(services).search({ mailbox: 'INBOX', limit: 25 }, names);
    expect(Object.fromEntries(connections)).toEqual(Object.fromEntries(names.map(name => [name, 1])));
  });
});
