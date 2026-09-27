import { randomUUID } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
export function createOwnerAuth(options) {
    const sessions = new Map();
    // Public keys only, saved in universal-mail-state.
    const fingerprints = options.fingerprints ?? [];
    const changed = () => options.onFingerprintsChange?.([...fingerprints]);
    const get = (id) => sessions.get(id) ?? { level: 'none' };
    const expected = { expectedOrigin: options.origin, expectedRPID: options.rpId, requireUserVerification: true };
    // Each challenge is used at most once, whatever the outcome.
    const takeChallenge = (s) => { const c = s.challenge; delete s.challenge; return c; };
    return {
        start() {
            const id = randomUUID();
            sessions.set(id, { level: 'none' });
            return id;
        },
        level: id => get(id).level,
        hasFingerprint: () => fingerprints.length > 0,
        async requestCode(id, requester) {
            const s = sessions.get(id);
            if (!s)
                return { ok: false, reason: 'unknown_session' };
            const sent = await options.codes.request(requester);
            if (!sent.ok)
                return sent;
            s.codeSession = sent.session;
            return { ok: true };
        },
        enterCode(id, entered) {
            const s = sessions.get(id);
            if (!s?.codeSession)
                return { ok: false, reason: 'no_code' };
            const checked = options.codes.verify(s.codeSession, entered);
            if (!checked.ok)
                return checked;
            if (s.level === 'none')
                s.level = 'code';
            return { ok: true };
        },
        async beginRegistration(id) {
            const s = sessions.get(id);
            if (!s || s.level === 'none')
                return { ok: false, reason: 'code_required' };
            // Once a fingerprint exists, only a fingerprint can add another.
            if (fingerprints.length && s.level !== 'fingerprint')
                return { ok: false, reason: 'fingerprint_required' };
            const created = await generateRegistrationOptions({
                rpName: 'Universal Mail', rpID: options.rpId, userName: 'owner', attestationType: 'none',
                excludeCredentials: fingerprints.map(f => ({ id: f.id, transports: f.transports })),
                authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }
            });
            s.challenge = created.challenge;
            return { ok: true, options: created };
        },
        async finishRegistration(id, response) {
            const s = sessions.get(id);
            const challenge = s && takeChallenge(s);
            if (!s || !challenge)
                return { ok: false, reason: 'no_challenge' };
            try {
                const result = await verifyRegistrationResponse({ response: response, expectedChallenge: challenge, ...expected });
                if (!result.verified || !result.registrationInfo)
                    return { ok: false, reason: 'fingerprint_invalid' };
                fingerprints.push(result.registrationInfo.credential);
                changed();
                s.level = 'fingerprint';
                return { ok: true };
            }
            catch {
                return { ok: false, reason: 'fingerprint_invalid' };
            }
        },
        async beginAuthentication(id) {
            const s = sessions.get(id);
            if (!s)
                return { ok: false, reason: 'unknown_session' };
            if (!fingerprints.length)
                return { ok: false, reason: 'no_fingerprint' };
            const created = await generateAuthenticationOptions({
                rpID: options.rpId, userVerification: 'required',
                allowCredentials: fingerprints.map(f => ({ id: f.id, transports: f.transports }))
            });
            s.challenge = created.challenge;
            return { ok: true, options: created };
        },
        async finishAuthentication(id, response) {
            const s = sessions.get(id);
            const challenge = s && takeChallenge(s);
            if (!s || !challenge)
                return { ok: false, reason: 'fingerprint_invalid' };
            const credential = fingerprints.find(f => f.id === response?.id);
            if (!credential)
                return { ok: false, reason: 'fingerprint_invalid' };
            try {
                const result = await verifyAuthenticationResponse({ response: response, expectedChallenge: challenge, credential, ...expected });
                if (!result.verified)
                    return { ok: false, reason: 'fingerprint_invalid' };
                credential.counter = result.authenticationInfo.newCounter;
                changed();
                s.level = 'fingerprint';
                return { ok: true };
            }
            catch {
                return { ok: false, reason: 'fingerprint_invalid' };
            }
        },
        mayGrant(id, accounts) {
            const level = get(id).level;
            if (level === 'none')
                return { ok: false, reason: 'sign_in_required' };
            const wantsSend = Object.values(accounts).some(actions => actions.includes('send'));
            if (wantsSend && level !== 'fingerprint')
                return { ok: false, reason: 'fingerprint_required' };
            return { ok: true };
        }
    };
}
//# sourceMappingURL=owner.js.map