import type { Action } from './grants.js';

// The approval page. Everything shown goes through escape(); the only things
// an app supplies that are ever shown are its name (escaped) and its verified
// origin. State, redirect addresses and hints stay on the server.

export const escape = (text: string) => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// "personal@example.invalid" → "p•••@e•••.invalid": enough to recognise, not to learn.
export function mask(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  const labels = domain.split('.');
  const tld = labels.length > 1 ? labels.pop()! : '';
  return `${local.slice(0, 1)}•••@${(labels[0] ?? '').slice(0, 1)}•••${tld ? `.${tld}` : ''}`;
}

export type AppShown = { name: string; origin: string };

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
button{font-size:1rem;padding:.6rem 1rem}fieldset{margin:1rem 0}.note{color:#555}.error{color:#a00}</style>
</head><body>${body}</body></html>`;

const who = (app: AppShown) => `<strong>${escape(app.name)}</strong> <span class="note">(${escape(new URL(app.origin).host)})</span>`;
const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${escape(csrf)}">`;

// Only offered when a fingerprint is saved. The ceremony runs in a script from
// this origin (the page allows no other script, and none inline).
const fingerprintOption = (csrf: string) => `
<p><button type="button" id="passkey" data-csrf="${escape(csrf)}">Use your fingerprint instead</button></p>
<script src="/authorize/passkey.js"></script>`;

export function startPage(app: AppShown, signInAddress: string, csrf: string, hasFingerprint = false): string {
  return layout('Connect to Universal Mail', `
<h1>Connect ${who(app)} to your email?</h1>
<p>To approve, we'll email a code to <strong>${escape(mask(signInAddress))}</strong>.</p>
<form method="post" action="/authorize/code">${csrfField(csrf)}<button>Email me a code</button></form>${hasFingerprint ? fingerprintOption(csrf) : ''}
<form method="post" action="/authorize/deny">${csrfField(csrf)}<button>Don't connect</button></form>`);
}

export function codePage(app: AppShown, csrf: string, error?: string): string {
  return layout('Enter your code', `
<h1>Enter the code we emailed you</h1>
${error ? `<p class="error">${escape(error)}</p>` : ''}
<p>It connects ${who(app)}. It works once and lasts 10 minutes.</p>
<form method="post" action="/authorize/verify">${csrfField(csrf)}
<input name="code" autocomplete="one-time-code" placeholder="K7Q2-F9XM" required> <button>Continue</button></form>`);
}

export function permissionsPage(app: AppShown, accounts: string[], canSend: boolean, csrf: string, error?: string): string {
  const box = (account: string, action: Action, label: string, checked: boolean, disabled = false) =>
    `<label><input type="checkbox" name="${escape(`${account}:${action}`)}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${label}</label>`;
  const rows = accounts.map(account => `<fieldset><legend>${escape(account)}</legend>
${box(account, 'read', 'Read', true)} ${box(account, 'organize', 'Organize (drafts, folders, moves)', false)}
${box(account, 'send', 'Send', false, !canSend)}</fieldset>`).join('\n');
  return layout('Choose what it can do', `
<h1>What may ${who(app)} do?</h1>
${error ? `<p class="error">${escape(error)}</p>` : ''}
<form method="post" action="/authorize/approve">${csrfField(csrf)}${rows}
${canSend ? '' : '<p class="note">Sending needs your fingerprint. You can add one on your Universal Mail page.</p>'}
<button>Connect</button></form>`);
}

// The fingerprint ceremony, in the browser: options from the server, the
// device signs, the answer goes back, and the permissions page replaces this one.
// data-base (your page) says where its two halves live; the approval page's are the default.
export const PASSKEY_SCRIPT = `(() => {
  const button = document.getElementById('passkey');
  if (!button || !window.PublicKeyCredential) return;
  const csrf = button.dataset.csrf;
  const base = button.dataset.base || '/authorize/passkey';
  const bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const text = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  button.addEventListener('click', async () => {
    const form = new URLSearchParams({ csrf });
    const options = await (await fetch(base + '/options', { method: 'POST', body: form })).json();
    const credential = await navigator.credentials.get({ publicKey: {
      ...options, challenge: bytes(options.challenge),
      allowCredentials: (options.allowCredentials || []).map(c => ({ ...c, id: bytes(c.id) }))
    } });
    const r = credential.response;
    const response = { id: credential.id, rawId: text(credential.rawId), type: credential.type, clientExtensionResults: {},
      response: { clientDataJSON: text(r.clientDataJSON), authenticatorData: text(r.authenticatorData), signature: text(r.signature),
        userHandle: r.userHandle ? text(r.userHandle) : undefined } };
    const page = await fetch(base + '/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf, response }) });
    if (button.dataset.base) { location.reload(); return; }
    document.open(); document.write(await page.text()); document.close();
  });
})();`;

export function errorPage(message: string): string {
  return layout('Universal Mail', `<h1>Couldn't continue</h1><p>${escape(message)}</p>`);
}
