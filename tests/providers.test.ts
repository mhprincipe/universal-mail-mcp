import { describe, expect, it, vi } from 'vitest';
import { detectProvider, moveSafety, profiles, reconcileCapabilities, type DetectionDeps } from '../src/providers.js';

// Lookups are injected, so these tests never touch real DNS or the internet.
const lookups = (overrides: Partial<DetectionDeps> = {}) => ({
  resolveMx: vi.fn(async (_domain: string): Promise<string[]> => []),
  autoconfig: vi.fn(async (_domain: string) => undefined),
  resolveSrv: vi.fn(async (_name: string): Promise<Array<{ name: string; port: number }>> => []),
  ...overrides
});

describe('provider detection', () => {
  it('PRV-01 a known domain selects its profile without any lookup', async () => {
    const deps = lookups();
    const cases: Record<string, string> = {
      'you@yahoo.com': 'yahoo', 'you@ymail.com': 'yahoo', 'YOU@Yahoo.COM': 'yahoo', 'you@aol.com': 'aol',
      'you@icloud.com': 'icloud', 'you@me.com': 'icloud', 'you@fastmail.com': 'fastmail',
      'you@gmail.com': 'gmail', 'you@googlemail.com': 'gmail', 'you@zoho.com': 'zoho'
    };
    for (const [address, id] of Object.entries(cases)) {
      expect(await detectProvider(address, deps), address).toMatchObject({ kind: 'profile', via: 'domain', profile: { id } });
    }
    expect(deps.resolveMx).not.toHaveBeenCalled();
    expect(deps.autoconfig).not.toHaveBeenCalled();
    expect(deps.resolveSrv).not.toHaveBeenCalled();
  });

  it('PRV-02 a custom domain hosted by a known provider is recognised from its MX records', async () => {
    const cases: Record<string, [string, string]> = {
      'me@smallbiz.com': ['mta5.am0.yahoodns.net', 'yahoo'],
      'me@family.org': ['in1-smtp.messagingengine.com', 'fastmail'],
      'me@startup.io': ['ASPMX.L.GOOGLE.COM.', 'gmail'],
      'me@oldco.net': ['alt1.aspmx.l.googlemail.com', 'gmail'],
      'me@shop.co': ['mx.zoho.com', 'zoho'],
      'me@studio.dev': ['mx01.mail.icloud.com', 'icloud']
    };
    for (const [address, [mx, id]] of Object.entries(cases)) {
      const deps = lookups({ resolveMx: vi.fn(async () => [mx]) });
      expect(await detectProvider(address, deps), address).toMatchObject({ kind: 'profile', via: 'mx', profile: { id } });
      expect(deps.resolveMx).toHaveBeenCalledWith(address.split('@')[1]);
      expect(deps.autoconfig, address).not.toHaveBeenCalled();
    }
  });

  it('PRV-02 an MX host that only resembles a provider is not trusted', async () => {
    const deps = lookups({ resolveMx: vi.fn(async () => ['mx.notyahoodns.net', 'google.com.evil.example']) });
    expect(await detectProvider('me@lookalike.com', deps)).toMatchObject({ kind: 'needs-input' });
  });

  it('PRV-03 an unfamiliar host is set up from the domain autoconfig file', async () => {
    const imap = { host: 'imap.hostco.net', port: 993, tls: 'implicit' as const };
    const smtp = { host: 'smtp.hostco.net', port: 587, tls: 'starttls' as const };
    const deps = lookups({
      resolveMx: vi.fn(async () => ['mx.hostco.net']),
      autoconfig: vi.fn(async (_domain: string) => ({ imap, smtp }))
    });
    expect(await detectProvider('me@mybakery.com', deps)).toEqual({ kind: 'discovered', via: 'autoconfig', imap, smtp });
    expect(deps.autoconfig).toHaveBeenCalledWith('mybakery.com');
    expect(deps.resolveSrv).not.toHaveBeenCalled();
  });

  it('PRV-04 without an autoconfig file, the standard SRV records are used', async () => {
    const srv: Record<string, Array<{ name: string; port: number }>> = {
      '_imaps._tcp.mybakery.com': [{ name: 'mail.hostco.net.', port: 993 }],
      '_submission._tcp.mybakery.com': [{ name: 'Mail.HostCo.net', port: 587 }]
    };
    const deps = lookups({ resolveSrv: vi.fn(async (name: string) => srv[name] ?? []) });
    expect(await detectProvider('me@mybakery.com', deps)).toEqual({
      kind: 'discovered', via: 'srv',
      imap: { host: 'mail.hostco.net', port: 993, tls: 'implicit' },
      smtp: { host: 'mail.hostco.net', port: 587, tls: 'starttls' }
    });
  });

  it('PRV-04 SRV records must name both a mail server and a sending server', async () => {
    const onlyImap = lookups({ resolveSrv: vi.fn(async (name: string) =>
      name.startsWith('_imaps.') ? [{ name: 'mail.hostco.net', port: 993 }] : []) });
    expect(await detectProvider('me@mybakery.com', onlyImap)).toMatchObject({ kind: 'needs-input' });

    // RFC 2782: a target of "." means "this service is not offered here".
    const declined = lookups({ resolveSrv: vi.fn(async (name: string) =>
      name.startsWith('_imaps.') ? [{ name: '.', port: 0 }] : [{ name: 'smtp.hostco.net', port: 587 }]) });
    expect(await detectProvider('me@mybakery.com', declined)).toMatchObject({ kind: 'needs-input' });
  });

  it('PRV-05 when every lookup fails, setup asks instead of guessing', async () => {
    const notFound = () => Object.assign(new Error('queryMx ENOTFOUND nowhere.example'), { code: 'ENOTFOUND' });
    const deps = lookups({
      resolveMx: vi.fn(async () => { throw notFound(); }),
      autoconfig: vi.fn(async () => { throw new Error('fetch failed'); }),
      resolveSrv: vi.fn(async () => { throw notFound(); })
    });
    expect(await detectProvider('me@nowhere.example', deps)).toEqual({ kind: 'needs-input', domain: 'nowhere.example' });
    // Each source was still tried: one failure does not skip the next.
    expect(deps.autoconfig).toHaveBeenCalled();
    expect(deps.resolveSrv).toHaveBeenCalled();
  });
});

