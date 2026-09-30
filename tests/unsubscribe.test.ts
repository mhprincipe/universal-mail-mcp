import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/mail/imap.js';
import { ONE_CLICK_LIMITS, pinnedPost, realOneClick, unsubscribeOneClick, type OneClickDeps } from '../src/unsubscribe.js';
import { startToolFixture } from '../testkit/src/toolFixture.js';

// One-click unsubscribe (added 2.4.1): the standard way (RFC 8058) that big
// senders must now offer. The address comes from an email, so it's treated as
// an outsider's choice: https only, a public address checked before
// connecting, no redirects, a time limit, nothing sent but the one line the
// standard says. Never for a message that looks like a scam: answering one
// only confirms the address is read.
let f: Awaited<ReturnType<typeof startToolFixture>> | undefined;
afterEach(async () => { await f?.stop(); f = undefined; vi.restoreAllMocks(); });

function newsletter(headers: string[], from = 'News <news@news.example.com>') {
  return Buffer.from([`From: ${from}`, 'To: self@example.invalid', 'Subject: This week', `Message-ID: <n-${Math.random().toString(36).slice(2)}@news.example.com>`,
    ...headers, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Hello'].join('\r\n'));
}
const ONE_CLICK = ['List-Unsubscribe: <mailto:leave@news.example.com>,', ' <https://news.example.com/u?id=7&t=abc>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'];

function spyOneClick(status = 200) {
  const posted: Array<{ url: string; address: string }> = [];
  vi.spyOn(realOneClick, 'resolve').mockResolvedValue(['93.184.216.34']);
  vi.spyOn(realOneClick, 'post').mockImplementation(async (url, address) => { posted.push({ url: url.href, address }); return status; });
  return posted;
}

describe('unsubscribing', () => {
  it('UNS-01 a sender that offers one click is asked once, at its own https address, and the email is left as it was', async () => {
    f = await startToolFixture();
    const posted = spyOneClick();
    const { uid } = await f.seedRaw('INBOX', newsletter(ONE_CLICK));
    const answer = await f.call('unsubscribe', { mailbox: 'INBOX', uid });
    expect(answer.result).toMatchObject({ ok: true, data: { mailbox: 'INBOX', uid, unsubscribed: true, sender: 'news.example.com' } });
    expect(answer.result.message).toMatch(/few days/);
    expect(posted).toEqual([{ url: 'https://news.example.com/u?id=7&t=abc', address: '93.184.216.34' }]);
    expect(f.rows.get(uid)).toMatchObject({ mailbox: 'INBOX', read: false });
  });

  it('UNS-02 a sender without one click (only an email address, or no promise of one click, or nothing) is left to the owner: nothing is sent', async () => {
    f = await startToolFixture();
    const posted = spyOneClick();
    for (const headers of [
      ['List-Unsubscribe: <mailto:leave@news.example.com>'],
      ['List-Unsubscribe: <https://news.example.com/u?id=7>'],
      ['List-Unsubscribe: <mailto:leave@news.example.com>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'],
      []
    ]) {
      const { uid } = await f.seedRaw('INBOX', newsletter(headers));
      const answer = await f.call('unsubscribe', { mailbox: 'INBOX', uid });
      expect(answer.result, headers.join(' ')).toMatchObject({ ok: false, code: 'MAIL-UNSUBSCRIBE-MANUAL' });
      expect(answer.result.message).toMatch(/mail app/);
    }
    expect(posted).toEqual([]);
  });

  it('UNS-03 an email that looks like a scam is never answered: its link would only confirm the address is read', async () => {
    f = await startToolFixture();
    const posted = spyOneClick();
    const { uid } = await f.seedRaw('INBOX', newsletter(ONE_CLICK, 'PayPal <service@paypa1-secure.example>'));
    const answer = await f.call('unsubscribe', { mailbox: 'INBOX', uid });
    expect(answer.result).toMatchObject({ ok: false, code: 'MAIL-UNSUBSCRIBE-CAUTION' });
    expect(answer.result.message).toMatch(/junk/);
    expect(posted).toEqual([]);
  });

  it('UNS-04 a refusal or an error from the sender is reported, not taken as done', async () => {
    f = await startToolFixture();
    spyOneClick(500);
    const { uid } = await f.seedRaw('INBOX', newsletter(ONE_CLICK));
    expect((await f.call('unsubscribe', { mailbox: 'INBOX', uid })).result).toMatchObject({ ok: false, code: 'MAIL-UNSUBSCRIBE-FAILED', data: { status: 500 } });
  });
});

describe('where an unsubscribe request may go', () => {
  const deps = (addresses: string[], status = 200) => {
    const post = vi.fn(async () => status);
    return { deps: { resolve: vi.fn(async () => addresses), post } satisfies OneClickDeps, post };
  };

  it('UNS-05 only https, a name (not a number), the standard port and no password in the address; every DNS answer public; checked before connecting', async () => {
    for (const address of ['http://news.example.com/u', 'https://user:pw@news.example.com/u', 'https://93.184.216.34/u', 'https://[2606:2800:220:1::1]/u', 'https://news.example.com:8443/u']) {
      const { deps: d, post } = deps(['93.184.216.34']);
      await expect(unsubscribeOneClick(new URL(address), d), address).rejects.toMatchObject({ code: 'MAIL-UNSUBSCRIBE-FAILED', details: { reason: 'unsafe address' } });
      expect(post).not.toHaveBeenCalled();
    }
    for (const answers of [['10.0.0.8'], ['169.254.169.254'], ['127.0.0.1'], ['::1'], ['fd00:ec2::254'], ['93.184.216.34', '192.168.1.1'], []]) {
      const { deps: d, post } = deps(answers);
      await expect(unsubscribeOneClick(new URL('https://news.example.com/u'), d), answers.join()).rejects.toMatchObject({ details: { reason: 'unsafe address' } });
      expect(post).not.toHaveBeenCalled();
    }
    const { deps: d, post } = deps(['93.184.216.34'], 204);
    await unsubscribeOneClick(new URL('https://news.example.com:443/u'), d);
    expect(post).toHaveBeenCalledWith(new URL('https://news.example.com/u'), '93.184.216.34');
  });

  it('UNS-05 anything but a 2xx answer, a redirect included, is a failure with its status; no answer at all is one too', async () => {
    for (const status of [301, 302, 404, 500]) {
      const { deps: d } = deps(['93.184.216.34'], status);
      await expect(unsubscribeOneClick(new URL('https://news.example.com/u'), d)).rejects.toMatchObject({ code: 'MAIL-UNSUBSCRIBE-FAILED', details: { status } });
    }
    const failing: OneClickDeps = { resolve: async () => ['93.184.216.34'], post: async () => { throw new Error('ECONNRESET'); } };
    await expect(unsubscribeOneClick(new URL('https://news.example.com/u'), failing)).rejects.toMatchObject({ code: 'MAIL-UNSUBSCRIBE-FAILED', details: { status: 0 } });
  });
});

describe('the request itself', () => {
  let server: http.Server | undefined;
  afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined; });

  it('UNS-06 one POST saying only "List-Unsubscribe=One-Click", to the vetted address with the real host name; a redirect is not followed; slow or huge answers are cut off', async () => {
    const seen: Array<{ method?: string; url?: string; host?: string; type?: string; body: string }> = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, host: req.headers.host, type: req.headers['content-type'], body });
        if (req.url === '/moved') { res.writeHead(302, { Location: '/elsewhere' }); res.end(); return; }
        if (req.url === '/slow') return;
        if (req.url === '/huge') { res.writeHead(200); res.end(Buffer.alloc(ONE_CLICK_LIMITS.maxBytes + 10)); return; }
        res.writeHead(200); res.end('bye');
      });
    }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const url = (path: string) => new URL(`http://news.example.com:${port}${path}`);
    expect(await pinnedPost(url('/u?id=7'), '127.0.0.1', ONE_CLICK_LIMITS, 'http')).toBe(200);
    expect(seen[0]).toEqual({ method: 'POST', url: '/u?id=7', host: `news.example.com:${port}`, type: 'application/x-www-form-urlencoded', body: 'List-Unsubscribe=One-Click' });
    expect(await pinnedPost(url('/moved'), '127.0.0.1', ONE_CLICK_LIMITS, 'http')).toBe(302);
    expect(seen.map(s => s.url)).not.toContain('/elsewhere');
    await expect(pinnedPost(url('/slow'), '127.0.0.1', { ...ONE_CLICK_LIMITS, timeoutMs: 200 }, 'http')).rejects.toThrow(/time/);
    await expect(pinnedPost(url('/huge'), '127.0.0.1', ONE_CLICK_LIMITS, 'http')).rejects.toThrow(/large/);
  });
});

