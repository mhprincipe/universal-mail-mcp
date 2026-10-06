import { CREDENTIALS_SECRET, STATE_SECRET } from './flow.js';
import { Stop } from './stop.js';
import { sentCopyMode } from '../providers.js';
// How many times Check and fix repairs and checks again before handing over.
const REPAIR_ROUNDS = 3;
export async function runMenu(d, google, project) {
    const { ui, log } = d;
    const readJson = async (name) => JSON.parse((await google.readSecret(project, name)) ?? '{}');
    ui.say('INSTALLED', { version: d.version });
    ui.say('MENU');
    let choice = '';
    while (!['1', '2', '3', '4'].includes(choice))
        choice = (await d.ask('ASK-MENU')).trim();
    log.event({ type: 'menu', choice });
    const url = (await google.serverUrl(project));
    const state = await readJson(STATE_SECRET);
    const check = async () => { ui.say('CHECKING'); return d.selfTest({ url, key: state.key, project }); };
    const done = () => { log.event({ type: 'run-end', outcome: 'done' }); return { outcome: 'done' }; };
    const passed = (result) => ui.say('CHECKS-PASSED', { passed: String(result.passed), total: String(result.total) });
    if (choice === '3') {
        ui.say('ADDRESSES', { page: `${url}/${state.key}`, mcp: `${url}/${state.key}/mcp` });
        return done();
    }
    if (choice === '4') {
        if ((await d.ask('ASK-REMOVE')).trim().toLowerCase() !== 'remove') {
            ui.say('KEPT');
            return done();
        }
        const billing = await google.billing();
        if (billing.accountId)
            await google.deleteBudget(project, billing.accountId);
        await google.deleteProject(project);
        d.progress.save({ step: 0 });
        ui.say('REMOVED');
        return done();
    }
    if (choice === '2') {
        const running = await google.serverImage(project);
        if (running === d.image) {
            ui.say('UP-TO-DATE', { version: d.version });
            return done();
        }
        if (!(await google.imageTrusted(d.image)))
            throw new Stop('SETUP-IMAGE-UNTRUSTED');
        ui.say('UPDATING', { version: d.version });
        const settings = { UNIVERSAL_MAIL_STATE: STATE_SECRET, UNIVERSAL_MAIL_CREDENTIALS: CREDENTIALS_SECRET };
        await google.startServer(project, d.image, settings);
        const result = await check();
        if (result.failing) {
            // The version that was running before comes back exactly as it was.
            if (running)
                await google.startServer(project, running, settings);
            log.event({ type: 'update', outcome: 'rolled-back', stages: result.stages ?? [] });
            throw new Stop('SETUP-UPDATE-ROLLED-BACK', { check: result.failing });
        }
        log.event({ type: 'update', outcome: 'kept' });
        passed(result);
        ui.say('UPDATED', { version: d.version });
        return done();
    }
    // 1 · Check and fix: Google's side first, then the server checks itself;
    // repair what has a known repair; check again.
    await googleSide(d, google, project);
    let result = await check();
    for (let round = 0; result.failing && round < REPAIR_ROUNDS; round++) {
        if (!(await repair(d, google, project, state, result)))
            break;
        await google.restartServer(project, d.clock.now());
        ui.say('FIXED');
        result = await check();
    }
    if (result.failing)
        throw new Stop('SETUP-SELFTEST-FAILED', { check: result.failing });
    passed(result);
    return done();
}
// Google's side (design §7.1, the google stage), run from setup, which can
// act on it: billing still open and linked, the services on, the $1 alarm
// present. What setup can put back, it does; closed billing is yours to fix.
async function googleSide(d, google, project) {
    const billing = await google.billing();
    d.log.event({ type: 'google-check', billing: billing.state });
    if (billing.state === 'missing')
        throw new Stop('SETUP-BILLING-MISSING');
    if (billing.state === 'suspended')
        throw new Stop('SETUP-BILLING-SUSPENDED');
    if (billing.accountId && !(await google.billingLinked(project))) {
        await google.linkBilling(project, billing.accountId);
        d.ui.say('REPAIRED-BILLING');
    }
    if (!(await google.servicesReady(project))) {
        await google.enableServices(project);
        d.ui.say('REPAIRED-SERVICES');
    }
    if (billing.accountId && !(await google.budgetExists(project, billing.accountId))) {
        await google.createBudget(project, billing.accountId, 1);
        d.ui.say('REPAIRED-ALARM');
    }
}
// The first failed stage, if its repair is known: a password the provider no
// longer accepts (a new one, checked and saved), or a Sent mode never settled
// (the sending test again). Returns whether anything was repaired.
async function repair(d, google, project, state, result) {
    const failed = result.stages?.find(s => s.status === 'FAIL');
    const [kind, name] = failed?.stage.split(':') ?? [];
    const account = state.accounts.find(a => a.name === name);
    if (!failed || !account)
        return false;
    d.log.event({ type: 'repair', stage: failed.stage, code: failed.code });
    const detected = await d.mail.detect(account.email);
    const provider = detected?.provider;
    const credentials = JSON.parse((await google.readSecret(project, CREDENTIALS_SECRET)) ?? '{}');
    if (kind === 'account' && failed.code === 'MAIL-APP-PASSWORD-REJECTED') {
        d.ui.say('FIX-PASSWORD', { provider: provider?.name ?? 'Your provider', address: account.email, page: provider?.appPassword.page.replace(/^https:\/\//, '') ?? '' });
        for (;;) {
            const password = await d.ask('ASK-APP-PASSWORD', {}, { hidden: true });
            d.log.secret(password);
            const checked = await d.mail.check(account.email, password);
            d.log.event({ type: 'mail', op: 'check', provider: provider?.id ?? 'other', outcome: checked.ok ? 'ok' : checked.reason });
            if (checked.ok) {
                await google.putSecret(project, CREDENTIALS_SECRET, JSON.stringify({ ...credentials, passwords: { ...credentials.passwords, [account.name]: password } }));
                return true;
            }
            const code = checked.reason === 'rejected' ? 'MAIL-APP-PASSWORD' : checked.reason === 'insecure' ? 'MAIL-INSECURE' : 'MAIL-UNREACHABLE';
            const answer = (await d.ask(code, {
                provider: provider?.name ?? 'Your provider', address: account.email,
                page: provider?.appPassword.page.replace(/^https:\/\//, '') ?? '', button: provider?.appPassword.button ?? ''
            })).trim().toLowerCase();
            if (answer === 's')
                return false;
        }
    }
    if (kind === 'sent' && failed.code === 'SENT-MODE-UNKNOWN') {
        const { copies } = await d.mail.sendTest(account.email, credentials.passwords[account.name] ?? '');
        d.log.event({ type: 'mail', op: 'sendTest', provider: provider?.id ?? 'other', copies });
        const latest = JSON.parse((await google.readSecret(project, STATE_SECRET)) ?? '{}');
        const accounts = latest.accounts.map(a => a.name === account.name ? { ...a, sentCopyMode: sentCopyMode(copies, provider?.id) } : a);
        await google.putSecret(project, STATE_SECRET, JSON.stringify({ ...latest, accounts }));
        return true;
    }
    return false;
}
//# sourceMappingURL=menu.js.map