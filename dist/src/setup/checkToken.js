import { createPrivateKey, randomUUID, sign } from 'node:crypto';
// The token setup presents to the server's check route (design §4.5): a JWT
// signed ES256 with the key setup generated, marked as a check token, for five
// minutes. Node's built-ins only (SET-25); the server verifies it with jose.
export const CHECK_TOKEN_TYPE = 'um-check+jwt';
export const CHECK_TOKEN_SECONDS = 300;
const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
export function mintCheckToken(signingKey, options) {
    const iat = Math.floor(options.now / 1000);
    const input = `${part({ alg: 'ES256', typ: CHECK_TOKEN_TYPE })}.${part({
        iss: options.issuer, aud: options.audience, iat, exp: iat + (options.lifetimeSeconds ?? CHECK_TOKEN_SECONDS), jti: randomUUID()
    })}`;
    // JWS wants the raw r||s signature, not DER.
    const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey({ key: signingKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
    return `${input}.${signature.toString('base64url')}`;
}
//# sourceMappingURL=checkToken.js.map