import { afterEach, describe, expect, it, vi } from 'vitest';
import { cautionsFor } from '../src/cautions.js';
import { startToolFixture } from '../testkit/src/toolFixture.js';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/mail/imap.js';

// Scam warnings (added 2026-09-29, principle 3: it protects people from the
// mail itself). A message whose sender looks like someone it isn't carries
// plain-language cautions the AI is told to pass on before acting on it.
const from = (address: string, name?: string) => [{ ...(name ? { name } : {}), address }];

describe('scam warnings', () => {
  it('SCM-01 a name that claims a well-known company, from an address that isn\'t theirs (added: scam warnings)', () => {
    expect(cautionsFor({ from: from('security@paypal-verify.net', 'PayPal') })).toEqual([
      expect.stringMatching(/name says PayPal.*paypal-verify\.net/)
    ]);
    expect(cautionsFor({ from: from('help@gmail.com', 'Chase Bank Alerts') })[0]).toMatch(/Chase/);
    expect(cautionsFor({ from: from('noreply@irs-refunds.org', 'IRS') })[0]).toMatch(/IRS/);
  });

  it('SCM-01 a name that shows one email address while the mail comes from another', () => {
    expect(cautionsFor({ from: from('attacker@evil.example', 'service@paypal.com') })).toEqual([
      expect.stringMatching(/shows service@paypal\.com.*attacker@evil\.example/)
    ]);
  });

  it('SCM-02 look-alike domains: one character off a well-known one, or disguised letters (punycode)', () => {
    expect(cautionsFor({ from: from('billing@paypa1.com') })[0]).toMatch(/paypa1\.com.*looks like paypal\.com/);
    expect(cautionsFor({ from: from('orders@arnazon.com') })[0]).toMatch(/looks like amazon\.com/);
    expect(cautionsFor({ from: from('it@micros0ft.com') })[0]).toMatch(/looks like microsoft\.com/);
    expect(cautionsFor({ from: from('support@xn--pple-43d.com') })[0]).toMatch(/disguised|unusual characters/i);
  });

  it('SCM-03 replies that would go somewhere other than the sender\'s own domain', () => {
    expect(cautionsFor({ from: from('ceo@mycompany.example', 'The CEO'), replyTo: from('ceo.private@gmail.com') })).toEqual([
      expect.stringMatching(/Replies would go to ceo\.private@gmail\.com/)
    ]);
  });

  it('SCM-04 no false alarm on ordinary mail: the real companies, their mail services\' subdomains, friends, newsletters replying on their own domain', () => {
    const ordinary = [
      { from: from('service@paypal.com', 'PayPal') },
      { from: from('no.reply.alerts@chase.com', 'Chase') },
      { from: from('alerts@alertsp.chase.com', 'Chase Bank Alerts') },
      { from: from('shipment-tracking@amazon.com', 'Amazon.com') },
      { from: from('order-update@amazon.co.uk', 'Amazon') },
      { from: from('no-reply@accounts.google.com', 'Google') },
      { from: from('noreply@email.apple.com', 'Apple') },
      { from: from('info@account.netflix.com', 'Netflix') },
      { from: from('dse@docusign.net', 'DocuSign') },
      { from: from('friend@example.invalid', 'Sam Smith') },
      { from: from('news@brand.example', 'Brand News'), replyTo: from('support@brand.example') },
      { from: from('alerts@mail.bank.example', 'My Bank'), replyTo: from('help@bank.example') },
      { from: from('someone@example.invalid', 'someone@example.invalid') },
      { from: from('jane@yahoo.com', 'Jane (Apple Hill Farm)') },
      // Honest neighbours of short company names.
      { from: from('hello@ample.com', 'Ample') },
      { from: from('jobs@apply.com') }
    ];
    for (const message of ordinary) expect(cautionsFor(message), JSON.stringify(message)).toEqual([]);
  });
});

describe('scam warnings, safely', () => {
  it('SCM-06 a hostile sender name (thousands of @s, or a long run with no spaces) is checked in a moment, not seconds: it runs on the main thread (added: security review, 2.4)', () => {
    const hostile = ['@'.repeat(5000), `${'a@'.repeat(2500)}x`, `${'x@'.repeat(1200)}.com`, `${'a'.repeat(3000)}@${'b'.repeat(3000)}.co`];
    for (const name of hostile) {
      const started = performance.now();
      cautionsFor({ from: [{ name, address: 'someone@example.invalid' }] });
      expect(performance.now() - started, name.slice(0, 20)).toBeLessThan(100);
    }
    // Still sees an address in an ordinary name.
    expect(cautionsFor({ from: [{ name: 'Billing <service@paypal.com>', address: 'x@evil.example' }] })[0]).toMatch(/shows service@paypal\.com/);
  });
});

