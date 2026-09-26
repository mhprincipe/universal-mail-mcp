import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DetectionDeps } from '../../src/providers.js';
import { createSetupLog } from '../../src/setup/log.js';
import { createMailCheck, fetchAutoconfig, parseAutoconfig } from '../../src/setup/realMail.js';

// SET-72 (added): the real MailCheck setup uses. Detection itself is tested in
// providers.test.ts; this is the wiring, the autoconfig lookup, and the log.
let home: string | undefined;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; });
const newLog = () => { home = mkdtempSync(join(tmpdir(), 'realmail-')); return createSetupLog(home, Date); };
const logEntries = () => readFileSync(join(home!, '.universal-mail', 'setup-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

const noLookups: DetectionDeps = {
  resolveMx: async () => { throw new Error('no lookup expected'); },
  autoconfig: async () => { throw new Error('no lookup expected'); },
  resolveSrv: async () => { throw new Error('no lookup expected'); }
};
const nothingFound: DetectionDeps = { resolveMx: async () => [], autoconfig: async () => undefined, resolveSrv: async () => [] };

const AUTOCONFIG = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <incomingServer type="pop3"><hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
    <incomingServer type="imap"><hostname>plain.example.org</hostname><port>143</port><socketType>plain</socketType></incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.org</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
    </incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
  </emailProvider>
</clientConfig>`;

describe('the real mail check: finding the provider', () => {
  it('SET-72 a known domain needs no lookups; its profile is used (added)', async () => {
    const mail = createMailCheck({ log: newLog(), lookups: noLookups });
    const found = await mail.detect('someone@yahoo.com');
    expect(found?.provider).toMatchObject({ id: 'yahoo', smtp: { host: 'smtp.mail.yahoo.com', port: 587, tls: 'starttls' } });
  });

  it('SET-72 a custom domain hosted by a known provider is found by its mail records', async () => {
    const mail = createMailCheck({ log: newLog(), lookups: { ...nothingFound, resolveMx: async () => ['mx-aol.mail.gm0.yahoodns.net.'] } });
    expect((await mail.detect('me@family.example'))?.provider.id).toBe('yahoo');
    expect(logEntries().find(e => e.op === 'detect-detail')).toMatchObject({ domain: 'family.example', via: 'mx', provider: 'yahoo' });
  });

  it('SET-72 a published autoconfig gives a provider named after the domain, with its servers', async () => {
    const mail = createMailCheck({ log: newLog(), lookups: { ...nothingFound, autoconfig: async () => parseAutoconfig(AUTOCONFIG) } });
    const found = await mail.detect('me@example.org');
    expect(found?.provider).toMatchObject({
      id: 'other', name: 'example.org',
      imap: { host: 'imap.example.org', port: 993, tls: 'implicit' },
      smtp: { host: 'smtp.example.org', port: 587, tls: 'starttls' }
    });
    expect(logEntries().find(e => e.op === 'detect-detail')).toMatchObject({ via: 'autoconfig', imapHost: 'imap.example.org', smtpHost: 'smtp.example.org' });
  });

  it('SET-72 nothing found: undefined, so the person is asked', async () => {
    const mail = createMailCheck({ log: newLog(), lookups: nothingFound });
    expect(await mail.detect('me@nowhere.example')).toBeUndefined();
    expect(logEntries().find(e => e.op === 'detect-detail')).toMatchObject({ domain: 'nowhere.example', via: 'none' });
  });
});

describe('autoconfig', () => {
  it('SET-72 the first encrypted IMAP server and the SMTP server are taken; unencrypted ones never', () => {
    expect(parseAutoconfig(AUTOCONFIG)).toEqual({
      imap: { host: 'imap.example.org', port: 993, tls: 'implicit' },
      smtp: { host: 'smtp.example.org', port: 587, tls: 'starttls' }
    });
    expect(parseAutoconfig(AUTOCONFIG.replace('<socketType>STARTTLS</socketType>', '<socketType>plain</socketType>'))).toBeUndefined();
    expect(parseAutoconfig('<html>not found</html>')).toBeUndefined();
  });

  it('SET-72 asks the domain itself first, then Thunderbird\'s public list; always over https', async () => {
    const asked: string[] = [];
    const found = await fetchAutoconfig('example.org', async (url, init) => {
      // A redirect could lead anywhere, including plain http: never followed.
      asked.push(`${String(url)} redirect=${init?.redirect}`);
      return String(url).includes('thunderbird') ? new Response(AUTOCONFIG) : new Response('no', { status: 404 });
    });
    expect(asked).toEqual([
      'https://autoconfig.example.org/mail/config-v1.1.xml redirect=error',
      'https://autoconfig.thunderbird.net/v1.1/example.org redirect=error'
    ]);
    expect(found?.imap.host).toBe('imap.example.org');
  });

  it('SET-72 a server name that isn\'t a plain host name (such as a placeholder) is skipped', () => {
    const placeholder = AUTOCONFIG.replace('<hostname>imap.example.org</hostname>', '<hostname>imap.%EMAILDOMAIN%</hostname>');
    expect(parseAutoconfig(placeholder)).toBeUndefined();
  });

  it('SET-72 an oversized, failing or silent answer counts as none', async () => {
    const huge = `${AUTOCONFIG}${' '.repeat(70_000)}`;
    expect(await fetchAutoconfig('example.org', async () => new Response(huge))).toBeUndefined();
    expect(await fetchAutoconfig('example.org', async () => { throw new Error('network down'); })).toBeUndefined();
    const started = Date.now();
    const silent = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    expect(await fetchAutoconfig('example.org', silent, { timeoutMs: 200 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('SET-72 a domain that isn\'t a plain host name is never put into an address', async () => {
    const asked: string[] = [];
    const record = async (url: string | URL | Request) => { asked.push(String(url)); return new Response('no', { status: 404 }); };
    for (const domain of ['evil.example/path', 'a@b.example', 'x.example:8080', '..', '']) {
      expect(await fetchAutoconfig(domain, record)).toBeUndefined();
    }
    expect(asked).toEqual([]);
  });
});
