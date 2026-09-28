import { escape, mask } from '../signin/pages.js';
import type { Action, Grant } from '../signin/grants.js';
import type { SubscriptionState } from '../subscription/state.js';
import { longDate } from '../subscription/subscription.js';

// Your Universal Mail page (design §3.6). Everything shown goes through
// escape(). It never shows email content, a password or a token: passwords
// can be typed in, never shown back.

export type AccountView = { name: string; email: string; sending: boolean; status: 'working' | 'password' | 'unknown'; lastUsed?: number };
export type AppView = Grant & { lastUsed?: number };

// Readable at phone width: one column, nothing wider than the screen.
const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;max-width:40rem;margin:1rem auto;padding:0 1rem;line-height:1.5;overflow-wrap:anywhere}
button,input,select{font-size:1rem;max-width:100%}button{padding:.5rem .9rem;margin:.2rem 0}input[type=text],input[type=email],input[type=password]{width:100%;padding:.4rem}
section{border-top:1px solid #ddd;margin-top:1.2rem;padding-top:.6rem}.row{margin:.6rem 0}.note{color:#555}.error{color:#a00}.ok{color:#060}
textarea{width:100%;min-height:12rem;font-family:ui-monospace,monospace;font-size:.8rem}fieldset{margin:.5rem 0;min-width:0}</style>
</head><body>${body}</body></html>`;

const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
const form = (base: string, path: string, csrf: string, inner: string, label: string) =>
  `<form method="post" action="${escape(`${base}${path}`)}">${csrfField(csrf)}${inner}<button>${escape(label)}</button></form>`;

export function ago(then: number | undefined, now: number): string {
  if (!then) return 'not used yet';
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return 'last used just now';
  if (minutes < 60) return `last used ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `last used ${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `last used ${Math.round(hours / 24)} days ago`;
}

export function signInPage(base: string, signInAddress: string, csrf: string, hasFingerprint: boolean, error?: string): string {
  return layout('Universal Mail', `
<h1>Sign in to your Universal Mail page</h1>
${error ? `<p class="error">${escape(error)}</p>` : ''}
<p>We'll email a code to <strong>${escape(mask(signInAddress))}</strong>.</p>
${form(base, '/signin/code', csrf, '', 'Email me a code')}
${hasFingerprint ? `<p><button type="button" id="passkey" data-csrf="${escape(csrf)}" data-base="${escape(`${base}/signin/passkey`)}">Use your fingerprint instead</button></p>
<script src="${escape(`${base}/passkey.js`)}"></script>` : ''}`);
}

export function codeEntryPage(base: string, csrf: string, error?: string): string {
  return layout('Enter your code', `
<h1>Enter the code we emailed you</h1>
${error ? `<p class="error">${escape(error)}</p>` : ''}
<p>It works once and lasts 10 minutes.</p>
<form method="post" action="${escape(`${base}/signin/verify`)}">${csrfField(csrf)}
<input type="text" name="code" autocomplete="one-time-code" placeholder="K7Q2-F9XM" required> <button>Sign in</button></form>`);
}

const ACTIONS: Array<[Action, string]> = [['read', 'Read'], ['organize', 'Organize'], ['send', 'Send']];

// The subscription in one line (design §13.1).
function subscriptionLine(s: SubscriptionState): string {
  switch (s.state) {
    case 'trial': return `Free trial: ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left. Nothing to pay, and no card, until you decide to keep it.`;
    case 'active': return `Paid through ${longDate(Date.parse(s.paidThrough))}.${s.portal ? ` <a href="${escape(s.portal)}">Manage or cancel</a>` : ''}`;
    case 'grace': return s.after === 'trial'
      ? `<span class="error">Your trial has ended.</span> Everything keeps working for ${s.daysLeft} more day${s.daysLeft === 1 ? '' : 's'}; then organizing and sending pause until you subscribe.`
      : `<span class="error">Your subscription couldn't be renewed.</span> Everything keeps working for ${s.daysLeft} more day${s.daysLeft === 1 ? '' : 's'}.`;
    case 'read-only': return '<span class="error">Universal Mail is read-only.</span> Reading and search work; organizing and sending are paused until you subscribe.';
    case 'unlimited': return '';
  }
}

