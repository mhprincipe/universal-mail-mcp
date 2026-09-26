import { describe, expect, it } from 'vitest';
import { startImapServer, type ImapServer } from '../src/imapServer.js';
import { startFaultProxy } from '../src/faultProxy.js';
import { connect, seed } from '../src/seed.js';

const via = (server: ImapServer, proxy: { host: string; port: number }): ImapServer => ({ ...server, host: proxy.host, port: proxy.port });

describe('fault proxy', () => {
  it('TK-04 passes traffic unchanged by default', async () => {
    const server = await startImapServer('yahoo-like');
    const proxy = await startFaultProxy(server);
    try {
      // A body line that looks like an IMAP literal marker must pass through untouched.
      await seed(server, { folders: ['Receipts'], messages: [{ mailbox: 'Receipts', subject: 'through the proxy', body: 'line one\r\n{5}\r\na7 OK not a real reply' }] });
      const read = async (endpoint: ImapServer) => {
        const client = connect(endpoint);
        await client.connect();
        try {
          const folders = (await client.list()).map(f => f.path).sort();
          const lock = await client.getMailboxLock('Receipts');
          try {
            const message = await client.fetchOne('*', { source: true });
            return { folders, source: message && message.source?.toString() };
          } finally { lock.release(); }
        } finally { await client.logout(); }
      };
      const direct = await read(server);
      const viaProxy = await read(via(server, proxy)).catch(error => `failed: ${(error as Error).message}`);
      expect(viaProxy).toEqual(direct);
    } finally {
      await proxy.stop();
      await server.stop();
    }
  });

  it('TK-05 drops the connection after a named command, which the server still carries out', async () => {
    const server = await startImapServer('yahoo-like');
    const proxy = await startFaultProxy(server, { dropAfter: 'UID MOVE' });
    try {
      const [message] = (await seed(server, { messages: [{ mailbox: 'INBOX', subject: 'moved in the dark' }] })).messages;
      const client = connect(via(server, proxy));
      client.on('error', () => undefined);
      await client.connect();
      const outcome = await (async () => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          // ImapFlow resolves false, rather than throwing, when a move isn't confirmed.
          const moved = await client.messageMove(String(message!.uid), 'Archive', { uid: true });
          return moved ? 'confirmed' : 'connection lost';
        } catch {
          return 'connection lost';
        } finally {
          try { lock.release(); } catch { /* connection already gone */ }
        }
      })();
      client.close();
      expect(outcome).toBe('connection lost');

      const check = connect(server);
      await check.connect();
      try {
        const counts = [(await check.status('INBOX', { messages: true })).messages, (await check.status('Archive', { messages: true })).messages];
        expect(counts).toEqual([0, 1]);
      } finally { await check.logout(); }
    } finally {
      await proxy.stop();
      await server.stop();
    }
  });

  it('TK-06 blanks HEADER search results, reproducing the Yahoo quirk', async () => {
    const server = await startImapServer('yahoo-like');
    const proxy = await startFaultProxy(server, { blankHeaderSearch: true });
    try {
      const [message] = (await seed(server, { messages: [{ mailbox: 'INBOX', subject: 'find me by header' }] })).messages;
      const search = async (endpoint: ImapServer) => {
        const client = connect(endpoint);
        await client.connect();
        try {
          const lock = await client.getMailboxLock('INBOX');
          try {
            const header = await client.search({ header: { 'Message-ID': message!.messageId } }, { uid: true });
            const all = await client.search({ all: true }, { uid: true });
            return { header, all };
          } finally { lock.release(); }
        } finally { await client.logout(); }
      };
      expect(await search(server)).toEqual({ header: [message!.uid], all: [message!.uid] });
      // Through the proxy: header searches find nothing; other searches are untouched.
      expect(await search(via(server, proxy))).toEqual({ header: [], all: [message!.uid] });
    } finally {
      await proxy.stop();
      await server.stop();
    }
  });

  it('TK-07 delays the reply to a named command by at least the set time', async () => {
    const server = await startImapServer('yahoo-like');
    const proxy = await startFaultProxy(server, { delay: { command: 'NOOP', ms: 400 } });
    try {
      const client = connect(via(server, proxy));
      await client.connect();
      try {
        const started = Date.now();
        await client.noop();
        expect(Date.now() - started).toBeGreaterThanOrEqual(390);
        expect(client.usable).toBe(true);
      } finally { await client.logout(); }
    } finally {
      await proxy.stop();
      await server.stop();
    }
  });
});
