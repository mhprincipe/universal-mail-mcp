import { randomBytes } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { profiles, type ProfileName, type SpecialFolders } from './profiles.js';

export type ImapServer = { host: string; port: number; user: string; password: string; stop(): Promise<void> };

const IMAGE = 'dovecot/dovecot:2.3.21';

function mailboxes(folders: SpecialFolders): string {
  const roles: Array<[keyof SpecialFolders, string]> = [
    ['sent', '\\Sent'], ['drafts', '\\Drafts'], ['archive', '\\Archive'], ['junk', '\\Junk'], ['trash', '\\Trash'], ['all', '\\All']
  ];
  return roles.filter(([role]) => folders[role]).map(([role, flag]) => `
  mailbox "${folders[role]}" {
    special_use = ${flag}
    auto = create
  }`).join('');
}

function config(password: string, capabilities: string[], folders: SpecialFolders, token = false): string {
  return `
protocols = imap
imap_capability = ${capabilities.join(' ')}
listen = *
log_path = /dev/stderr
ssl = no
disable_plaintext_auth = no
auth_mechanisms = ${token ? 'xoauth2' : 'plain login'}
mail_location = maildir:~/Maildir
first_valid_uid = 1000
passdb {
  driver = static
  args = password=${password}
}
userdb {
  driver = static
  args = uid=1000 gid=1000 home=/tmp/mail/%u
}
namespace inbox {
  inbox = yes
  separator = /${mailboxes(folders)}
}
`;
}

// Dovecot implements MOVE and UIDPLUS either way; what a profile controls is
// what it advertises, which is exactly what the engine decides on.
export async function startImapServer(profile: ProfileName): Promise<ImapServer> {
  const password = randomBytes(12).toString('hex');
  const container: StartedTestContainer = await new GenericContainer(IMAGE)
    .withCopyContentToContainer([{ content: config(password, profiles[profile].advertises, profiles[profile].folders, profiles[profile].token), target: '/etc/dovecot/dovecot.conf' }])
    .withExposedPorts(143)
    .withWaitStrategy(Wait.forLogMessage(/starting up for imap/))
    .start();
  return {
    host: container.getHost(),
    port: container.getMappedPort(143),
    // An address, because the mail service signs in with the account's email.
    user: 'tester@example.invalid',
    password,
    stop: async () => { await container.stop(); }
  };
}
