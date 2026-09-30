import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startProduct, type Product } from '../testkit/src/product.js';
import { seed } from '../testkit/src/seed.js';

// First-time recipients on a real mail server: "have I written to them
// before" is a search of the account's own Sent folder (To or Cc).
describe('first-time recipients on a real mail server', () => {
  let p: Product;
  beforeAll(async () => { p = await startProduct('yahoo-like'); });
  afterAll(async () => { await p?.stop(); });

  it('RCP-04 someone in Sent (To or Cc) is known; a stranger is held until confirmed (added: first-time recipients)', async () => {
    await seed(p.server, { messages: [
      { mailbox: 'Sent', subject: 'earlier', from: p.server.user, to: 'friend@example.invalid' },
      { mailbox: 'Sent', subject: 'copied', from: p.server.user, to: 'someone@example.invalid', headers: { Cc: 'colleague@example.invalid' } },
      // Planted: someone else's message in Sent doesn't make its recipient known.
      { mailbox: 'Sent', subject: 'planted', from: 'attacker@evil.example', to: 'attacker@evil.example' }
    ] });
    expect((await p.call('send_email', { to: ['Friend@Example.invalid'], subject: 'again', text: 'hi' })).result.ok).toBe(true);
    expect((await p.call('send_email', { to: ['colleague@example.invalid'], subject: 'hi', text: 'hi' })).result.ok).toBe(true);
    expect((await p.call('send_email', { to: ['attacker@evil.example'], subject: 'x', text: 'x' })).result).toMatchObject({ code: 'MAIL-NEW-RECIPIENT' });
    const held = await p.call('send_email', { to: ['stranger@elsewhere.example'], subject: 'hello', text: 'hi' });
    expect(held.result).toMatchObject({ ok: false, code: 'MAIL-NEW-RECIPIENT', data: { newRecipients: ['stranger@elsewhere.example'] } });
    const deliveries = p.smtp.messages.length;
    expect((await p.call('send_email', { to: ['stranger@elsewhere.example'], subject: 'hello', text: 'hi', newRecipientsConfirmed: true })).result.ok).toBe(true);
    expect(p.smtp.messages.length).toBe(deliveries + 1);
  });
});
