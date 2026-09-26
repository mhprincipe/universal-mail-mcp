import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

// An app identifies itself by the https:// address of its published identity
// document (CIMD). The app chooses that address, so fetching it is the most
// dangerous thing the sign-in server does (design §6.5).

export type ClientDocument = { client_id: string; client_name?: string; redirect_uris: string[] };
export type DocumentDeps = {
  resolve(host: string): Promise<string[]>;
  // Connect to `address` (already vetted) while asking for `url`'s host.
  get(url: URL, address: string): Promise<{ status: number; body: string }>;
};
export const DOCUMENT_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 5_000 };

// A refusal carries a reason code for the log (SIG-80), never the input.
export class SigninRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Sign-in refused: ${reason}`);
    this.reason = reason;
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]
] as const) blocked.addSubnet(net, prefix, 'ipv6');

// Private, loopback, link-local, metadata (169.254.169.254, fd00:ec2::254),
// multicast, reserved and documentation ranges are all refused. BlockList
// checks IPv4-mapped IPv6 (::ffff:10.0.0.1) against the IPv4 rules itself.
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) return !blocked.check(address, 'ipv6');
  return false;
}

// Checked before any network activity: https, a trusted origin exactly, and
// nothing that could change where the request goes.
function trustedUrl(clientId: string, trusted: string[]): URL {
  let url: URL;
  try { url = new URL(clientId); } catch { throw new SigninRefusal('untrusted_origin'); }
  const clean = url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.port === '';
  if (!clean || !trusted.includes(url.origin)) throw new SigninRefusal('untrusted_origin');
  return url;
}

export async function fetchClientDocument(clientId: string, trusted: string[], deps: DocumentDeps): Promise<ClientDocument> {
  const url = trustedUrl(clientId, trusted);
  // Resolve first, vet every answer, then connect to a vetted address: a
  // second lookup can't swap in a private one (DNS rebinding).
  const addresses = await deps.resolve(url.hostname).catch(() => []);
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new SigninRefusal('unsafe_address');
  const response = await deps.get(url, addresses[0]!);
  // Anything but a plain 200 is refused; a redirect is never followed.
  if (response.status !== 200) throw new SigninRefusal('fetch_status');
  let doc: unknown;
  try { doc = JSON.parse(response.body); } catch { throw new SigninRefusal('document_invalid'); }
  const d = doc as Partial<ClientDocument>;
  const valid = d && d.client_id === clientId && Array.isArray(d.redirect_uris) && d.redirect_uris.length > 0
    && d.redirect_uris.every(uri => typeof uri === 'string')
    && (d.client_name === undefined || typeof d.client_name === 'string');
  if (!valid) throw new SigninRefusal('document_invalid');
  return { client_id: d.client_id!, ...(d.client_name !== undefined ? { client_name: d.client_name } : {}), redirect_uris: d.redirect_uris! };
}

// Exact string match: no normalising, no prefixes, no case folding.
export function redirectAllowed(doc: ClientDocument, redirectUri: string): boolean {
  return doc.redirect_uris.includes(redirectUri);
}

// The real fetch: to the vetted address, naming the real host (and, for
// https, checking its certificate). No redirects; size and time limits.
export function pinnedGet(url: URL, address: string, limits: typeof DOCUMENT_LIMITS, protocol: 'http' | 'https' = 'https'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const transport = protocol === 'https' ? https : http;
    const request = transport.request({
      host: address, port: url.port || (protocol === 'https' ? 443 : 80), path: `${url.pathname}${url.search}`, method: 'GET',
      headers: { Host: url.host, Accept: 'application/json' },
      ...(protocol === 'https' ? { servername: url.hostname } : {})
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.maxBytes) { fail('document_too_large'); return; }
        chunks.push(chunk);
      });
      response.on('end', () => { clearTimeout(timer); resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    const fail = (reason: string) => { clearTimeout(timer); request.destroy(); reject(new SigninRefusal(reason)); };
    const timer = setTimeout(() => fail('fetch_timeout'), limits.timeoutMs);
    request.on('error', () => fail('fetch_failed'));
    request.end();
  });
}
