import { describe, expect, it } from 'vitest';
import { ImapGateway } from '../src/mail/imap.js';

// FND-11 (added: 2.5.1, found live 2026-10-06): Yahoo's sender search matches a
// name's words, a whole address and a domain ("cnbc.com"), but not a bare part
// ("cnbc"): 7 of 15 emails from response.cnbc.com, named "Jim Cramer", were
// missed. A bare word is also asked as a domain (.com, .net, .org): anything
// those find also contains the word, so nothing is found that shouldn't be.
function server(options: { gmail?: boolean; reliable?: boolean } = {}) {
  const queries: any[] = [];
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>(options.gmail ? [['X-GM-EXT-1', true]] : []),
    mailbox: { path: 'INBOX', exists: 0, readOnly: true },
    connect: async () => undefined, close: () => undefined, noop: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async (query: unknown) => { queries.push(query); return []; },
    fetchAll: async () => []
  };
  const gateway = new ImapGateway({ SEARCH_TIMEOUT_MS: 5_000 } as never, { createClient: () => client as never, unreliableHeaderSearch: !options.reliable });
  return { gateway, queries };
}

describe('a sender search by part of an address', () => {
  it('FND-11 a bare word is also asked as a domain: .com, .net and .org (added: 2.5.1, found live)', async () => {
    const { gateway, queries } = server();
    await gateway.searchPage({ mailbox: 'INBOX', from: 'cnbc', limit: 25 });
    expect(queries[0]).toEqual({ all: true, or: [{ from: 'cnbc' }, { or: [{ from: 'cnbc.com' }, { or: [{ from: 'cnbc.net' }, { from: 'cnbc.org' }] }] }] });
  });

  it('FND-11 not for an address or a domain (they match already), not with a text search, not on Gmail or a reliable server', async () => {
    for (const from of ['jim.cramer@response.cnbc.com', 'cnbc.com', 'Jim Cramer']) {
      const { gateway, queries } = server();
      await gateway.searchPage({ mailbox: 'INBOX', from, limit: 25 });
      expect(queries[0], from).toEqual({ all: true, from });
    }
    const text = server();
    await text.gateway.searchPage({ mailbox: 'INBOX', from: 'cnbc', text: 'market', limit: 25 });
    expect(text.queries[0].from).toBe('cnbc');
    const gmail = server({ gmail: true });
    await gmail.gateway.searchPage({ mailbox: 'INBOX', from: 'cnbc', limit: 25 });
    expect(gmail.queries[0]).toEqual({ all: true, from: 'cnbc' });
    const reliable = server({ reliable: true });
    await reliable.gateway.searchPage({ mailbox: 'INBOX', from: 'cnbc', limit: 25 });
    expect(reliable.queries[0]).toEqual({ all: true, from: 'cnbc' });
  });
});
