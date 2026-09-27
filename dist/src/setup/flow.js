import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { GoogleRefusal, NotReadyYet } from './google.js';
import { MESSAGES, renderLine } from './messages.js';
import { runMenu } from './menu.js';
import { Stop } from './stop.js';
export const CREDENTIALS_SECRET = 'universal-mail-credentials';
export const STATE_SECRET = 'universal-mail-state';
const WAIT_STEP_MS = 5_000;
const WAIT_LIMIT_MS = 10 * 60_000;
// The eight steps (design §3.3). Steps 1 and 2 only read; every later step
// checks whether it's already done; progress is saved as each step completes.
export async function runSetup(d) {
    const { ui, log } = d;
    const google = logged(d.google, log, d.clock);
    const progress = d.progress.load() ?? { step: 0 };
    let current = 0;
    const save = (step) => {
        if (step !== undefined) {
            progress.step = Math.max(progress.step, step);
            log.event({ type: 'step', n: step, phase: 'done' });
        }
        d.progress.save(progress);
    };
    const heading = (n) => {
        current = n;
        log.event({ type: 'step', n, phase: 'start' });
        ui.say('STEP', { n: String(n), title: renderLine(`STEP-${n}`) });
    };
    const passwords = new Map();
    log.event({ type: 'run-start', version: d.version, node: process.version, platform: process.platform, cloudShell: d.isCloudShell, resumingAfterStep: progress.step });
    try {
        if (!d.isCloudShell) {
            ui.say('WELCOME', { version: d.version });
            throw new Stop('SETUP-NOT-CLOUD-SHELL');
        }
        // Already installed: the menu. Found from the progress file, or from
        // Google itself when Cloud Shell has cleared its files.
        const installed = progress.step >= 8 ? progress.project
            : progress.step === 0 ? await existingInstall(google) : undefined;
        if (installed)
            return await runMenu(d, google, installed);
        ui.say('WELCOME', { version: d.version });
        if (progress.step > 0 && progress.step < 8)
            await d.ask('WELCOME-BACK', { step: String(progress.step + 1) });
        if (progress.step === 0)
            await offerConversion(d, google, progress, passwords);
        // ── 1 · Checking your Google Cloud account (reads only) ──
        heading(1);
        const account = await google.signedInAccount();
        if (!account)
            throw new Stop('SETUP-NOT-SIGNED-IN');
        ui.say('SIGNED-IN', { email: account });
        if (await google.blocksPublicServices())
            throw new Stop('SETUP-ORG-POLICY');
        ui.say('PERSONAL-ACCOUNT');
        const billing = await google.billing();
        if (billing.state === 'missing')
            throw new Stop('SETUP-BILLING-MISSING');
        if (billing.state === 'suspended')
            throw new Stop('SETUP-BILLING-SUSPENDED');
        ui.say('BILLING-ACTIVE');
        // The free trial ends in a shutdown unless upgraded (design §4.6). Enter checks
        // again after upgrading; s skips, and the reminder is kept.
        let trial = billing.trial;
        while (trial && !progress.trialReminder) {
            if ((await d.ask('SETUP-FREE-TRIAL')).trim().toLowerCase() === 's') {
                progress.trialReminder = true;
                break;
            }
            trial = (await google.billing()).trial;
        }
        if (!progress.project && !(await google.findProject()) && !(await google.canCreateProject()))
            throw new Stop('SETUP-PROJECT-QUOTA');
        save(1);
        // ── 2 · Your email accounts (reads only; passwords stay in memory) ──
        heading(2);
        const stored = progress.project ? await google.secretExists(progress.project, CREDENTIALS_SECRET) : false;
        if (!progress.accounts) {
            progress.accounts = await gatherAccounts(d, passwords);
            if (!progress.accounts.length)
                throw new Stop('SETUP-NO-ACCOUNTS');
            const first = progress.accounts[0].name;
            const chosen = (await d.ask('ASK-SIGNIN', { suggested: first })).trim() || first;
            progress.signIn = (progress.accounts.find(a => a.name === chosen) ?? progress.accounts[0]).address;
        }
        else if (progress.fromV1 && passwords.size) {
            // Version 1's password, checked before it's carried over; if the
            // provider no longer accepts it, a new one is asked for.
            const a = progress.accounts[0];
            const result = await d.mail.check(a.address, passwords.get(a.name));
            log.event({ type: 'mail', op: 'check', provider: a.providerId, outcome: result.ok ? 'ok' : result.reason, from: 'v1' });
            if (result.ok) {
                ui.say('ACCOUNT-OK', { folders: String(result.folders) });
                a.safeMove = result.safeMove;
            }
            else {
                passwords.clear();
                progress.accounts = await askPasswords(d, progress.accounts, passwords);
            }
            if (!progress.accounts.length)
                throw new Stop('SETUP-NO-ACCOUNTS');
        }
        else if (!stored) {
            // Only what hadn't been stored yet is asked again: the app passwords.
            progress.accounts = await askPasswords(d, progress.accounts, passwords);
            if (!progress.accounts.length)
                throw new Stop('SETUP-NO-ACCOUNTS');
        }
        save(2);
        // ── 3 · Creating your project ──
        heading(3);
        const project = progress.project ?? (await google.findProject()) ?? (await google.createProject());
        progress.project = project;
        save();
        // Version 1's project becomes Universal Mail's, so later runs find it.
        if (progress.fromV1)
            await google.labelProject(project);
        if (!(await google.billingLinked(project)))
            await google.linkBilling(project, billing.accountId);
        save(3);
        // ── 4 · Turning on Google services ──
        heading(4);
        if (!(await google.servicesReady(project))) {
            await google.enableServices(project);
            await waitFor(d, () => google.servicesReady(project), 'GOOGLE-SERVICE-NOT-READY');
        }
        save(4);
        // ── 5 · Setting the $1 cost alarm ──
        heading(5);
        if (!(await google.budgetExists(project, billing.accountId)))
            await google.createBudget(project, billing.accountId, 1);
        save(5);
        // ── 6 · Starting your server ──
        heading(6);
        progress.key ??= randomBytes(16).toString('base64url');
        progress.installedAt ??= new Date(d.clock.now()).toISOString();
        log.secret(progress.key);
        save();
        const accounts = progress.accounts;
        if (!(await google.secretExists(project, CREDENTIALS_SECRET))) {
            const secret = credentials(accounts, passwords);
            log.secret(secret.signingKey.d ?? '');
            log.secret(secret.encryptionKey);
            await google.putSecret(project, CREDENTIALS_SECRET, JSON.stringify(secret));
        }
        if (!(await google.secretExists(project, STATE_SECRET))) {
            await google.putSecret(project, STATE_SECRET, JSON.stringify(stateOf(progress)));
        }
        // Only a trusted image is ever started. The server reads its settings when
        // it starts, so starting it again is how it sees a new version of them.
        const startServer = async () => {
            if (!(await google.imageTrusted(d.image)))
                throw new Stop('SETUP-IMAGE-UNTRUSTED');
            return retryUntilReady(d, () => google.startServer(project, d.image, {
                UNIVERSAL_MAIL_STATE: STATE_SECRET, UNIVERSAL_MAIL_CREDENTIALS: CREDENTIALS_SECRET
            }));
        };
        const url = await google.serverUrl(project) ?? await startServer();
        save(6);
        // ── 7 · Testing sending ──
        heading(7);
        if (!progress.sent || accounts.some(a => !progress.sent[a.name])) {
            const answer = (await d.ask('ASK-SEND-TEST')).trim().toLowerCase();
            const sent = {};
            const known = passwords.size ? undefined : JSON.parse((await google.readSecret(project, CREDENTIALS_SECRET)) ?? '{}').passwords;
            for (const a of accounts) {
                if (answer === 'n') {
                    sent[a.name] = 'append';
                    continue;
                }
                const { copies } = await d.mail.sendTest(a.address, passwords.get(a.name) ?? known?.[a.name] ?? '');
                log.event({ type: 'mail', op: 'sendTest', provider: a.providerId, copies });
                // One copy: the provider files it. None: Universal Mail must. Two: both did.
                sent[a.name] = copies === 0 ? 'append' : 'yahoo';
                if (copies === 2)
                    ui.say('SENT-DUPLICATE', { address: a.address });
                else
                    ui.say(copies === 1 ? 'SENT-SAVED-BY-PROVIDER' : 'SENT-SAVED-BY-US', { name: a.name, provider: a.providerName });
            }
            await google.putSecret(project, STATE_SECRET, JSON.stringify(stateOf({ ...progress, sent })));
            // The running server still has the settings from before: step 8 must check these.
            await google.restartServer(project, d.clock.now());
            progress.sent = sent;
        }
        save(7);
        // ── 8 · Testing everything ──
        heading(8);
        const checked = await d.selfTest({ url, key: progress.key, project });
        if (checked.failing)
            throw new Stop('SETUP-SELFTEST-FAILED', { check: checked.failing });
        ui.say('CHECKS-PASSED', { passed: String(checked.passed), total: String(checked.total) });
        save(8);
        ui.say('ALL-DONE', { page: `${url}/${progress.key}`, mcp: `${url}/${progress.key}/mcp` });
        if (progress.fromV1)
            ui.say('CONVERTED');
        log.event({ type: 'run-end', outcome: 'done' });
        return { outcome: 'done' };
    }
    catch (error) {
        // Anything unforeseen: plain words on screen; the whole story in the log.
        const stop = error instanceof Stop ? error
            : error instanceof GoogleRefusal ? new Stop(error.code)
                : new Stop('SETUP-UNEXPECTED', { step: String(current) });
        if (!(error instanceof Stop) && !(error instanceof GoogleRefusal))
            log.event({ type: 'error', step: current, message: error?.message ?? String(error), stack: error?.stack ?? '' });
        // Once the project exists, "Nothing was changed" would no longer be true.
        const entry = MESSAGES[stop.code];
        ui.say(stop.code, stop.values, progress.project && entry.stand === 'nothing' ? { stand: 'saved' } : {});
        // How to get help, unless the problem's own steps already say it.
        if (!entry.steps?.some(step => step.includes('setup.js report')))
            ui.say('STUCK');
        log.event({ type: 'run-end', outcome: 'stopped', code: stop.code });
        return { outcome: 'stopped', code: stop.code };
    }
}
// Version 1 in Cloud Shell's current project (design §10): offered, and if
// taken, its account, address, project and Sent mode fill in steps 1 to 3.
// Version 1's own service and secrets are only read, never changed.
async function offerConversion(d, google, progress, passwords) {
    const current = await google.currentProject();
    const v1 = current ? await google.v1Service(current) : undefined;
    if (!current || !v1)
        return;
    if ((await d.ask('ASK-CONVERT')).trim().toLowerCase() === 'n')
        return;
    const email = (await google.readSecret(current, 'yahoo-email'))?.trim().toLowerCase();
    const password = (await google.readSecret(current, 'yahoo-app-password'))?.trim();
    const detected = email ? await d.mail.detect(email) : undefined;
    d.log.event({ type: 'convert', from: 'v1', found: { address: Boolean(email), password: Boolean(password) }, provider: detected?.provider.id ?? 'unknown', sentCopyMode: v1.sentCopyMode });
    if (!email || !detected)
        return;
    if (password) {
        d.log.secret(password);
        passwords.set('personal', password);
    }
    progress.accounts = [{ address: email, name: 'personal', providerId: detected.provider.id, providerName: detected.provider.name, safeMove: true, provider: detected }];
    progress.signIn = email;
    progress.project = current;
    progress.fromV1 = true;
    if (v1.sentCopyMode !== 'unverified')
        progress.sent = { personal: v1.sentCopyMode };
}
// A project labelled as Universal Mail's, with its server running.
async function existingInstall(google) {
    const project = await google.findProject();
    return project && (await google.serverUrl(project)) ? project : undefined;
}
async function gatherAccounts(d, passwords) {
    d.ui.say('ASK-ADDRESSES');
    const found = [];
    for (;;) {
        let address = (await d.ask('ASK-ADDRESS')).trim().toLowerCase();
        if (!address)
            break;
        let detected = await d.mail.detect(address);
        d.log.event({ type: 'mail', op: 'detect', domain: address.split('@')[1], provider: detected?.provider.id ?? 'unknown' });
        while (!detected) {
            const answer = (await d.ask('MAIL-PROVIDER-UNKNOWN', { address })).trim().toLowerCase();
            if (answer === 's' || !answer)
                break;
            address = answer;
            detected = await d.mail.detect(address);
        }
        if (detected)
            found.push({ address, name: '', providerId: detected.provider.id, providerName: detected.provider.name, safeMove: true, provider: detected });
    }
    if (!found.length)
        return [];
    const byProvider = new Map(found.map(a => [a.providerId, a.provider.provider]));
    d.ui.say('ACCOUNTS-FOUND', { count: String(found.length), summary: [...byProvider.values()].map(p => `${found.filter(a => a.providerId === p.id).length} ${p.name}`).join(', ') });
    d.ui.say('WHERE-PASSWORDS');
    for (const p of byProvider.values()) {
        d.ui.say('PASSWORD-PLACE', { provider: p.name, page: p.appPassword.page.replace(/^https:\/\//, ''), button: p.appPassword.button,
            prerequisites: p.appPassword.prerequisites.length ? `  (${p.appPassword.prerequisites.join(', ')} must be on)` : '' });
    }
    return askPasswords(d, found, passwords, true);
}
// Each password is tested at once; a bad account can be skipped with s.
async function askPasswords(d, list, passwords, naming = false) {
    const kept = [];
    for (const [i, a] of list.entries()) {
        d.ui.say('ACCOUNT-HEADING', { i: String(i + 1), count: String(list.length), address: a.address });
        const provider = a.provider ?? await d.mail.detect(a.address);
        let skip = false;
        let password;
        for (;;) {
            // After an unreachable or insecure server, the same password is tried again.
            if (password === undefined) {
                password = await d.ask('ASK-APP-PASSWORD', {}, { hidden: true });
                d.log.secret(password);
            }
            const result = await d.mail.check(a.address, password);
            d.log.event({ type: 'mail', op: 'check', provider: a.providerId, outcome: result.ok ? 'ok' : result.reason, ...(result.ok ? { folders: result.folders, safeMove: result.safeMove } : {}) });
            if (!result.ok && result.reason !== 'rejected') {
                const code = result.reason === 'insecure' ? 'MAIL-INSECURE' : 'MAIL-UNREACHABLE';
                if ((await d.ask(code, { provider: a.providerName, address: a.address })).trim().toLowerCase() === 's') {
                    skip = true;
                    break;
                }
                continue;
            }
            if (result.ok) {
                d.ui.say('ACCOUNT-OK', { folders: String(result.folders) });
                if (!result.safeMove && (await d.ask('MAIL-NO-SAFE-MOVE', { provider: a.providerName, address: a.address })).trim().toLowerCase() === 's')
                    skip = true;
                a.safeMove = result.safeMove;
                if (!skip)
                    passwords.set(a.address, password);
                break;
            }
            const p = provider?.provider;
            const answer = (await d.ask('MAIL-APP-PASSWORD', { provider: a.providerName, page: p?.appPassword.page.replace(/^https:\/\//, '') ?? '', button: p?.appPassword.button ?? '' })).trim().toLowerCase();
            if (answer === 's') {
                skip = true;
                break;
            }
            password = undefined;
        }
        if (skip) {
            d.ui.say('ACCOUNT-SKIPPED', { address: a.address });
            continue;
        }
        if (naming) {
            const taken = new Set(kept.map(k => k.name));
            let suggested = a.providerId;
            for (let n = 2; taken.has(suggested); n++)
                suggested = `${a.providerId}-${n}`;
            const typed = (await d.ask('ASK-NAME', { suggested })).trim().toLowerCase();
            a.name = typed && /^[a-z0-9][a-z0-9-]{0,31}$/.test(typed) && !taken.has(typed) ? typed : suggested;
        }
        passwords.set(a.name, passwords.get(a.address) ?? '');
        passwords.delete(a.address);
        kept.push({ ...a, provider });
    }
    return kept;
}
function credentials(accounts, passwords) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
        passwords: Object.fromEntries(accounts.map(a => [a.name, passwords.get(a.name)])),
        signingKey: privateKey.export({ format: 'jwk' }),
        encryptionKey: randomBytes(32).toString('base64url')
    };
}
// universal-mail-state (design §6.3). No passwords, no keys.
function stateOf(progress) {
    const accounts = (progress.accounts ?? []);
    return {
        version: 1,
        key: progress.key,
        signInAddress: progress.signIn,
        accounts: accounts.map(a => ({
            name: a.name, email: a.address, provider: a.providerId,
            imap: a.provider?.provider.imap, smtp: a.provider?.provider.smtp,
            sentCopyMode: progress.sent?.[a.name] ?? 'unverified', safeMove: a.safeMove
        })),
        grants: {},
        fingerprints: [],
        trialReminder: progress.trialReminder ?? false,
        ...(progress.installedAt ? { installedAt: progress.installedAt } : {})
    };
}
// Google says "done" before a change takes effect: check until it's ready.
async function waitFor(d, ready, code) {
    const started = d.clock.now();
    let told = false;
    while (!(await ready())) {
        if (d.clock.now() - started > WAIT_LIMIT_MS)
            throw new Stop(code);
        if (!told) {
            d.ui.say('WAITING-GOOGLE');
            told = true;
        }
        await d.clock.sleep(WAIT_STEP_MS);
    }
}
async function retryUntilReady(d, act) {
    const started = d.clock.now();
    let told = false;
    for (;;) {
        try {
            return await act();
        }
        catch (error) {
            if (!(error instanceof NotReadyYet))
                throw error;
            if (d.clock.now() - started > WAIT_LIMIT_MS)
                throw new Stop(error.what === 'service' ? 'GOOGLE-SERVICE-NOT-READY' : 'GOOGLE-PERMISSION-NOT-READY');
            if (!told) {
                d.ui.say('WAITING-GOOGLE');
                told = true;
            }
            await d.clock.sleep(WAIT_STEP_MS);
        }
    }
}
// Every Google call, logged: its name, outcome, time taken, and Google's own
// words when it fails. Never its arguments: a secret's contents is one.
function logged(google, log, clock) {
    return new Proxy(google, {
        get(target, op) {
            const fn = target[op];
            if (typeof fn !== 'function')
                return fn;
            return async (...args) => {
                const started = clock.now();
                try {
                    const result = await fn.apply(target, args);
                    log.event({ type: 'google', op, outcome: 'ok', ms: clock.now() - started });
                    return result;
                }
                catch (error) {
                    log.event({ type: 'google', op, outcome: error instanceof NotReadyYet ? 'not-ready' : 'error', ms: clock.now() - started, error: error?.message ?? String(error) });
                    throw error;
                }
            };
        }
    });
}
//# sourceMappingURL=flow.js.map