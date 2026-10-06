// Every word setup shows a person (design §4.7): one registry, so the same
// problem always reads the same way, with the same code, everywhere.
// Values in {braces} are filled in when shown.
const problem = (what, why, steps, stand) => ({ kind: 'problem', what, ...(why ? { why } : {}), steps, stand });
const line = (text) => ({ kind: 'line', text });
export const MESSAGES = {
    // ── Screens and prompts ─────────────────────────────────────────────
    'WELCOME': line('Universal Mail setup · version {version}\nThis builds your own private mail server in your Google Cloud account.\nYou can stop at any time and run it again later. It picks up where it stopped.'),
    'WELCOME-BACK': line('Welcome back. The last setup stopped at step {step} of 8. Continue? [Y/n]'),
    'STEP': line('Step {n} of 8 · {title}'),
    'STEP-1': line('Checking your Google Cloud account'),
    'STEP-2': line('Your email accounts'),
    'STEP-3': line('Creating your project'),
    'STEP-4': line('Turning on Google services'),
    'STEP-5': line('Setting the $1 cost alarm'),
    'STEP-6': line('Starting your server'),
    'STEP-7': line('Testing sending'),
    'STEP-8': line('Testing everything'),
    'WAITING-GOOGLE': line('Google is still turning this on. Usually under a minute.'),
    'SIGNED-IN': line('✓ Signed in as {email}'),
    'PERSONAL-ACCOUNT': line('✓ Personal account, no company restrictions'),
    'BILLING-ACTIVE': line('✓ Billing is active'),
    'ASK-ADDRESSES': line('Type each address you want to use, one per line.\nPress Enter on an empty line when you\'re done.'),
    'ASK-ADDRESS': line('›'),
    'ACCOUNTS-FOUND': line('✓ {count} accounts: {summary}'),
    'WHERE-PASSWORDS': line('Each one needs an app password. Here\'s where to make them:'),
    'PASSWORD-PLACE': line('  {provider}   {page} → "{button}"{prerequisites}'),
    'ACCOUNT-HEADING': line('{i} of {count} · {address}'),
    'ASK-APP-PASSWORD': line('App password  (nothing shows while you paste. That\'s normal) ›'),
    'ACCOUNT-OK': line('✓ Reading   ✓ Sending   ✓ {folders} folders'),
    'ASK-NAME': line('What should your AI call this one? [{suggested}] ›'),
    'ASK-SIGNIN': line('Which address should get your sign-in codes? [{suggested}] ›'),
    'ACCOUNT-SKIPPED': line('Skipped {address}. You can add it later on your Universal Mail page.'),
    'ASK-SEND-TEST': line('Send one test email to each account? [Y/n] ›'),
    'SENT-SAVED-BY-PROVIDER': line('✓ {name}   {provider} saves the Sent copy'),
    'SENT-SAVED-BY-US': line('✓ {name}   Universal Mail saves the Sent copy'),
    'CHECKS-PASSED': line('✓ {passed} of {total} checks passed'),
    'ALL-DONE': line('All done.\n\nYour Universal Mail page (bookmark it):\n    {page}\n\nFor your AI apps:\n    {mcp}\n\nYour page has step-by-step instructions for connecting Claude and ChatGPT.\nYour 30-day free trial started today: nothing to pay, and no card, until\nyou decide to keep it. Your page shows where things stand.'),
    'STUCK': line('Stuck? Type  node setup.js report  and paste what it shows into your AI.'),
    // ── The menu, on an existing installation (design §3.9) ─────────────
    'INSTALLED': line('Universal Mail is installed · version {version}'),
    'MENU': line(' 1  Check and fix   tests everything and repairs what it can\n 2  Update          installs the new version; undoes it if its test fails\n 3  Show my Universal Mail address\n 4  Remove          deletes Universal Mail and everything in it'),
    'ASK-MENU': line('Type a number and press Enter ›'),
    'CHECKING': line('Checking everything. This takes about a minute.'),
    'FIX-PASSWORD': line('{provider} no longer accepts the app password for {address}.\nMake a new app password on the {provider} page ({page}), then paste it here.'),
    'FIX-MICROSOFT': line('{address} signs in with Microsoft, which is renewed on your page, not here.\nOpen your Universal Mail page and press Sign in again for {name}.'),
    'FIXED': line('✓ Saved. Checking again.'),
    'REPAIRED-BILLING': line('✓ Billing had come unlinked from the project, and was linked again.'),
    'REPAIRED-SERVICES': line('✓ Google services were off, and were turned on again.'),
    'REPAIRED-ALARM': line('✓ The $1 cost alarm was missing, and was set again.'),
    'UP-TO-DATE': line('✓ You already have version {version}.'),
    'UPDATING': line('Installing version {version}, then checking it.'),
    'UPDATED': line('✓ Updated to version {version}.'),
    'ADDRESSES': line('Your Universal Mail page (bookmark it):\n    {page}\n\nFor your AI apps:\n    {mcp}'),
    'ASK-REMOVE': line('This deletes your Universal Mail server, its saved passwords and settings,\nand its Google project. Your email itself is not touched.\nTo go ahead, type  remove  and press Enter. Anything else keeps it ›'),
    'REMOVED': line('✓ Removed. Google finishes deleting the project within 30 days, at no charge.'),
    'KEPT': line('Nothing was removed.'),
    // ── Update from version 1 (design §10) ──────────────────────────────
    'ASK-CONVERT': line('Version 1 of this mail server is running in this Google project.\nUpdate it to Universal Mail? Your account and settings carry over, and\nversion 1 keeps running, unchanged, until you remove it. [Y/n] ›'),
    'CONVERTED': line('Version 1 is still running, unchanged, as your fallback.\nIn Claude, remove the old connector and add the address above.\nOnce this works for you, version 1 can be deleted in your Google Cloud console.'),
    'USAGE': line('To set up or continue:  node setup.js\nTo see what happened:  node setup.js report'),
    // ── Problems ────────────────────────────────────────────────────────
    'SETUP-NOT-CLOUD-SHELL': problem('This needs to run in Google Cloud Shell.', 'Cloud Shell is where your Google account can build your server.', ['Go to the Universal Mail website', 'Click "Open in Cloud Shell"', 'Type  node setup.js  there and press Enter'], 'nothing'),
    'SETUP-INTERRUPTED': problem('Setup stopped before it was finished.', 'Ctrl+C stops setup, even when pressed to copy text.', ['Type  node setup.js  again. It picks up where it stopped.', 'To copy text from here, select it and right-click, then Copy'], 'nothing'),
    'SETUP-NOT-SIGNED-IN': problem('Cloud Shell isn\'t signed in to your Google account yet.', undefined, ['If Google asks you to "Authorize Cloud Shell", click Authorize', 'Otherwise close this tab and click "Open in Cloud Shell" again'], 'nothing'),
    'SETUP-UNEXPECTED': problem('Something unexpected went wrong at step {step} of 8.', 'This is often temporary, on Google\'s side.', ['Type  node setup.js  again. It continues from here.', 'If it happens again, type  node setup.js report  and paste what it shows into your AI'], 'saved'),
    'SETUP-NO-ACCOUNTS': problem('No email accounts were set up.', 'Universal Mail needs at least one to work with.', ['Type  node setup.js  again', 'Add at least one address, with its app password'], 'nothing'),
    'SETUP-BILLING-MISSING': problem('Google Cloud billing isn\'t set up yet.', 'Universal Mail is free, but Google needs a card on file before it will run anything, even free things.', ['Open  console.cloud.google.com/billing', 'Click "Create account" and add a card', 'Come back here and press Enter'], 'nothing'),
    'SETUP-BILLING-SUSPENDED': problem('Your Google Cloud billing account is closed or suspended.', 'Google won\'t run anything until it\'s active again.', ['Open  console.cloud.google.com/billing', 'Choose your billing account and fix what it shows', 'Come back here and press Enter'], 'nothing'),
    'SETUP-FREE-TRIAL': problem('Your Google Cloud account is on the free trial.', 'When the trial ends, Google switches off anything still running unless the account is upgraded. Upgrading is free: you\'re only charged beyond the free tier, and Universal Mail sets a $1 alarm so that can\'t sneak up on you.', ['Open  console.cloud.google.com/billing', 'Click "Activate full account"', 'Come back here and press Enter'], 'retry-or-skip'),
    'SETUP-ORG-POLICY': problem('Your Google account belongs to a company that blocks this kind of service.', 'Your AI app needs to reach your server over the internet, and your company\'s Google settings don\'t allow that. Use a personal Google account instead. Any Gmail address works.', ['Click your picture at the top right, then "Add another account"', 'Sign in with your personal Gmail', 'Click "Open in Cloud Shell" again'], 'nothing'),
    'SETUP-PROJECT-QUOTA': problem('Your Google account has reached its limit of projects.', 'Deleted projects still count toward the limit for 30 days.', ['Open  console.cloud.google.com/cloud-resource-manager', 'Select a project you no longer need and click Delete', 'Come back here and press Enter'], 'nothing'),
    'SETUP-IMAGE-UNTRUSTED': problem('The server download couldn\'t be verified, so it wasn\'t started.', 'It didn\'t carry Universal Mail\'s signature. This protects you from a tampered copy.', ['Wait a few minutes and type  node setup.js  again', 'If it happens again, type  node setup.js report  and share what it shows'], 'saved'),
    'SETUP-SELFTEST-FAILED': problem('The final check found a problem.', '{check}', ['Type  node setup.js report', 'Paste what it shows into your AI and ask what to do'], 'saved'),
    'GOOGLE-SERVICE-NOT-READY': problem('Google is taking longer than usual to turn on its services.', undefined, ['Wait a few minutes', 'Type  node setup.js  again. It continues from here.'], 'saved'),
    'GOOGLE-PERMISSION-NOT-READY': problem('Google is taking longer than usual to apply a permission.', undefined, ['Wait a few minutes', 'Type  node setup.js  again. It continues from here.'], 'saved'),
    'MAIL-APP-PASSWORD': problem('{provider} didn\'t accept that app password.', 'Usually a character was missed when copying, or it\'s your normal password instead of an app password.', ['On the {provider} page ({page}), click "{button}" to make a new one', 'Click its Copy button', 'Paste it here and press Enter'], 'retry-or-skip'),
    'MAIL-UNREACHABLE': problem('We couldn\'t reach {provider} to check {address}.', 'Your password hasn\'t been checked yet. This is usually a brief outage or a network problem.', ['Press Enter to try again with the same password', 'Or type s to skip it. You can add it later on your page.'], 'retry-or-skip'),
    'MAIL-INSECURE': problem('{provider} didn\'t offer a secure connection for {address}, so your password wasn\'t sent.', 'Universal Mail only signs in over an encrypted connection. Something on this network may be getting in the way.', ['Press Enter to try again', 'Or type s to skip it. You can add it later on your page.'], 'retry-or-skip'),
    'MAIL-PROVIDER-UNKNOWN': problem('We couldn\'t work out how to reach {address}.', 'Universal Mail recognizes the big providers and most others automatically.', ['Check the address for typos and type it again', 'Or type s to skip it. You can add it later on your page.'], 'retry-or-skip'),
    'MAIL-NO-SAFE-MOVE': problem('{provider} can\'t move messages safely, so moving is turned off for {address}.', 'Reading, searching and sending still work.', ['Press Enter to keep this account without moving', 'Or type s to skip it'], 'continue-or-skip'),
    'SETUP-UPDATE-ROLLED-BACK': problem('The new version didn\'t pass its check, so the previous one was put back.', '{check}', ['Your apps keep working as before', 'Type  node setup.js report  and paste what it shows into your AI'], 'handled'),
    'SENT-DUPLICATE': problem('{address} kept two copies of the test email in Sent.', 'Your provider and Universal Mail both saved one. From now on only your provider will.', ['Delete the extra test email from Sent if you like'], 'handled')
};
// 80 columns on screen, less the 2-space indent the screen adds.
const WIDTH = 78;
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`);
// Word-wrap to the width, with an indent for the first line and the rest.
function wrap(text, first, rest) {
    const lines = [];
    let current = first;
    for (const word of text.split(/\s+/).filter(Boolean)) {
        const candidate = current.trimEnd() === first.trimEnd() ? `${current}${word}` : `${current} ${word}`;
        if ([...candidate].length > WIDTH && current.trim() !== first.trim()) {
            lines.push(current);
            current = `${rest}${word}`;
        }
        else
            current = candidate;
    }
    lines.push(current);
    return lines;
}
const STANDS = {
    'nothing': 'Nothing was changed.',
    'saved': 'Your progress is saved.',
    'retry': 'Try again ›',
    'retry-or-skip': 'Try again, or type s to skip this for now ›',
    'continue-or-skip': 'Press Enter to continue, or type s to skip this account ›',
    'handled': 'This was handled for you.'
};
// A problem, laid out as in design §4.7.
// stand: overrides where the person stands, so it's always true (a problem that
// usually comes before any change can also come after one).
export function render(code, values = {}, options = {}) {
    const entry = MESSAGES[code];
    if (entry.kind !== 'problem')
        return renderLine(code, values);
    const out = [...wrap(fill(entry.what, values), '  ✗ ', '    '), ''];
    if (entry.why)
        out.push(...wrap(fill(entry.why, values), '    ', '    '), '');
    out.push('    What to do:');
    entry.steps.forEach((step, i) => out.push(...wrap(fill(step, values), `      ${i + 1}. `, '         ')));
    out.push('');
    const stand = STANDS[options.stand ?? entry.stand];
    const tag = `(${code})`;
    const gap = WIDTH - 4 - [...stand].length - tag.length;
    out.push(gap >= 2 ? `    ${stand}${' '.repeat(gap)}${tag}` : `    ${stand}`, ...(gap >= 2 ? [] : [`${' '.repeat(WIDTH - tag.length)}${tag}`]));
    return out.join('\n');
}
// The same problem in plain parts, for your page: the same words, without the
// terminal's layout or its prompt.
export function problemText(code, values = {}) {
    const entry = MESSAGES[code];
    if (entry.kind !== 'problem')
        return fill(entry.text, values);
    return [fill(entry.what, values), ...(entry.why ? [fill(entry.why, values)] : []), ...entry.steps.map((step, i) => `${i + 1}. ${fill(step, values)}`), `(${code})`].join('\n');
}
export function renderLine(code, values = {}) {
    const entry = MESSAGES[code];
    if (entry.kind === 'problem')
        return render(code, values);
    return fill(entry.text, values).split('\n').flatMap(l => l.trim() ? wrap(l, l.match(/^\s*/)[0], l.match(/^\s*/)[0]) : ['']).join('\n');
}
//# sourceMappingURL=messages.js.map