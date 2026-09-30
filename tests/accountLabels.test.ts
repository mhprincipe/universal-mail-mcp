import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMailRouter } from '../src/multiMail.js';
import { buildMcpServer } from '../src/tools.js';

// Account names with their provider (added 2.4.3, found live): the Gmail
// account was named "google", and the AI asked for "gmail" first. The names
// stay what the owner chose; the provider is said beside them.
const account = (name: string, address: string, host: string) => ({
  name, config: loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: address, MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: host, SMTP_HOST: host })
});
const router = () => createMailRouter([
  account('google', 'you@gmail.com', 'imap.gmail.com'),
  // Known by its mail server, whatever the address.
  account('yahoo', 'me@home.example', 'imap.mail.yahoo.com'),
  // A provider found by its own domain's settings: no label, just the name.
  account('work', 'me@company.example', 'mail.company.example')
]);
let client: Client | undefined;
afterEach(async () => { await client?.close(); client = undefined; });

describe('account names with their provider', () => {
  it('ENG-29 the tools describe each account with its provider; one it can\'t tell is just its name', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(router()).connect(serverSide);
    client = new Client({ name: 'labels', version: '1' });
    await client.connect(clientSide);
    const listFolders = (await client.listTools()).tools.find(t => t.name === 'list_folders')!;
    expect((listFolders.inputSchema as any).properties.account.description).toBe('Which email account: google (Gmail), yahoo (Yahoo Mail), work. Needed only when there is more than one.');
  });

  it('ENG-29 the refusals name them the same way; the names to use stay the plain ones', () => {
    const mail = router();
    let error: any;
    try { mail.service(undefined, 'read'); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'MAIL-ACCOUNT-REQUIRED', message: 'Say which account to use: google (Gmail), work, yahoo (Yahoo Mail).', details: { choices: ['google', 'work', 'yahoo'] } });
    try { mail.service('gmail', 'read'); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'MAIL-ACCOUNT-UNKNOWN', details: { valid: ['google', 'work', 'yahoo'] } });
    expect(error.message).toContain('It can use: google (Gmail), work, yahoo (Yahoo Mail).');
  });
});

describe('telling the provider', () => {
  it('ENG-29 by the mail server first, else by the address\'s domain; neither known, nothing (and no address at all is no error)', async () => {
    const { providerName } = await import('../src/providers.js');
    expect(providerName('me@home.example', 'imap.mail.yahoo.com')).toBe('Yahoo Mail');
    expect(providerName('you@gmail.com', 'imap.googlemail.com')).toBe('Gmail');
    expect(providerName('me@company.example', 'mail.company.example')).toBeUndefined();
    expect(providerName(undefined, undefined)).toBeUndefined();
  });
});
