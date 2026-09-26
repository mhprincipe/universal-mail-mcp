import selfsigned from 'selfsigned';

// A certificate for "localhost", made fresh for each test run so it can never
// expire under us (smtp-server's built-in one expired in February 2025).
// Tests trust it by passing { ca: cert, servername: 'localhost' }.
export type LocalhostTls = { key: string; cert: string };

let made: Promise<LocalhostTls> | undefined;

export function localhostTls(): Promise<LocalhostTls> {
  made ??= Promise.resolve(selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]
  })).then(pems => ({ key: pems.private, cert: pems.cert }));
  return made;
}
