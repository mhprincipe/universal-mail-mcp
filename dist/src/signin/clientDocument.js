import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
export const DOCUMENT_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 5_000 };
// A refusal carries a reason code for the log (SIG-80), never the input.
export class SigninRefusal extends Error {
    reason;
    constructor(reason) {
        super(`Sign-in refused: ${reason}`);
        this.reason = reason;
    }
}
const blocked = new BlockList();
for (const [net, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4]
])
    blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]
])
    blocked.addSubnet(net, prefix, 'ipv6');
// Private, loopback, link-local, metadata (169.254.169.254, fd00:ec2::254),
// multicast, reserved and documentation ranges are all refused. BlockList
// checks IPv4-mapped IPv6 (::ffff:10.0.0.1) against the IPv4 rules itself.
export function isPublicAddress(address) {
    const family = isIP(address);
    if (family === 4)
        return !blocked.check(address, 'ipv4');
    if (family === 6)
        return !blocked.check(address, 'ipv6');
    return false;
}
// Checked before any network activity: https, a trusted origin exactly, and
// nothing that could change where the request goes.
function trustedUrl(clientId, trusted) {
    let url;
    try {
        url = new URL(clientId);
    }
    catch {
        throw new SigninRefusal('untrusted_origin');
    }
    const clean = url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.port === '';
    if (!clean || !trusted.includes(url.origin))
        throw new SigninRefusal('untrusted_origin');
    return url;
}
async function fetchJson(url, deps) {
    // Resolve first, vet every answer, then connect to a vetted address: a
    // second lookup can't swap in a private one (DNS rebinding).
    const addresses = await deps.resolve(url.hostname).catch(() => []);
    if (!addresses.length || !addresses.every(isPublicAddress))
        throw new SigninRefusal('unsafe_address');
    const response = await deps.get(url, addresses[0]);
    // Anything but a plain 200 is refused; a redirect is never followed.
    if (response.status !== 200)
        throw new SigninRefusal('fetch_status');
    try {
        return JSON.parse(response.body);
    }
    catch {
        throw new SigninRefusal('document_invalid');
    }
}
export async function fetchClientDocument(clientId, trusted, deps) {
    const d = await fetchJson(trustedUrl(clientId, trusted), deps);
    const valid = d && d.client_id === clientId && Array.isArray(d.redirect_uris) && d.redirect_uris.length > 0
        && d.redirect_uris.every(uri => typeof uri === 'string')
        && (d.client_name === undefined || typeof d.client_name === 'string')
        && (d.jwks_uri === undefined || typeof d.jwks_uri === 'string');
    if (!valid)
        throw new SigninRefusal('document_invalid');
    return {
        client_id: d.client_id, ...(d.client_name !== undefined ? { client_name: d.client_name } : {}), redirect_uris: d.redirect_uris,
        ...(d.jwks_uri !== undefined ? { jwks_uri: d.jwks_uri } : {})
    };
}
// The public keys an app signs with (private_key_jwt), from the address its
// own document names, which must be on the app's own origin: a document can't
// point the check at keys someone else holds.
export async function fetchClientKeys(doc, trusted, deps) {
    if (!doc.jwks_uri)
        throw new SigninRefusal('no_client_keys');
    const url = trustedUrl(doc.jwks_uri, trusted);
    if (url.origin !== new URL(doc.client_id).origin)
        throw new SigninRefusal('untrusted_origin');
    const set = await fetchJson(url, deps);
    if (!set || !Array.isArray(set.keys) || !set.keys.every(k => k && typeof k === 'object'))
        throw new SigninRefusal('document_invalid');
    return { keys: set.keys };
}
// Exact string match: no normalising, no prefixes, no case folding.
export function redirectAllowed(doc, redirectUri) {
    return doc.redirect_uris.includes(redirectUri);
}
// The real fetch: to the vetted address, naming the real host (and, for
// https, checking its certificate). No redirects; size and time limits.
export function pinnedGet(url, address, limits, protocol = 'https') {
    return new Promise((resolve, reject) => {
        const transport = protocol === 'https' ? https : http;
        const request = transport.request({
            host: address, port: url.port || (protocol === 'https' ? 443 : 80), path: `${url.pathname}${url.search}`, method: 'GET',
            headers: { Host: url.host, Accept: 'application/json' },
            ...(protocol === 'https' ? { servername: url.hostname } : {})
        }, response => {
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > limits.maxBytes) {
                    fail('document_too_large');
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => { clearTimeout(timer); resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); });
        });
        const fail = (reason) => { clearTimeout(timer); request.destroy(); reject(new SigninRefusal(reason)); };
        const timer = setTimeout(() => fail('fetch_timeout'), limits.timeoutMs);
        request.on('error', () => fail('fetch_failed'));
        request.end();
    });
}
//# sourceMappingURL=clientDocument.js.map