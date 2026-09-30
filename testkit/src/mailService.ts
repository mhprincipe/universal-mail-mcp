import { loadConfig } from '../../src/config.js';
import { MailService, type MailServiceOptions } from '../../src/mail/mailService.js';
import type { ImapServer } from './imapServer.js';

// The product's own mail service, pointed at a test mail server — or at a fault
// proxy in front of one: pass the proxy's host and port with the server's login.
export function mailServiceFor(
  target: Pick<ImapServer, 'host' | 'port' | 'user' | 'password'>,
  options: MailServiceOptions = {}
): MailService {
  const config = loadConfig({
    YAHOO_EMAIL: target.user,
    YAHOO_APP_PASSWORD: target.password,
    MCP_ACCESS_SECRET: 'protocol-tests-only-not-a-secret',
    IMAP_HOST: target.host,
    IMAP_PORT: String(target.port),
    // The test server is local and unencrypted; config refuses this for any other host.
    IMAP_TLS: 'none',
    SMTP_HOST: '127.0.0.1'
  });
  return new MailService(config, options);
}
