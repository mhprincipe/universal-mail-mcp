import net from 'node:net';

export type FaultRules = { dropAfter?: string; blankHeaderSearch?: boolean; delay?: { command: string; ms: number } };
export type FaultProxy = {
  host: string; port: number;
  // Every command name the client sent, in order ("UID MOVE", "LOGIN"...).
  commands(): string[];
  // Every command line, in order, without its tag; sign-in arguments are blanked.
  lines(): string[];
  // Change the faults for commands sent from now on.
  setRules(rules: FaultRules): void;
  stop(): Promise<void>;
};

// Splits an IMAP byte stream into lines and literals. After a line ending in
// {n} (or {n+}) the next n bytes are raw data — a message body, say — and must
// never be read as protocol, however much a line of it looks like a reply.
class ImapStream {
  private buffer = Buffer.alloc(0);
  private literal = 0;
  constructor(private onLine: (line: Buffer) => void, private onLiteral: (bytes: Buffer) => void) {}
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      if (this.literal > 0) {
        const take = Math.min(this.literal, this.buffer.length);
        this.onLiteral(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.literal -= take;
        continue;
      }
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = this.buffer.subarray(0, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
      const literal = /\{(\d+)\+?\}\r\n$/.exec(line.toString('latin1'));
      if (literal) this.literal = Number(literal[1]);
      this.onLine(line);
    }
  }
}

// "a7 UID MOVE 3 Archive" → { tag: "a7", name: "UID MOVE" }
function parseCommand(line: Buffer): { tag: string; name: string } | undefined {
  const match = /^(\S+) (UID \S+|\S+)/i.exec(line.toString('latin1'));
  return match ? { tag: match[1]!, name: match[2]!.toUpperCase() } : undefined;
}

export async function startFaultProxy(target: { host: string; port: number }, rules: FaultRules = {}): Promise<FaultProxy> {
  const sockets = new Set<net.Socket>();
  const log: string[] = [];
  const lines: string[] = [];
  let current: FaultRules = { ...rules };
  const server = net.createServer(client => {
    const upstream = net.connect({ host: target.host, port: target.port });
    const cut = () => { client.destroy(); upstream.destroy(); };
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', cut);
    }
    let dropTag: string | undefined;
    let headerSearchTag: string | undefined;
    let delayTag: string | undefined;

    // Every write to the client goes through one queue, so a delayed reply
    // holds back everything after it and order is never changed.
    let queue = Promise.resolve();
    const send = (data: Buffer | string, waitMs = 0) => {
      queue = queue.then(async () => {
        if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
        if (!client.destroyed) client.write(data);
      });
    };

    const fromClient = new ImapStream(line => {
      const command = parseCommand(line);
      if (command) {
        log.push(command.name);
        const text = line.toString('utf8').trim().replace(/^\S+ /, '');
        lines.push(/^(LOGIN|AUTHENTICATE)\b/i.test(text) ? `${command.name} [blanked]` : text);
      }
      if (command && current.dropAfter && command.name === current.dropAfter.toUpperCase()) dropTag = command.tag;
      if (command && current.blankHeaderSearch && /^(UID )?SEARCH$/.test(command.name) && / HEADER /i.test(line.toString('latin1'))) headerSearchTag = command.tag;
      if (command && current.delay && command.name === current.delay.command.toUpperCase()) delayTag = command.tag;
      upstream.write(line);
    }, bytes => upstream.write(bytes));

    const fromServer = new ImapStream(line => {
      const text = line.toString('latin1');
      // The server has carried the command out; the client never hears so.
      if (dropTag && text.startsWith(`${dropTag} `)) return cut();
      if (delayTag && text.startsWith(`${delayTag} `)) {
        delayTag = undefined;
        return send(line, current.delay!.ms);
      }
      if (headerSearchTag) {
        // Yahoo answers HEADER searches with nothing, even when headers match.
        if (text.startsWith(`${headerSearchTag} `)) headerSearchTag = undefined;
        else if (/^\* SEARCH\b/i.test(text)) return send('* SEARCH\r\n');
        else if (/^\* ESEARCH\b/i.test(text)) return send(`${text.replace(/^(\* ESEARCH(?: \(TAG "[^"]*"\))?(?: UID)?).*$/is, '$1')}\r\n`);
      }
      send(line);
    }, bytes => send(bytes));

    client.on('data', chunk => fromClient.push(chunk));
    upstream.on('data', chunk => fromServer.push(chunk));
    client.on('end', () => upstream.end());
    upstream.on('end', () => client.end());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    host: '127.0.0.1',
    port: (server.address() as net.AddressInfo).port,
    commands: () => [...log],
    lines: () => [...lines],
    setRules: next => { current = { ...next }; },
    stop: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    })
  };
}
