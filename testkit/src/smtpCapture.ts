import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import type { ImapServer } from './imapServer.js';
import { connect } from './seed.js';
import { localhostTls } from './localhostTls.js';

export type Captured = { from: string; to: string[]; raw: Buffer };
export type SmtpCapture = { host: string; port: number; messages: Captured[]; stop(): Promise<void> };
export type CaptureOptions = {
  // File each delivery in this mailbox before confirming it, as Yahoo files
  // what you send in Sent.
  // times: file it more than once, as a misbehaving provider might.
  saveTo?: { server: ImapServer; mailbox: string; times?: number };
  // Take the message, then cut the connection before confirming it: the sender
  // can't know whether it went.
  dropAfterData?: boolean;
  // Accept only this password (any user); by default, any sign-in is accepted.
  password?: string;
  // Offer STARTTLS, with the test run's certificate for "localhost" (localhostTls.ts).
  starttls?: boolean;
  // Also offer XOAUTH2, as Microsoft does, accepting only this access token.
  accessToken?: string;
};

type Connection = { id: string; _socket: { destroy(): void } };

// A local SMTP server that accepts any sign-in and keeps each delivery: the
// envelope (who it really went to, Bcc included) and the exact bytes sent.
export async function startSmtpCapture(options: CaptureOptions = {}): Promise<SmtpCapture> {
  const messages: Captured[] = [];
  const save = async (raw: Buffer) => {
    if (!options.saveTo) return;
    const client = connect(options.saveTo.server);
    await client.connect();
    try {
      for (let i = 0; i < (options.saveTo.times ?? 1); i++) await client.append(options.saveTo.mailbox, raw, ['\\Seen']);
    } finally { await client.logout(); }
  };
  const tls = options.starttls ? await localhostTls() : undefined;
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: options.starttls ? [] : ['STARTTLS'],
    ...(tls ? { key: tls.key, cert: tls.cert } : {}),
    // Local and test-only: sign-in is allowed without encryption, unless
    // encryption is offered; then, like Yahoo, it is required first.
    allowInsecureAuth: !options.starttls,
    ...(options.accessToken !== undefined ? { authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'] } : {}),
    onAuth: (auth, _session, done) => {
      if (auth.method === 'XOAUTH2') {
        return auth.accessToken === options.accessToken ? done(null, { user: auth.username })
          : done(Object.assign(new Error('Invalid token'), { responseCode: 535 }));
      }
      return options.password !== undefined && auth.password !== options.password
        ? done(Object.assign(new Error('Invalid username or password'), { responseCode: 535 }))
        : done(null, { user: auth.username });
    },
    onData: (stream, session, done) => {
      const chunks: Buffer[] = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
        const raw = Buffer.concat(chunks);
        messages.push({ from, to: session.envelope.rcptTo.map(r => r.address), raw });
        if (options.dropAfterData) {
          // smtp-server internals: each connection has an id matching the session's.
          const connections = (server as unknown as { connections: Set<Connection> }).connections;
          const connection = [...connections].find(c => c.id === session.id);
          if (!connection) throw new Error('smtpCapture: could not find the connection to drop (smtp-server internals changed?)');
          connection._socket.destroy();
          return;
        }
        save(raw).then(() => done(), error => done(error));
      });
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    host: '127.0.0.1',
    port: ((server as unknown as { server: { address(): AddressInfo } }).server.address()).port,
    messages,
    stop: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}
