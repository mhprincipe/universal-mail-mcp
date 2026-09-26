import { describe, expect, it } from 'vitest';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { createSoftwareAuthenticator } from '../src/softwareAuthenticator.js';

const site = { rpId: 'mail.example', origin: 'https://mail.example' };

// TK-11: a passkey without a person or a device. Judged by a standard
// verifier, not by our own code, so "it works" means what a browser would mean.
describe('TK-11 software authenticator', () => {
  it('registers a passkey and signs with it, and a standard verifier accepts both', async () => {
    const authenticator = createSoftwareAuthenticator();

    const registerChallenge = 'cmVnaXN0ZXItY2hhbGxlbmdl';
    const registered = await verifyRegistrationResponse({
      response: authenticator.register({ ...site, challenge: registerChallenge }),
      expectedChallenge: registerChallenge, expectedOrigin: site.origin, expectedRPID: site.rpId, requireUserVerification: true
    }).catch(error => ({ verified: false as const, registrationInfo: undefined, error: (error as Error).message }));
    expect(registered.verified).toBe(true);
    const credential = registered.registrationInfo!.credential;

    const signChallenge = 'c2lnbi1pbi1jaGFsbGVuZ2U';
    const signedIn = await verifyAuthenticationResponse({
      response: authenticator.sign({ ...site, challenge: signChallenge }),
      expectedChallenge: signChallenge, expectedOrigin: site.origin, expectedRPID: site.rpId, credential, requireUserVerification: true
    });
    expect(signedIn.verified).toBe(true);

    // A signature made for a different site is refused.
    await expect(verifyAuthenticationResponse({
      response: authenticator.sign({ rpId: 'attacker.example', origin: 'https://attacker.example', challenge: signChallenge }),
      expectedChallenge: signChallenge, expectedOrigin: site.origin, expectedRPID: site.rpId, credential, requireUserVerification: true
    })).rejects.toThrow();
  });
});
