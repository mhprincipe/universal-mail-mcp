import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/yahoo/imap.js';

// The tuned engine paths (ENG-22..25) at unit speed. What they send to a real
// server is tests/tuning.protocol.test.ts.
const config = loadConfig({ YAHOO_EMAIL: 'test@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });

function client(fetchOne: (uid: number, query: unknown) => unknown) {
  return {
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    fetchOne: vi.fn(async (uid: number, query: unknown) => fetchOne(uid, query)),
    noop: vi.fn(async () => undefined)
  };
}
const gatewayOn = (c: ReturnType<typeof client>) => {
  const gateway = new ImapGateway(config);
  vi.spyOn(gateway, 'run').mockImplementation(fn => fn(c as never));
  return gateway;
};

describe('a reply reads only the headers it needs', () => {
  const original = {
    uid: 4,
    envelope: {
      messageId: '<q@example.invalid>', subject: 'Question',
      from: [{ name: 'Friend', address: 'friend@example.invalid' }], replyTo: [{ name: '', address: 'answers@example.invalid' }],
      to: [{ address: 'test@example.invalid' }], cc: [{ address: 'other@example.invalid' }, { name: 'nobody' }]
    },
    headers: Buffer.from('References: <a@example.invalid>\r\n <b@example.invalid>\r\n')
  };

  it('ENG-24 envelope and References, from the read-only folder, never the message body', async () => {
    const c = client(() => original);
    const headers = await gatewayOn(c).fetchReplyHeaders('INBOX', 4);
    expect(headers).toEqual({
      messageId: '<q@example.invalid>', subject: 'Question',
      from: [{ name: 'Friend', address: 'friend@example.invalid' }], replyTo: [{ name: undefined, address: 'answers@example.invalid' }],
      to: [{ name: undefined, address: 'test@example.invalid' }], cc: [{ name: undefined, address: 'other@example.invalid' }],
      references: ['<a@example.invalid>', '<b@example.invalid>']
    });
    expect(c.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(c.fetchOne).toHaveBeenCalledWith(4, { envelope: true, headers: ['references'] }, { uid: true });
  });

  it('ENG-24 a missing message, or a system email, is not found', async () => {
    await expect(gatewayOn(client(() => false)).fetchReplyHeaders('INBOX', 4)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    const system = { ...original, envelope: { ...original.envelope, messageId: '<code@system.universal-mail.invalid>' } };
    await expect(gatewayOn(client(() => system)).fetchReplyHeaders('INBOX', 4)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
  });

  it('ENG-24 no References header and an empty envelope still answer', async () => {
    const headers = await gatewayOn(client(() => ({ uid: 4, envelope: {} }))).fetchReplyHeaders('INBOX', 4);
    expect(headers).toEqual({ messageId: undefined, subject: undefined, from: [], replyTo: [], to: [], cc: [], references: [] });
  });
});

describe('a message that arrived while its folder was open', () => {
  it('ENG-25 not found at first: the folder is refreshed (NOOP) and asked once more', async () => {
    let arrived = false;
    const c = client(() => arrived ? { uid: 9, envelope: { messageId: '<new@x>' }, flags: new Set(), size: 10 } : false);
    c.noop.mockImplementation(async () => { arrived = true; });
    expect((await gatewayOn(c).fetchSummary('INBOX', 9)).messageId).toBe('<new@x>');
    expect(c.noop).toHaveBeenCalledTimes(1);
    expect(c.fetchOne).toHaveBeenCalledTimes(2);
  });

  it('ENG-25 found at once costs nothing extra; really missing is still not found', async () => {
    const found = client(() => ({ uid: 9, envelope: { messageId: '<m@x>' }, flags: new Set(), size: 10 }));
    await gatewayOn(found).fetchSummary('INBOX', 9);
    expect(found.noop).not.toHaveBeenCalled();
    const missing = client(() => false);
    await expect(gatewayOn(missing).fetchSummary('INBOX', 9)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    expect(missing.noop).toHaveBeenCalledTimes(1);
  });
});
