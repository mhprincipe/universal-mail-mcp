import { describe, expect, it } from 'vitest';
import { createAccounts } from '../src/accounts.js';

const accounts = createAccounts([
  { name: 'personal', address: 'you@yahoo.com' },
  { name: 'fleet', address: 'fleet@gmail.com' }
]);

describe('accounts', () => {
  it('ENG-01 accounts are looked up by name', () => {
    expect(accounts.get('fleet')).toMatchObject({ name: 'fleet', address: 'fleet@gmail.com' });
  });

  it('ENG-02 an unknown account name fails with MAIL-ACCOUNT-UNKNOWN and lists the valid names', () => {
    let failure: unknown;
    try { accounts.get('work'); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'MAIL-ACCOUNT-UNKNOWN', status: 'FAILED', details: { valid: ['fleet', 'personal'] } });
    expect((failure as Error).message).toContain('fleet, personal');
  });

  it('ENG-03 account can be omitted when the caller can reach exactly one account', () => {
    expect(accounts.resolve(undefined, ['personal'])).toMatchObject({ name: 'personal', address: 'you@yahoo.com' });
  });

  it('ENG-04 account is required when the caller can reach more than one, and the error lists them', () => {
    let failure: unknown;
    try { accounts.resolve(undefined, ['personal', 'fleet']); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'MAIL-ACCOUNT-REQUIRED', status: 'FAILED', details: { choices: ['fleet', 'personal'] } });
    expect((failure as Error).message).toContain('fleet, personal');
  });

  it('ENG-11 a named account the caller can reach is used', () => {
    expect(accounts.resolve('fleet', ['personal', 'fleet'])).toMatchObject({ name: 'fleet', address: 'fleet@gmail.com' });
  });

  it("ENG-12 naming an account the caller can't reach is refused without revealing the others", () => {
    let failure: unknown;
    try { accounts.resolve('fleet', ['personal']); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'MAIL-ACCOUNT-UNKNOWN', details: { valid: ['personal'] } });
    expect((failure as Error).message).toContain('It can use: personal.');
  });
});
