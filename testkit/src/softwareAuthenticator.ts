import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';

export type RegistrationJSON = Parameters<typeof verifyRegistrationResponse>[0]['response'];
export type AuthenticationJSON = Parameters<typeof verifyAuthenticationResponse>[0]['response'];
export type Ceremony = { rpId: string; origin: string; challenge: string };

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

// Just enough CBOR for WebAuthn: integers, byte and text strings, maps.
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
function cbor(value: Cbor): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const out = Buffer.alloc(5); out[0] = (major << 5) | 26; out.writeUInt32BE(n, 1); return out;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') { const text = Buffer.from(value, 'utf8'); return Buffer.concat([head(3, text.length), text]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const UP = 0x01, UV = 0x04, AT = 0x40;

// A platform authenticator in software: one ES256 key, user presence and
// verification always asserted, a counter that rises with every signature.
export function createSoftwareAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(16);
  const userHandle = randomBytes(16);
  let counter = 0;

  const coseKey = cbor(new Map<Cbor, Cbor>([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]
  ]));
  const authData = (rpId: string, flags: number, count: number, attested?: Buffer) => {
    const signCount = Buffer.alloc(4); signCount.writeUInt32BE(count);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), signCount, ...(attested ? [attested] : [])]);
  };
  const clientData = (type: string, c: Ceremony) =>
    Buffer.from(JSON.stringify({ type, challenge: c.challenge, origin: c.origin, crossOrigin: false }));
  const id = credentialId.toString('base64url');

  return {
    register(c: Ceremony): RegistrationJSON {
      const idLength = Buffer.alloc(2); idLength.writeUInt16BE(credentialId.length);
      const attested = Buffer.concat([Buffer.alloc(16), idLength, credentialId, coseKey]); // zero AAGUID
      const attestation = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(c.rpId, UP | UV | AT, 0, attested)]]));
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: clientData('webauthn.create', c).toString('base64url'), attestationObject: attestation.toString('base64url'), transports: ['internal'] }
      };
    },
    sign(c: Ceremony): AuthenticationJSON {
      const data = authData(c.rpId, UP | UV, ++counter);
      const client = clientData('webauthn.get', c);
      const signature = sign('sha256', Buffer.concat([data, sha256(client)]), privateKey);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: client.toString('base64url'), authenticatorData: data.toString('base64url'),
          signature: signature.toString('base64url'), userHandle: userHandle.toString('base64url')
        }
      };
    }
  };
}