describe('provider capabilities', () => {
  const yahoo = profiles.find(profile => profile.id === 'yahoo')!;

  it('PRV-06 live capabilities override the profile, and the mismatch is recorded', () => {
    expect(yahoo.expectedCapabilities).toEqual(expect.arrayContaining(['MOVE', 'UIDPLUS']));
    // Capability names are case-insensitive in IMAP; unrelated ones are not compared.
    const live = ['IMAP4rev1', 'uidplus', 'SPECIAL-USE', 'IDLE'];
    expect(reconcileCapabilities(yahoo, live)).toEqual({
      capabilities: ['IMAP4REV1', 'UIDPLUS', 'SPECIAL-USE', 'IDLE'],
      mismatch: { missing: ['MOVE'], unexpected: ['SPECIAL-USE'] }
    });
    expect(reconcileCapabilities(yahoo, ['MOVE', 'UIDPLUS'])).toEqual({
      capabilities: ['MOVE', 'UIDPLUS'], mismatch: undefined
    });
  });

  it('PRV-08 an account with neither MOVE nor UIDPLUS is marked unsafe for moves', () => {
    expect(moveSafety(['IMAP4REV1', 'MOVE'])).toEqual({ safe: true });
    expect(moveSafety(['IMAP4REV1', 'UIDPLUS'])).toEqual({ safe: true });
    expect(moveSafety(['IMAP4REV1', 'MOVE', 'UIDPLUS'])).toEqual({ safe: true });

    const unsafe = moveSafety(['IMAP4REV1', 'IDLE']);
    expect(unsafe.safe).toBe(false);
    expect(unsafe.reason).toMatch(/can't move messages safely/);
    expect(unsafe.reason).toMatch(/Reading, searching and sending still work/);
  });
});

describe('launch profiles', () => {
  it('PRV-07 every launch profile has app-password guidance: page, button and prerequisites', () => {
    expect(profiles.map(profile => profile.id)).toEqual(['yahoo', 'aol', 'icloud', 'fastmail', 'gmail', 'zoho']);
    for (const profile of profiles) {
      const guide = profile.appPassword;
      expect(guide, profile.id).toBeDefined();
      expect(new URL(guide.page).protocol, profile.id).toBe('https:');
      expect(guide.button.trim(), profile.id).not.toBe('');
      expect(Array.isArray(guide.prerequisites), profile.id).toBe(true);
    }
    const byId = (id: string) => profiles.find(profile => profile.id === id)!.appPassword;
    expect(byId('yahoo')).toMatchObject({ page: 'https://login.yahoo.com/account/security', button: 'Generate app password' });
    expect(byId('gmail')).toMatchObject({ page: 'https://myaccount.google.com/apppasswords', prerequisites: ['2-Step Verification'] });
  });

  it('PRV-09 every launch profile names encrypted IMAP and SMTP servers', () => {
    const secureSmtp = (port: number, tls: string) => (port === 465 && tls === 'implicit') || (port === 587 && tls === 'starttls');
    for (const profile of profiles) {
      expect(profile.imap, profile.id).toMatchObject({ host: expect.stringMatching(/^[a-z0-9.-]+\.[a-z]+$/), port: 993, tls: 'implicit' });
      expect(profile.smtp?.host, profile.id).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
      expect(secureSmtp(profile.smtp.port, profile.smtp.tls), `${profile.id} smtp ${profile.smtp.port}/${profile.smtp.tls}`).toBe(true);
    }
    // Yahoo matches the settings v1 has been running in production.
    const yahoo = profiles.find(profile => profile.id === 'yahoo')!;
    expect([yahoo.imap, yahoo.smtp]).toEqual([
      { host: 'imap.mail.yahoo.com', port: 993, tls: 'implicit' },
      { host: 'smtp.mail.yahoo.com', port: 587, tls: 'starttls' }
    ]);
  });
});
