// The capabilities the engine changes its behavior for. Others are not compared.
const RELEVANT_CAPABILITIES = ['MOVE', 'UIDPLUS', 'SPECIAL-USE'];
// Capabilities: Yahoo's MOVE and UIDPLUS were confirmed live by v1's batch
// move; Gmail's and Fastmail's are published. AOL, iCloud and Zoho are not yet
// confirmed, so they carry no expectations.
// An app password as the person pasted it: providers show them in groups
// (Gmail: "abcd efgh ijkl mnop"), and none contains a space, so spaces go.
export const appPassword = (typed) => typed.replace(/\s+/g, '');
// Who files the Sent copy, from the sending test's count (SET-86): none seen
// means Universal Mail must, except for a provider known to file its own a
// minute or two later (Yahoo, ENG-24 found live), which the test can't wait for.
const FILES_SENT_LATE = new Set(['yahoo']);
export function sentCopyMode(copies, providerId) {
    return copies === 0 && !FILES_SENT_LATE.has(providerId ?? '') ? 'append' : 'yahoo';
}
// The provider an account is at, for saying so beside its name (ENG-29): by its
// mail server, else its address's domain; undefined when neither is known.
export function providerName(address, imapHost) {
    const domain = (address ?? '').split('@').pop()?.toLowerCase() ?? '';
    const host = (imapHost ?? '').toLowerCase();
    return (profiles.find(p => p.imap.host === host) ?? profiles.find(p => p.domains.includes(domain)))?.name;
}
export const profiles = [
    {
        id: 'yahoo', name: 'Yahoo Mail',
        domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'], mxSuffixes: ['yahoodns.net'],
        imap: { host: 'imap.mail.yahoo.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.yahoo.com', port: 587, tls: 'starttls' },
        expectedCapabilities: ['MOVE', 'UIDPLUS'],
        appPassword: { page: 'https://login.yahoo.com/account/security', button: 'Generate app password', prerequisites: [] }
    },
    {
        id: 'aol', name: 'AOL Mail',
        domains: ['aol.com'], mxSuffixes: [],
        imap: { host: 'imap.aol.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.aol.com', port: 465, tls: 'implicit' },
        expectedCapabilities: [],
        appPassword: { page: 'https://login.aol.com/account/security', button: 'Generate app password', prerequisites: [] }
    },
    {
        id: 'icloud', name: 'iCloud Mail',
        domains: ['icloud.com', 'me.com', 'mac.com'], mxSuffixes: ['icloud.com'],
        imap: { host: 'imap.mail.me.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' },
        expectedCapabilities: [],
        appPassword: { page: 'https://account.apple.com/account/manage', button: 'App-Specific Passwords', prerequisites: ['Two-factor authentication'] }
    },
    {
        id: 'fastmail', name: 'Fastmail',
        domains: ['fastmail.com', 'fastmail.fm'], mxSuffixes: ['messagingengine.com'],
        imap: { host: 'imap.fastmail.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.fastmail.com', port: 465, tls: 'implicit' },
        expectedCapabilities: ['MOVE', 'UIDPLUS', 'SPECIAL-USE'],
        appPassword: { page: 'https://app.fastmail.com/settings/security', button: 'New app password', prerequisites: [] }
    },
    {
        id: 'gmail', name: 'Gmail',
        domains: ['gmail.com', 'googlemail.com'], mxSuffixes: ['google.com', 'googlemail.com'],
        imap: { host: 'imap.gmail.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.gmail.com', port: 465, tls: 'implicit' },
        expectedCapabilities: ['MOVE', 'UIDPLUS', 'SPECIAL-USE'],
        appPassword: { page: 'https://myaccount.google.com/apppasswords', button: 'Create', prerequisites: ['2-Step Verification'] }
    },
    {
        id: 'zoho', name: 'Zoho Mail',
        domains: ['zoho.com', 'zohomail.com'], mxSuffixes: ['zoho.com'],
        imap: { host: 'imap.zoho.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.zoho.com', port: 465, tls: 'implicit' },
        expectedCapabilities: [],
        appPassword: {
            page: 'https://accounts.zoho.com/home#security/app_password', button: 'Generate New Password',
            prerequisites: ['Two-factor authentication', 'IMAP access turned on in Zoho Mail settings']
        }
    },
    {
        // Microsoft's personal mail (2.5, MS-11): no app passwords, so it signs in
        // with Microsoft. By its domains only: a company whose mail Microsoft
        // handles (MX at outlook.com) is a work account, for later.
        id: 'outlook', name: 'Outlook.com', signIn: 'microsoft',
        domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], mxSuffixes: [],
        imap: { host: 'outlook.office365.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp-mail.outlook.com', port: 587, tls: 'starttls' },
        expectedCapabilities: [],
        appPassword: { page: 'https://account.microsoft.com/privacy/app-access', button: 'Sign in with Microsoft', prerequisites: [] }
    }
];
// The live server's answer is what the engine uses. A difference from the
// profile is returned so setup can record it in the diagnostics log.
export function reconcileCapabilities(profile, live) {
    const capabilities = live.map(name => name.toUpperCase());
    const missing = profile.expectedCapabilities.filter(name => !capabilities.includes(name));
    const unexpected = RELEVANT_CAPABILITIES.filter(name => capabilities.includes(name) && !profile.expectedCapabilities.includes(name));
    return { capabilities, mismatch: missing.length || unexpected.length ? { missing, unexpected } : undefined };
}
// Without MOVE, a move is copy + mark deleted + expunge. Without UIDPLUS too,
// that expunge can't be limited to one message and would also erase anything
// else the person had marked deleted. So such an account gets no moves.
export function moveSafety(capabilities) {
    const has = (name) => capabilities.some(capability => capability.toUpperCase() === name);
    if (has('MOVE') || has('UIDPLUS'))
        return { safe: true };
    return {
        safe: false,
        reason: "This mail server can't move messages safely, so moving is turned off for this account. " +
            'Reading, searching and sending still work.'
    };
}
// A suffix matches only on a label boundary, so "notyahoodns.net" is not Yahoo.
function hostMatches(host, suffix) {
    return host === suffix || host.endsWith(`.${suffix}`);
}
export async function detectProvider(address, deps) {
    const domain = (address.split('@')[1] ?? '').toLowerCase();
    const known = profiles.find(profile => profile.domains.includes(domain));
    if (known)
        return { kind: 'profile', via: 'domain', profile: known };
    const hosts = (await quietly(deps.resolveMx(domain), [])).map(host => host.toLowerCase().replace(/\.$/, ''));
    const byMx = profiles.find(profile => hosts.some(host => profile.mxSuffixes.some(suffix => hostMatches(host, suffix))));
    if (byMx)
        return { kind: 'profile', via: 'mx', profile: byMx };
    const published = await quietly(deps.autoconfig(domain), undefined);
    if (published)
        return { kind: 'discovered', via: 'autoconfig', imap: published.imap, smtp: published.smtp };
    // RFC 6186 records. Both are needed: reading mail without sending is not a setup.
    const imap = await srvEndpoint(deps, `_imaps._tcp.${domain}`, 'implicit');
    const smtp = imap && await srvEndpoint(deps, `_submission._tcp.${domain}`, 'starttls');
    if (imap && smtp)
        return { kind: 'discovered', via: 'srv', imap, smtp };
    return { kind: 'needs-input', domain };
}
// A failed lookup is the same as no answer: detection moves on to the next
// source, and if none answers, the person is asked. Nothing is guessed.
async function quietly(lookup, fallback) {
    try {
        return await lookup;
    }
    catch {
        return fallback;
    }
}
async function srvEndpoint(deps, name, tls) {
    const [record] = await quietly(deps.resolveSrv(name), []);
    const host = record?.name.toLowerCase().replace(/\.$/, '');
    // RFC 2782: a target of "." means the service is deliberately not offered.
    return host ? { host, port: record.port, tls } : undefined;
}
//# sourceMappingURL=providers.js.map