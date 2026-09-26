import { createServer, type Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { MailService } from '../src/yahoo/mailService.js';
import { loadConfig } from '../src/config.js';

afterEach(() => vi.restoreAllMocks());

// A minimal SMTP server on this machine that offers no encryption, and cuts the
// connection after receiving a message, before confirming it.
async function fakeSmtp() {
  const stats = { connections: 0, deliveries: 0 };
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    stats.connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('220 localhost test SMTP\r\n');
    let buffer = ''; let data = false;
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const at = buffer.indexOf('\r\n'); const line = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        if (data) { if (line === '.') { stats.deliveries++; socket.destroy(); } continue; }
        if (line.startsWith('EHLO')) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (line.startsWith('AUTH')) socket.write('235 authenticated\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) socket.write('250 ok\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 continue\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('502 command not implemented\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  return {
    stats,
    service: (env: Record<string, string> = {}) => new MailService(loadConfig({
      YAHOO_EMAIL: 'dummy@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(address.port), SENT_COPY_MODE: 'append', ...env
    })),
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

it('a real SMTP DATA disconnect produces UNKNOWN with exactly one delivery attempt', async () => {
  const smtp = await fakeSmtp();
  try {
    const service = smtp.service({ SMTP_TLS: 'none' });
    const append = vi.spyOn(service.imap, 'append');
    await expect(service.sendEmail({ to: ['dummy@example.invalid'], subject: 'Local fault test', text: 'dummy' })).rejects.toMatchObject({ status: 'UNKNOWN', code: 'SEND_STATUS_UNKNOWN' });
    expect(smtp.stats).toEqual({ connections: 1, deliveries: 1 }); expect(append).not.toHaveBeenCalled();
  } finally { await smtp.stop(); }
}, 10000);

it('ENG-15 a server that will not encrypt gets nothing, and the answer says so plainly', async () => {
  const smtp = await fakeSmtp();
  try {
    // Encryption is required by default, and this server offers none.
    await expect(smtp.service().sendEmail({ to: ['dummy@example.invalid'], subject: 'secret', text: 'dummy' })).rejects.toMatchObject({
      code: 'SMTP_ENCRYPTION_UNAVAILABLE', status: 'FAILED',
      message: "The mail server wouldn't encrypt the connection, so nothing was sent."
    });
    expect(smtp.stats.deliveries).toBe(0);
  } finally { await smtp.stop(); }
}, 10000);