export function dashboard(view: {
  base: string; csrf: string; now: number; accounts: AccountView[]; apps: AppView[]; canGrantSend: boolean;
  subscription?: SubscriptionState; buyUrl?: string;
  message?: { kind: 'ok' | 'error'; text: string }; report?: string; problem?: string;
}): string {
  const { base, csrf } = view;
  const subscription = view.subscription && view.subscription.state !== 'unlimited' ? `<section><h2>Subscription</h2>
<p>${subscriptionLine(view.subscription)}</p>
${view.subscription.state === 'active' ? '' : `<p><a href="${escape(view.buyUrl ?? '')}">Subscribe</a>: $4 a month or $36 a year, any number of accounts. Your receipt shows a license code.</p>`}
<details><summary>${view.subscription.state === 'active' ? 'Enter a different license code' : 'Enter your license code'}</summary>
${form(base, '/subscription/activate', csrf, '<label>License code <input type="text" name="code" autocomplete="off" placeholder="UM-XXXX-XXXX-XXXX" required></label>', 'Activate')}
</details></section>` : '';
  const accounts = view.accounts.map(a => `<div class="row" id="account-${escape(a.name)}">
<strong>${escape(a.name)}</strong> ${escape(mask(a.email))} ·
${a.status === 'password' ? '<span class="error">⚠ Password not accepted</span>' : a.status === 'working' ? '<span class="ok">Working</span>' : '<span class="note">Not checked yet</span>'}
· <span class="note">${escape(ago(a.lastUsed, view.now))}</span> · Sending ${a.sending ? 'on' : 'off'}
<details${a.status === 'password' ? ' open' : ''}><summary>${a.status === 'password' ? 'Fix it' : 'Change the app password'}</summary>
${form(base, '/accounts/password', csrf, `<input type="hidden" name="name" value="${escape(a.name)}"><label>New app password <input type="password" name="password" autocomplete="off" required></label>`, 'Save password')}
</details>
${form(base, '/accounts/sending', csrf, `<input type="hidden" name="name" value="${escape(a.name)}"><input type="hidden" name="on" value="${a.sending ? 'off' : 'on'}">`, a.sending ? 'Turn sending off' : 'Turn sending on')}
${form(base, '/accounts/remove', csrf, `<input type="hidden" name="name" value="${escape(a.name)}"><label>Type the account name to remove it <input type="text" name="confirm" autocomplete="off"></label>`, 'Remove account')}
</div>`).join('\n');

  const apps = view.apps.length ? view.apps.map(app => {
    const name = app.appName ?? new URL(app.appId).host;
    const boxes = view.accounts.map(a => `<fieldset><legend>${escape(a.name)}</legend>${ACTIONS.map(([action, label]) => {
      const checked = app.accounts[a.name]?.includes(action);
      const disabled = action === 'send' && !checked && !view.canGrantSend;
      return `<label><input type="checkbox" name="${escape(`${a.name}:${action}`)}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${label}</label>`;
    }).join(' ')}</fieldset>`).join('');
    return `<div class="row"><strong>${escape(name)}</strong> <span class="note">(${escape(new URL(app.appId).host)}) · ${escape(ago(app.lastUsed, view.now))}</span>
<details><summary>Permissions</summary>${form(base, '/apps/permissions', csrf, `<input type="hidden" name="app" value="${escape(app.appId)}">${boxes}${view.canGrantSend ? '' : '<p class="note">Giving Send needs your fingerprint.</p>'}`, 'Save permissions')}</details>
${form(base, '/apps/disconnect', csrf, `<input type="hidden" name="app" value="${escape(app.appId)}">`, 'Disconnect')}</div>`;
  }).join('\n') : '<p class="note">No apps are connected yet.</p>';

  return layout('Universal Mail', `
<div style="text-align:right">${form(base, '/signout', csrf, '', 'Sign out')}</div>
<h1>Universal Mail</h1>
${view.message ? `<p class="${view.message.kind}">${escape(view.message.text)}</p>` : ''}
${view.problem ? `<pre class="error" style="white-space:pre-wrap">${escape(view.problem)}</pre>` : ''}
<section><h2>Your accounts</h2>${accounts}
<details><summary>Add an email account</summary>
${form(base, '/accounts/add', csrf, `<label>Email address <input type="email" name="email" required></label><label>App password <input type="password" name="password" autocomplete="off" required></label><label>Name for your AI (optional) <input type="text" name="name" autocomplete="off"></label>`, 'Check and add')}
</details></section>
<section><h2>Connected apps</h2>${apps}
<details><summary>Connect an AI app</summary><p>In Claude: Settings → Connectors → Add custom connector, and paste your AI-app address (the one setup showed, ending in /mcp). In ChatGPT: Settings → Connectors → Create, and paste the same address. Then approve it with a code.</p></details></section>
${subscription}
<section><h2>Health</h2>${form(base, '/check', csrf, '', 'Check that everything works')}
${view.report ? `<p>Copy this report and paste it into your AI for help. It contains no mail and no secrets.</p><textarea readonly>${escape(view.report)}</textarea>` : ''}</section>
<section><h2>Sign-in</h2><p><button type="button" id="fingerprint" data-csrf="${escape(csrf)}" data-base="${escape(`${base}/fingerprint`)}">Add a fingerprint</button></p>
<script src="${escape(`${base}/fingerprint.js`)}"></script></section>`);
}

// Adding a fingerprint, in the browser: options from the server, the device
// makes a key pair, the public half goes back.
export const FINGERPRINT_SCRIPT = `(() => {
  const button = document.getElementById('fingerprint');
  if (!button || !window.PublicKeyCredential) return;
  const { csrf, base } = button.dataset;
  const bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const text = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  button.addEventListener('click', async () => {
    const options = await (await fetch(base + '/options', { method: 'POST', body: new URLSearchParams({ csrf }) })).json();
    const credential = await navigator.credentials.create({ publicKey: {
      ...options, challenge: bytes(options.challenge), user: { ...options.user, id: bytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map(c => ({ ...c, id: bytes(c.id) }))
    } });
    const r = credential.response;
    const response = { id: credential.id, rawId: text(credential.rawId), type: credential.type, clientExtensionResults: {},
      response: { clientDataJSON: text(r.clientDataJSON), attestationObject: text(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } };
    await fetch(base + '/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf, response }) });
    location.reload();
  });
})();`;
