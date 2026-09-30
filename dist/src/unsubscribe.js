import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { MailError } from './errors.js';
import { isPublicAddress } from './signin/clientDocument.js';
export const ONE_CLICK_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 10_000 };
const BODY = 'List-Unsubscribe=One-Click';
// The https address to ask, when the email offers one click: its
// List-Unsubscribe-Post header says so, and one of the addresses is https.
export function oneClickTarget(listUnsubscribe, listUnsubscribePost) {
    if (listUnsubscribePost?.trim().toLowerCase() !== BODY.toLowerCase())
        return undefined;
    for (const [, candidate] of (listUnsubscribe ?? '').matchAll(/<([^>]*)>/g)) {
        if (!/^https:\/\//i.test(candidate.trim()))
            continue;
        try {
            return new URL(candidate.trim());
        }
        catch { /* not an address */ }
    }
    return undefined;
}
const unsafe = () => new MailError('MAIL-UNSUBSCRIBE-FAILED', "This sender's unsubscribe address isn't one Universal Mail will contact, so nothing was sent.", 'FAILED', false, { reason: 'unsafe address' });
export async function unsubscribeOneClick(url, deps) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const clean = url.protocol === 'https:' && !url.username && !url.password && url.port === '' && !isIP(host);
    if (!clean)
        throw unsafe();
    // Resolved first and every answer vetted, then connected to a vetted
    // address: a second lookup can't swap in a private one (DNS rebinding).
    const addresses = await deps.resolve(url.hostname).catch(() => []);
    if (!addresses.length || !addresses.every(isPublicAddress))
        throw unsafe();
    const status = await deps.post(url, addresses[0]).catch(() => 0);
    if (status < 200 || status > 299) {
        throw new MailError('MAIL-UNSUBSCRIBE-FAILED', status ? `The sender answered ${status}, so the unsubscribe may not have worked.` : "The sender's unsubscribe address didn't answer.", 'FAILED', false, { status });
    }
}
// The real request: to the vetted address, naming the real host (and, for
// https, checking its certificate). No redirects; size and time limits.
export function pinnedPost(url, address, limits, protocol = 'https') {
    return new Promise((resolve, reject) => {
        const transport = protocol === 'https' ? https : http;
        const request = transport.request({
            host: address, port: url.port || (protocol === 'https' ? 443 : 80), path: `${url.pathname}${url.search}`, method: 'POST',
            headers: { Host: url.host, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': BODY.length, 'User-Agent': 'Universal Mail' },
            ...(protocol === 'https' ? { servername: url.hostname } : {})
        }, response => {
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > limits.maxBytes)
                    fail('answer too large');
            });
            response.on('end', () => { clearTimeout(timer); resolve(response.statusCode ?? 0); });
        });
        const fail = (reason) => { clearTimeout(timer); request.destroy(); reject(new Error(reason)); };
        const timer = setTimeout(() => fail('time limit'), limits.timeoutMs);
        request.on('error', error => fail(error.message));
        request.end(BODY);
    });
}
// What the server uses; tests replace its parts.
export const realOneClick = {
    resolve: async (host) => (await lookup(host, { all: true })).map(answer => answer.address),
    post: (url, address) => pinnedPost(url, address, ONE_CLICK_LIMITS)
};
//# sourceMappingURL=unsubscribe.js.map