describe('reading the headers', () => {
  const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });

  it('UNS-07 from the server, folded over lines and in any case, read-only; a system email is not found', async () => {
    const gateway = new ImapGateway(config);
    const rows: Record<number, any> = {
      4: { uid: 4, flags: new Set(), envelope: { messageId: '<n@x>', from: [{ address: 'news@news.example.com' }] },
        headers: Buffer.from('list-unsubscribe: <mailto:a@x>,\r\n\t<https://news.example.com/u?id=7>\r\nLIST-UNSUBSCRIBE-POST:  List-Unsubscribe=One-Click\r\n\r\n') },
      5: { uid: 5, flags: new Set(), envelope: { messageId: '<code@system.universal-mail.invalid>' }, headers: Buffer.from('') }
    };
    const locks: unknown[] = [];
    const client = { getMailboxLock: vi.fn(async (_path: string, options: unknown) => { locks.push(options); return { release: vi.fn() }; }), fetchOne: vi.fn(async (uid: number) => rows[uid] ?? false), noop: vi.fn() };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as never));
    expect(await gateway.fetchListHeaders('INBOX', 4)).toMatchObject({
      summary: { uid: 4, from: [{ address: 'news@news.example.com' }] },
      listUnsubscribe: '<mailto:a@x>, <https://news.example.com/u?id=7>', listUnsubscribePost: 'List-Unsubscribe=One-Click'
    });
    expect(locks).toEqual([{ readOnly: true }]);
    expect(client.fetchOne).toHaveBeenCalledWith(4, { envelope: true, flags: true, headers: ['list-unsubscribe', 'list-unsubscribe-post'] }, { uid: true });
    await expect(gateway.fetchListHeaders('INBOX', 5)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
  });
});

describe('the real network parts', () => {
  it('UNS-09 DNS answers are passed on as they come; the request is https with the certificate checked: an untrusted one is refused (added: coverage)', async () => {
    const https = await import('node:https');
    const { localhostTls } = await import('../testkit/src/localhostTls.js');
    expect((await realOneClick.resolve('localhost')).length).toBeGreaterThan(0);
    const tls = await localhostTls();
    let reached = false;
    const secure = https.createServer({ key: tls.key, cert: tls.cert }, (_req, res) => { reached = true; res.end(); }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => secure.once('listening', resolve));
    try {
      const port = (secure.address() as AddressInfo).port;
      await expect(realOneClick.post(new URL(`https://localhost:${port}/u`), '127.0.0.1')).rejects.toThrow(/certificate/i);
      expect(reached).toBe(false);
    } finally { await new Promise<void>(resolve => secure.close(() => resolve())); }
  });
});
