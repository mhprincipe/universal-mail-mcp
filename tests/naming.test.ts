import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

// No provider's name in the engine (added 2026-09-29, 2.4: it serves every
// provider). The code began as a Yahoo-only server; its folder and settings
// said so. Old settings keep working, so existing setups need nothing.
const base = { AUTH_MODE: 'builtin', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' };

describe('names', () => {
  it('ENG-28 the engine lives in src/mail/, not src/yahoo/ (added: 2.4)', () => {
    for (const file of ['imap.ts', 'mailService.ts', 'mime.ts']) expect(existsSync(new URL(`../src/mail/${file}`, import.meta.url)), file).toBe(true);
    expect(existsSync(new URL('../src/yahoo', import.meta.url))).toBe(false);
  });

  it('ENG-28 the settings are MAIL_ADDRESS and MAIL_APP_PASSWORD; the old YAHOO_ names still work, and the new ones win when both are given', () => {
    const current = loadConfig({ ...base, MAIL_ADDRESS: 'a@x.example', MAIL_APP_PASSWORD: 'app-password-1' });
    expect(current).toMatchObject({ MAIL_ADDRESS: 'a@x.example', MAIL_APP_PASSWORD: 'app-password-1' });
    expect(Object.keys(current).filter(k => k.startsWith('YAHOO_'))).toEqual([]);
    expect(loadConfig({ ...base, YAHOO_EMAIL: 'b@x.example', YAHOO_APP_PASSWORD: 'app-password-2' })).toMatchObject({ MAIL_ADDRESS: 'b@x.example', MAIL_APP_PASSWORD: 'app-password-2' });
    expect(loadConfig({ ...base, MAIL_ADDRESS: 'new@x.example', YAHOO_EMAIL: 'old@x.example', MAIL_APP_PASSWORD: 'new-password', YAHOO_APP_PASSWORD: 'old-password' }))
      .toMatchObject({ MAIL_ADDRESS: 'new@x.example', MAIL_APP_PASSWORD: 'new-password' });
  });
});