describe('scam warnings in the tools', () => {
  let f: Awaited<ReturnType<typeof startToolFixture>> | undefined;
  afterEach(async () => { await f?.stop(); f = undefined; });

  it('SCM-05 search results and an opened email carry the cautions, and the tools say to pass them on (added: scam warnings)', async () => {
    f = await startToolFixture();
    const raw = Buffer.from([
      'From: "PayPal" <security@paypal-verify.net>', 'To: self@example.invalid', 'Subject: Your account is limited',
      'Message-ID: <scam@fixture.invalid>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Click here.'
    ].join('\r\n'));
    const { uid } = await f.seedRaw('INBOX', raw);
    const email = (await f.call('get_email', { mailbox: 'INBOX', uid })).result.data;
    expect(email.cautions).toEqual([expect.stringMatching(/PayPal/)]);
    const tools = await f.tools();
    for (const name of ['get_email', 'search_email']) expect(tools.find(t => t.name === name)!.description).toMatch(/cautions/i);
  });

  it('SCM-05 a search result carries them too, from the envelope the server sends', async () => {
    const gateway = new ImapGateway(loadConfig({ AUTH_MODE: 'builtin', YAHOO_EMAIL: 'me@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' }));
    const client = {
      getMailboxLock: async () => ({ release: () => undefined }),
      fetchOne: async () => ({ uid: 3, flags: new Set(), size: 10, envelope: { messageId: '<m@x>', from: [{ name: 'Netflix', address: 'billing@netfIix-support.example' }], replyTo: [] } })
    };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as never));
    expect((await gateway.fetchSummary('INBOX', 3)).cautions).toEqual([expect.stringMatching(/name says Netflix/)]);
    const clean = { ...client, fetchOne: async () => ({ uid: 4, flags: new Set(), size: 10, envelope: { messageId: '<n@x>', from: [{ name: 'Netflix', address: 'info@account.netflix.com' }] } }) };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(clean as never));
    expect(await gateway.fetchSummary('INBOX', 4)).not.toHaveProperty('cautions');
  });
});

describe('more companies people are impersonated as', () => {
  it('SCM-07 insurers, banks, lenders, credit bureaus, phone companies, shops and government services, found live: "Liberty Mutual Team" sent from an unrelated domain (added: 2.4.2)', () => {
    const claims: Array<[string, string, RegExp]> = [
      ['news@ses.trivia-daily.example', 'Liberty Mutual Team', /name says Liberty Mutual.*trivia-daily\.example/],
      ['quotes@save-now.example', 'Progressive Insurance', /Progressive/],
      ['claims@mail-help.example', 'GEICO', /GEICO/],
      ['agent@claims.example', 'State Farm', /State Farm/],
      ['member@verify.example', 'USAA', /USAA/],
      ['notice@billing.example', 'AT&T', /AT&T/],
      ['alerts@tmo-billing.example', 'T-Mobile', /T-Mobile/],
      ['report@credit-check.example', 'Experian', /Experian/],
      ['benefits@gov-help.example', 'Social Security Administration', /Social Security/],
      ['orders@deals.example', 'Walmart', /Walmart/],
      ['refund@taxes.example', 'TurboTax', /TurboTax/]
    ];
    for (const [address, name, words] of claims) expect(cautionsFor({ from: from(address, name) })[0], name).toMatch(words);
  });

  it('SCM-07 the same companies from their own addresses stay quiet, and names that only share a word with one aren\'t claims', () => {
    const ordinary = [
      { from: from('noreply@email.libertymutual.com', 'Liberty Mutual Insurance') },
      { from: from('info@email.progressive.com', 'Progressive') },
      { from: from('geico@email.geico.com', 'GEICO') },
      { from: from('no-reply@statefarm.com', 'State Farm') },
      { from: from('usaa.customer.service@mailcenter.usaa.com', 'USAA') },
      { from: from('att@emaildl.att-mail.com', 'AT&T') },
      { from: from('noreply@t-mobile.com', 'T-Mobile') },
      { from: from('alerts@experian.com', 'Experian') },
      { from: from('noreply@ssa.gov', 'Social Security Administration') },
      { from: from('help@walmart.com', 'Walmart') },
      { from: from('turbotax@intuit.com', 'TurboTax') },
      // Only a word in common with a company name.
      { from: from('editor@pwa.example', 'Progressive Web Apps Weekly') },
      { from: from('market@farmstand.example', 'Farmers Market News') },
      { from: from('hello@discovery.com', 'Discovery') },
      { from: from('team@trust.example', 'Trust & Safety') }
    ];
    for (const message of ordinary) expect(cautionsFor(message), JSON.stringify(message)).toEqual([]);
  });
});
