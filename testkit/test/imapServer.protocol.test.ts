import { describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { startImapServer } from '../src/imapServer.js';
import { controlledCapabilities, profiles, type ProfileName } from '../src/profiles.js';

// TK-02: a real mail server starts with a named profile and advertises exactly
// that profile's capabilities — so a "hostile" test really faces a server
// without safe moves, instead of trusting a mock to pretend.
describe('TK-02 IMAP server profiles', () => {
  it.each(Object.keys(profiles) as ProfileName[])('%s advertises exactly its profile capabilities', async name => {
    const server = await startImapServer(name);
    try {
      const client = new ImapFlow({ host: server.host, port: server.port, secure: false, auth: { user: server.user, pass: server.password }, logger: false });
      await client.connect();
      const advertised = controlledCapabilities.filter(capability => client.capabilities.has(capability));
      await client.logout();
      expect(advertised).toEqual(controlledCapabilities.filter(capability => profiles[name].advertises.includes(capability)));
    } finally {
      await server.stop();
    }
  });
});
