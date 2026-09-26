import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { EXTERNAL_IO_FORBIDDEN } from '../src/networkGuard.js';

// TK-01: the unit tier cannot reach the network. Loopback stays open, because
// the HTTP and SMTP tests run real servers on 127.0.0.1.
describe('TK-01 network guard', () => {
  it('refuses fetch to a host outside this machine', async () => {
    await expect(fetch('https://example.com/')).rejects.toMatchObject({ code: EXTERNAL_IO_FORBIDDEN });
  });

  it('refuses a raw socket to an address outside this machine', () => {
    let socket: net.Socket | undefined;
    try {
      expect(() => { socket = net.connect({ host: '203.0.113.10', port: 993 }); }).toThrow(EXTERNAL_IO_FORBIDDEN);
    } finally {
      socket?.destroy();
    }
  });

  it('still allows loopback connections', async () => {
    const server = net.createServer(connection => connection.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const client = net.connect({ host: '127.0.0.1', port });
        client.on('data', chunk => resolve(String(chunk)));
        client.on('error', reject);
      });
      expect(reply).toBe('ok');
    } finally {
      server.close();
    }
  });
});
