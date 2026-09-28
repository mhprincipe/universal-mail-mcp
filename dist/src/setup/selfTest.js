import { mintCheckToken } from './checkToken.js';
import { CREDENTIALS_SECRET } from './flow.js';
// Step 8 (design §4.5): the server checks itself. Setup signs a check token
// with the key it saved in universal-mail-credentials, and asks. The report
// is logged whole: it holds codes and plain words, never mail or secrets.
const ATTEMPTS = 3;
const WAIT_MS = 5_000;
const TIMEOUT_MS = 60_000;
// When the check can't run at all, the words shown after "The final check found a problem."
const NO_KEYS = 'Setup couldn\'t read the server\'s saved keys.';
const REFUSED = 'The server didn\'t accept setup\'s check, so its saved keys may not match.';
const NOT_FOUND = 'The server has no check at its address. It may not be this version.';
const NO_ANSWER = 'The server didn\'t answer its check.';
// Found live: 403 was retried and then called "didn't answer".
const TURNED_AWAY = 'The server turned setup\'s check away.';
// A network failure's code (ECONNREFUSED, ETIMEDOUT…) or name: never its words.
function reasonOf(error) {
    const code = error?.cause?.code ?? error?.code;
    const label = typeof code === 'string' ? code : error?.name;
    return typeof label === 'string' && /^[\w-]{1,40}$/.test(label) ? label : 'unknown';
}
export function createSelfTest(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const { log, clock } = options;
    const unable = (failing) => ({ passed: 0, total: 0, failing });
    return async ({ url, key, project }) => {
        let signingKey;
        try {
            signingKey = JSON.parse((await options.google.readSecret(project, CREDENTIALS_SECRET)) ?? '{}').signingKey;
        }
        catch { /* reported below */ }
        if (!signingKey?.d) {
            log.event({ type: 'selfTest', outcome: 'no-keys' });
            return unable(NO_KEYS);
        }
        log.secret(signingKey.d);
        for (let attempt = 1;; attempt++) {
            // A fresh token each time: the server accepts each one once.
            const token = mintCheckToken(signingKey, { issuer: url, audience: `${url}/${key}/check`, now: clock.now() });
            const started = clock.now();
            let retry;
            try {
                const response = await fetchImpl(`${url}/${key}/check`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                    body: JSON.stringify({ expectedVersion: options.version }),
                    signal: AbortSignal.timeout(TIMEOUT_MS)
                });
                log.event({ type: 'selfTest', attempt, status: response.status, ms: clock.now() - started });
                if (response.status === 200) {
                    const report = await response.json();
                    log.event({ type: 'selfTest-report', report });
                    const failed = report.stages.find(s => s.status === 'FAIL');
                    return {
                        passed: report.stages.filter(s => s.status === 'PASS').length, total: report.stages.length,
                        ...(failed?.status === 'FAIL' ? { failing: failed.cause } : {}),
                        stages: report.stages.map(s => ({ stage: s.stage, status: s.status, ...(s.status === 'FAIL' ? { code: s.code } : {}) }))
                    };
                }
                if (response.status === 401)
                    return unable(REFUSED);
                if (response.status === 403)
                    return unable(TURNED_AWAY);
                if (response.status === 404)
                    return unable(NOT_FOUND);
                retry = true;
            }
            catch (error) {
                log.event({ type: 'selfTest', attempt, error: reasonOf(error), ms: clock.now() - started });
                retry = true;
            }
            if (!retry || attempt >= ATTEMPTS)
                return unable(NO_ANSWER);
            await clock.sleep(WAIT_MS);
        }
    };
}
//# sourceMappingURL=selfTest.js.map