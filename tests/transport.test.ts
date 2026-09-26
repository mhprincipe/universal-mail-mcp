import { describe, expect, it } from 'vitest';
import { imapTransport, loadConfig, smtpTransport } from '../src/config.js';

const base = { YAHOO_EMAIL: 'dummy@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars' };

describe('mail transport', () => {
  it('ENG-14 an unencrypted connection is allowed only to this machine', () => {
    expect(() => loadConfig({ ...base, IMAP_HOST: 'imap.example.com', IMAP_TLS: 'none' })).toThrow(/only to this machine/);
    expect(() => loadConfig({ ...base, IMAP_HOST: '10.0.0.5', IMAP_TLS: 'none' })).toThrow(/only to this machine/);
    for (const host of ['localhost', '127.0.0.1', '::1']) {
      expect(loadConfig({ ...base, IMAP_HOST: host, IMAP_TLS: 'none' }).IMAP_TLS, host).toBe('none');
    }
    // Encrypted by default.
    expect(loadConfig(base).IMAP_TLS).toBe('implicit');
  });

  it('ENG-14 each transport setting maps to the matching connection options', () => {
    const transport = (IMAP_TLS: string) => imapTransport(loadConfig({ ...base, IMAP_HOST: '127.0.0.1', IMAP_TLS }));
    expect(transport('implicit')).toEqual({ secure: true, doSTARTTLS: undefined });
    expect(transport('starttls')).toEqual({ secure: false, doSTARTTLS: true });
    expect(transport('none')).toEqual({ secure: false, doSTARTTLS: false });
  });

  it('ENG-15 sending is always encrypted, whatever the port; unencrypted only to this machine', () => {
    const smtp = (env: Record<string, string>) => smtpTransport(loadConfig({ ...base, ...env }));
    // v1's production settings are unchanged.
    expect(smtp({ SMTP_PORT: '587' })).toEqual({ secure: false, requireTLS: true, ignoreTLS: false });
    expect(smtp({ SMTP_PORT: '465' })).toEqual({ secure: true, requireTLS: false, ignoreTLS: false });
    // Any other port: encryption required, never merely offered. (v1 would
    // have sent in whatever mode the server chose.)
    expect(smtp({ SMTP_PORT: '2525' })).toEqual({ secure: false, requireTLS: true, ignoreTLS: false });
    expect(smtp({ SMTP_PORT: '25' })).toEqual({ secure: false, requireTLS: true, ignoreTLS: false });

    expect(() => loadConfig({ ...base, SMTP_HOST: 'smtp.example.com', SMTP_TLS: 'none' })).toThrow(/only to this machine/);
    expect(smtp({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_TLS: 'none' })).toEqual({ secure: false, requireTLS: false, ignoreTLS: true });
  });
});
