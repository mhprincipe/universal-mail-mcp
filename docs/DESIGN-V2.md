# Universal Mail MCP — design

**Status:** final proposal, 2026-09-24. Nothing here is built yet.
**Product:** Universal Mail MCP. In anything a person reads, "Universal Mail".
**Carries forward:** the v1 mail engine, its 16 tools and its safety rules.
**Replaces:** everything around the engine — sign-in, app approval,
configuration, deployment, verification and day-to-day management.

---

## 1. What it is

**One person connects all of their email accounts, on any common provider, to
their AI apps, through a private server in their own Google Cloud account that
costs nothing, takes one command to set up, and is looked after from a web
page.**

### Principles

1. **Easy for someone who has never used a command line.** Every instruction is
   a click or one line to type. No jargon on screen.
2. **Works first time.** Everything is checked before anything changes.
   Anything that still fails says, in plain English, exactly what to do next.
   Running setup again is always safe.
3. **Free.** Google Cloud free tier only, with a $1 alarm as a backstop.
4. **Responsible.** Safe defaults, least privilege, and nothing an AI can be
   tricked into that it shouldn't be able to do.
5. **Not every contingency.** A feature earns its place by preventing a common
   failure or a serious harm. Rare cases are deferred or cut, and §12 records
   which and why.

v1 proved the engine: all 16 tools against a real mailbox, with the safety
rules intact. It also proved the problem. Setup took most of a day, needed two
external accounts configured by hand, and failed silently at almost every step.
Universal Mail fixes the second without touching the first.

---

## 2. Scope

### In

- **Google Cloud only.** Free tier, Cloud Run, set up from Cloud Shell in the
  browser.
- **Any provider that issues app passwords:** Yahoo, AOL, iCloud, Fastmail,
  Gmail, Zoho, custom domains hosted on them, generic IMAP.
- **Any number of email accounts** for one person. Designed and tested for up
  to 20.
- **AI apps that support the open MCP sign-in standard with published app
  identities:** Claude (tested) and ChatGPT (supported, not yet verified) at
  launch. Others are added in updates as they adopt the standard.
- **The 16 v1 tools**, extended for multiple accounts.
- **Your Universal Mail page** for everyday management, and email
  notifications for anything that matters.

### Out

Hosting anywhere but Google Cloud. Running on your own computer. More than one
person per server. Attachments, folder rename or delete, permanent delete, mail
rules, forwarding, account settings. The full list of deferred and cut items,
with reasons, is in §12.

---

## 3. The experience

This section is the specification. Everything after it exists to make it true.

### 3.1 Three places, one job each

| Where | When | For |
|---|---|---|
| **Cloud Shell** | once at setup, then rarely | building the server, updates, removal |
| **Your AI app** | every day | talking to your mail |
| **Your Universal Mail page** | occasionally, any browser or phone | accounts, permissions, status, fixing things |

Email from Universal Mail ties them together: anything that changes or breaks,
you hear about, with a link to fix it.

### 3.2 Before you start

- **A Google account.** A personal Gmail works. Work accounts are often blocked
  by company settings.
- **A card on file with Google Cloud.** Google requires one even for free use.
  Universal Mail stays within the free tier, expects to cost **$0**, and sets a
  **$1 alarm**.
- **An app password for each email account.** Setup shows exactly where to make
  each one, so this can happen before or during setup.

### 3.3 Setup

About 15 minutes for one account and 30 for five, most of it spent making app
passwords.

**What the person does:**

1. On the Universal Mail website, click **Open in Cloud Shell**.
2. Google asks to confirm opening it. Click **Confirm**. Cloud Shell opens with
   a step-by-step panel on the right.
3. In the panel, click the copy button beside `node setup.js`. It's pasted into
   the dark area at the bottom. Press **Enter**.
4. If Google asks you to **Authorize Cloud Shell**, click **Authorize**.
5. Answer the questions. To paste, press **Ctrl+V** or right-click → **Paste**.

**The eight steps.** The person acts in two of them:

| Step | You |
|---|---|
| 1 · Checking your Google Cloud account | watch — or, on the free trial, click **Activate full account** once (§4.6) |
| **2 · Your email accounts** | **type each address, paste each app password (each is tested immediately), name each account, choose your sign-in address** |
| 3 · Creating your project | watch |
| 4 · Turning on Google services | watch ("this can take a minute") |
| 5 · Setting the $1 cost alarm | watch |
| 6 · Starting your server | watch |
| **7 · Testing sending** | **press Enter to send one test email to each account** |
| 8 · Testing everything | watch — every account, every tool |

```text
  Universal Mail setup · version 2.0.0
  This builds your own private mail server in your Google Cloud account.
  You can stop at any time and run it again later. It picks up where it stopped.

  Step 1 of 8 · Checking your Google Cloud account
    ✓ Signed in as you@gmail.com
    ✓ Personal account — no company restrictions
    ✓ Billing is active

  Step 2 of 8 · Your email accounts
    Type each address you want to use, one per line.
    Press Enter on an empty line when you're done.
    › you@yahoo.com
    › fleet@gmail.com
    ›
    ✓ 2 accounts: 1 Yahoo, 1 Gmail

    Each one needs an app password. Here's where to make them:
      Yahoo   login.yahoo.com → Account security → Generate app password
      Gmail   myaccount.google.com/apppasswords   (2-Step Verification must be on)

    1 of 2 · you@yahoo.com
      App password  (nothing shows while you paste — that's normal) ›
      ✓ Reading   ✓ Sending   ✓ 28 folders
      What should your AI call this one? [yahoo] › personal

    2 of 2 · fleet@gmail.com
      App password ›
      ✓ Reading   ✓ Sending   ✓ 9 folders
      What should your AI call this one? [gmail] › fleet

    Which address should get your sign-in codes? [personal] ›

  Step 3 of 8 · Creating your project           ✓
  Step 4 of 8 · Turning on Google services      ✓ (41 seconds)
  Step 5 of 8 · Setting the $1 cost alarm       ✓
  Step 6 of 8 · Starting your server            ✓

  Step 7 of 8 · Testing sending
    Send one test email to each account? [Y/n] ›
    ✓ personal   Yahoo saves the Sent copy
    ✓ fleet      Gmail saves the Sent copy

  Step 8 of 8 · Testing everything
    ✓ 82 of 82 checks passed

  ─────────────────────────────────────────────────────────────────────
  All done.

  Your Universal Mail page — bookmark it:
      https://universal-mail-4f2a-uc.a.run.app/7f3kq2

  For your AI apps (both accounts):
      https://universal-mail-4f2a-uc.a.run.app/7f3kq2/mcp

  Your page has step-by-step instructions for connecting Claude and ChatGPT.
  ─────────────────────────────────────────────────────────────────────
```

**Rules behind the screen:**

- **Plain words only.** No "IMAP", "OAuth", "deploy" or "environment" on
  screen. Technical detail goes in the saved report.
- **"Step N of 8"** throughout. Say when a step is slow, and why.
- **Email passwords are checked before anything is created in Google Cloud**, so
  a wrong password never leaves a half-built project behind.
- **Every question has a safe default in brackets.** Pressing Enter is always
  right.
- **Hidden input is announced.** Nothing appears when pasting a password; say
  so, or people will think it's broken.
- **A bad account can be skipped** (`s`) and added later from the page. The rest
  carry on.
- **"All done" appears only after the self-test passes.**
- **Setup leaves nothing behind.** Test items it creates are removed.
- **Passwords never touch disk.** They go from the prompt to Google's secret
  store.

### 3.4 Connecting an AI app

About 2 minutes. The person pastes the AI-app address into the app. Your page
has current instructions for each app, because vendors move their menus. For
Claude: **Settings → Connectors → Add custom connector**.

The app sends you to an approval page on **your own server**:

```text
  Claude wants access to your mail                  Read   Organize   Send
    personal   m•••@yahoo.com                          ☑        ☑       ☐
    fleet      b•••@gmail.com                          ☑        ☐       ☐
    [ Select all ]                         Sending needs your fingerprint.

  We've emailed a code to m•••@yahoo.com
  Code  [ ____-____ ]                         [ Approve ]   [ Deny ]

  or  [ Use fingerprint or face instead ]
```

- **One code approves every account.** It goes to the sign-in address.
- **Send starts unticked.** Ticking it asks for a fingerprint, face, or device
  PIN. If none is set up yet, the page sets one up right there.
- **Each app is approved separately,** with its own choices per account.
  Disconnecting one never affects another.
- **The page loads nothing the app supplies** — no logos, no remote images —
  and shows addresses partly masked.
- **Afterwards, an email:** *"Claude was connected to your mail."*
- **After a code approval, the page offers the upgrade:** *"Use your fingerprint
  next time instead of a code? [Set it up] [Not now]"*.

App status is honest on the page and in the docs: **Claude — tested.
ChatGPT — supported, not yet verified.**

### 3.5 Everyday use

The person talks to their AI:

- *"Find the Marriott timeshare email"* — searches every account at once, and
  says which account each result came from.
- *"Archive every LinkedIn job alert in personal from this week"* — one account
  by name, bulk work in a few quick steps.
- *"Draft a reply to Tom saying Thursday works"* — if more than one account
  could send it, the AI asks which.

Behind that:
- The AI reads the plain text of an email by default, not 100 KB of HTML.
- Looking at an email never marks it read.
- Mail is never filed into a guessed folder.
- An uncertain send is reported, never retried.
- Errors carry the fix in plain words.

### 3.6 Your Universal Mail page

Sign in with a code emailed to your sign-in address, or with your fingerprint.

```text
  Universal Mail                                           Sign out

  Your accounts
    ● personal   m•••@yahoo.com     Working · last used 2 minutes ago
    ● fleet      b•••@gmail.com     ⚠ Password not accepted — [Fix it]
    [ Add an email account ]

  Connected apps
    Claude    tested       2 accounts · Read, Organize · last used 2 min ago  [Disconnect]

  [ Connect an AI app ]   [ Check that everything works ]   [ Copy a report for help ]
```

| Section | What you can do |
|---|---|
| Accounts | see status; **Fix it**; add an account (the same guided checks as setup); change a password; remove an account |
| Connected apps | see what each app can reach and when it last did; change its permissions; disconnect |
| Connect an AI app | current step-by-step instructions for each supported app |
| Sending | turn sending on or off per account; see the last Sent-copy test |
| Sign-in | set up a fingerprint; change the sign-in address |
| Health | **Check that everything works**; **Copy a report for help** |

**The page never shows** email content, passwords or tokens. Passwords can be
entered, never displayed. Sessions end after 15 minutes idle. Every change is
emailed to you.

### 3.7 Emails you'll get

| Email | When |
|---|---|
| **Sign-in code** | you — or anyone — start an approval or a page sign-in. It says: *"Someone is trying to connect an AI app to your mail or sign in to your Universal Mail page. If you didn't just do this yourself, ignore this email and never share the code."* |
| **Something changed** | an app connected or disconnected; an account added, removed or its password changed; sending turned on; a fingerprint added |
| **Something broke** | an account's password stopped working, with a **Fix it** link |
| **Free trial ending** | before day 80, if the Google account was never upgraded (§4.6) |
| **Update available** | a new version exists; security updates are marked |
| **Cost alarm** | from Google, only if a month ever passes $1 |

System emails go to the sign-in address. If that account can't send, they go
out through any other working account. Every one is hidden from the AI (§6.5).

### 3.8 When something goes wrong

| # | Where | What you do |
|---|---|---|
| 1 | Your AI app | follow the fix in the error message |
| 2 | Email | click the link in the "something broke" email |
| 3 | Your page | click **Fix it**, or **Check that everything works** |
| 4 | Your page | **Copy a report for help** and paste it into your AI. It contains no mail and no secrets |
| 5 | Cloud Shell | if the page won't load or no code can be sent: **Open in Cloud Shell** → `node setup.js` → **1 — Check and fix** |

**Nobody can be permanently locked out.** Codes are sent through any working
account. If none works, Cloud Shell's **Check and fix** repairs the password.

### 3.9 Cloud Shell, later

Running `node setup.js` again on an existing installation shows:

```text
  Universal Mail is installed · version 2.0.0

   1  Check and fix           tests everything; repairs what it can
   2  Update                  installs the new version, tests it, undoes it if the test fails
   3  Show my Universal Mail address
   4  Remove Universal Mail   deletes the project and everything in it

  Type a number and press Enter ›
```

Always start from **Open in Cloud Shell**. It fetches the current setup file, so
it doesn't matter if Cloud Shell has cleared an old copy after months away.

---

## 4. Making it work every time

### 4.1 Check everything before changing anything

Steps 1 and 2 change nothing. They verify:

| Check | Catches |
|---|---|
| running in Cloud Shell; Node version | wrong place, unexpected environment |
| signed in, allowed to create a project | missing Authorize click, restricted account |
| billing exists and is active; free trial or full account | no card, suspended billing, the day-90 shutdown |
| no company policy blocking public services or new projects | work Google accounts |
| project quota available | accounts that have used their allowance |
| each address maps to a known provider or discoverable servers | typos, unusual providers |
| each app password works for reading **and** sending | wrong password, normal password pasted, accounts that can't use app passwords yet |
| special folders and safe-move capabilities present | providers too unusual to support safely |

When a check fails, the person gets the fix and a guarantee that nothing was
changed.

### 4.2 Wait for Google instead of racing it

Google reports changes as done slightly before they take effect. Turning on a
service, granting a permission and linking billing can each take seconds to
minutes to spread. This is the most common cause of scripted cloud setups
failing intermittently.

Every step that depends on one of these **checks until it's actually ready**,
with a generous timeout, and says so meanwhile: *"Google is still turning this
on — usually under a minute."* A timeout produces a clear message that's safe to
retry, never a stack trace.

### 4.3 Safe to run again

- **Every step checks whether it's already done** before doing it. Running
  twice never creates a second project, secret or server.
- **Progress is saved** in Cloud Shell's home folder, with no secrets in it. If
  the tab closes: *"Welcome back — the last setup stopped at step 6 of 8.
  Continue? [Y/n]"*.
- **The only thing re-entered after an interruption** is an app password that
  hadn't been stored yet.

### 4.4 Nothing built, nothing fetched mid-run

- **The setup file is self-contained.** It never installs packages while
  running.
- **The server is a pre-built, signed image**, published by CI to a public
  Artifact Registry repository. Setup checks its signature and pins it by
  digest. Nothing is compiled in the person's project, so there's no Cloud Build
  and no source upload — v1's largest category of deployment failures.
- **Versions are locked.** Setup 2.0.0 installs server 2.0.0.

### 4.5 "Done" means tested

Step 8 runs the full self-test (§7) against every real mailbox, using only
test items it creates and then removes. "All done" appears only if every check
passes.

### 4.6 The free-trial shutdown

New Google Cloud accounts start on a 90-day free trial. When it ends, Google
pauses projects on accounts that were never upgraded. Upgrading costs nothing
by itself: the free tier still applies, and the $1 alarm still protects.

- **Step 1 detects a trial account** and asks the person to upgrade:
  *"When the trial ends, Google switches off anything still running unless the
  account is upgraded. Upgrading is free — you're only charged beyond the free
  tier, and Universal Mail sets a $1 alarm so that can't sneak up on you."*
  Two numbered clicks, then press Enter.
- **Skipping is allowed.** The page then shows a warning, and a "free trial
  ending" email goes out before day 80.

### 4.7 The message standard

Every message a person might see follows one pattern:

1. **What happened**, in one plain sentence.
2. **Why**, if it helps them fix it.
3. **What to do**, as numbered clicks with the exact names of buttons and pages.
4. **Where they stand**: *"Nothing was changed"*, *"Your progress is saved"*, or
   *"Try again ›"* when the fix can happen right at the prompt.
5. **A code**, for the report and for asking for help.

```text
  ✗ Google Cloud billing isn't set up yet.

    Universal Mail is free, but Google needs a card on file before it will run
    anything — even free things.

    What to do:
      1. Open  console.cloud.google.com/billing
      2. Click "Create account" and add a card
      3. Come back here and press Enter

    Nothing was changed.                                  (SETUP-BILLING-MISSING)
```

```text
  ✗ Your Google account belongs to a company that blocks this kind of service.

    Your AI app needs to reach your server over the internet, and your
    company's Google settings don't allow that.

    What to do:
      Use a personal Google account instead. Any Gmail address works.
      1. Click your picture at the top right → Add another account
      2. Sign in with your personal Gmail
      3. Click Open in Cloud Shell again

    Nothing was changed.                                  (SETUP-ORG-POLICY)
```

```text
  ✗ Yahoo didn't accept that app password.

    Usually a character was missed when copying, or it's your normal Yahoo
    password instead of an app password.

    What to do:
      1. On the Yahoo page, click "Generate app password" to make a new one
      2. Click its Copy button
      3. Paste it here and press Enter

    Try again, or type s to skip this account for now ›   (MAIL-APP-PASSWORD)
```

When the fix isn't obvious, every message ends: *"Stuck? Type
`node setup.js report` and paste what it shows into your AI."*

### 4.8 Outside our control

Some failures belong to Google or the mail provider. All are caught by §4.1,
before anything changes:

- Google holding a new billing account for verification
- company policies on work Google accounts
- providers that won't yet issue an app password to a new account
- an outage at Google or a provider

---

## 5. Staying free

| Service | Used for | How it stays free |
|---|---|---|
| **Cloud Run** | the server | scales to zero; one instance at most; CPU charged only while handling requests |
| **Secret Manager** | passwords, keys, state | two secrets; the latest version and one previous are kept, older ones destroyed |
| **Cloud Logging** | the request log | default retention; one short line per request |
| **Billing budgets** | the $1 alarm | budgets are free |

- **Never enabled:** Cloud Build, Compute Engine, databases, load balancers,
  anything with an always-on charge.
- **The alarm is an alarm, not a cap.** Google emails you when a month passes $1.
- **Setup states the expected cost: $0 a month** within the free tier.
- **Remove (Cloud Shell menu 4) deletes everything**, so nothing lingers.
- **Hosting the image is the publisher's cost**, not the user's.

---

## 6. Architecture

### 6.1 Shape

```text
                        ┌──────────────────── one container ──────────────────┐
 AI app ──────────────▶ │ /{key}/mcp ─▶ token + grant check ─▶ 16 tools         │
   │ sign-in standard   │                                          │            │
   └──────────────────▶ │ /authorize /token /revoke /jwks          ▼            │
                        │ approval page · codes · fingerprints  mail engine  ├──▶ IMAP / SMTP
 browser ─────────────▶ │ /{key}/  Your Universal Mail page     (from v1)    │    each account
                        │ /health · /.well-known/*   safe-parse worker        │
                        └────────────────▲──────────────────────▲─────────────┘
                                         │ 2 secrets            │ request log
                                   Secret Manager          Cloud Logging
                                         ▲
     setup.js (Cloud Shell) ─────────────┘   pulls a signed, pinned image
```

`{key}` is a random value generated at setup. The address alone reveals nothing,
and strangers can't start approvals or code emails without it.

### 6.2 Repository and releases

```text
packages/
  core/      mail engine — v1's engine, multi-account, provider profiles
  server/    HTTP, MCP transport, sign-in server, approval page, your page
  setup/     setup.js: steps, checks, messages, menu
  testkit/   capability profiles, IMAP fault proxy, fake gcloud, report schema
```

- **Releases are cut by CI only.** A release is a signed tag containing
  `setup.js` plus a signed image in a public Artifact Registry repository, with
  matching version numbers.
- **Open in Cloud Shell points at a pinned release tag**, so the file comes from
  the official repository at a known version. That source is what makes it
  trustworthy; a self-checksum inside the file would prove nothing.
- **Setup verifies the image signature** before deploying.

### 6.3 Configuration and state

**One input value: `PUBLIC_URL`**, read back from Cloud Run after the first
start. The resource URL, issuer, allowed host and discovery documents all derive
from it.

**Two secrets:**

| Secret | Contents |
|---|---|
| `universal-mail-credentials` | app passwords per account; token signing and encryption keys (with a short history, so older keys can still be checked) |
| `universal-mail-state` | accounts and provider profiles, sign-in address, the `{key}`, trusted app origins, **grants** (which app may do what in which account), revocation counters, fingerprint public keys, Sent mode and probe results, limits |

- **Writers:** setup at install and update; the server when you use your page or
  approve an app.
- **Writes are rare and owner-driven.** Each one reads the latest version,
  checks it hasn't changed, and retries on conflict.
- **The server reads both at startup** and keeps them in memory, refreshed on its
  own writes and at most every few minutes otherwise.
- **The server's identity** can read both secrets and add versions to them.
  Nothing else — no rights to deploy, delete, or touch billing.

### 6.4 Accounts and providers

**Every account has a name** (`personal`, `fleet`) and a provider profile:

| Profile field | Example (Yahoo) |
|---|---|
| match | domains `yahoo.com`, `ymail.com`, `rocketmail.com`; MX `*.yahoodns.net` |
| endpoints | `imap.mail.yahoo.com:993` TLS, `smtp.mail.yahoo.com:587` STARTTLS |
| app password | where to make it: page and button names, prerequisites such as 2-Step Verification |
| expected capabilities | MOVE, UIDPLUS, SPECIAL-USE |
| quirks | `unreliableHeaderSearch` |
| thread strategy | limited header scan |

**Detection order:** the known-domain table; an MX lookup, which catches custom
domains hosted on Google, Fastmail or Zoho; Thunderbird's public autoconfig
database; RFC 6186 SRV records; and only then a question.

**Capabilities are measured live and always win over the profile.** A mismatch
is recorded in the report.

**Thread strategy per provider** (red team P2):

| Provider shape | Strategy |
|---|---|
| Gmail | the Gmail thread ID extension: one search per thread |
| providers whose header search is reliable | header search alone, with no scan of recent messages *(changed during build from "`THREAD=REFERENCES`": see THR-02 in the test plan)* |
| Yahoo and others | scan recent headers in **Inbox, Sent, Archive and the seed message's folder**. A full scan of every folder happens only when asked for. |

**Launch profiles:** Yahoo, AOL, iCloud, Fastmail, Gmail with app password,
Zoho, generic IMAP.

### 6.5 Sign-in server

The server is its own sign-in (OAuth) server, which the MCP specification
allows.

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource/{key}/mcp` | resource metadata |
| `/.well-known/oauth-authorization-server` | server metadata; advertises CIMD, S256, and issuer identification (RFC 9207) |
| `/authorize` | the approval page |
| `/token` | authorization-code and refresh grants |
| `/revoke` | token revocation |
| `/jwks` | public signing keys |

One grant type with PKCE, plus refresh. No self-registration, OpenID Connect
ID tokens, userinfo or sessions.

**Which apps may connect.** An app identifies itself by an HTTPS address for its
published identity document (CIMD). It's accepted if that address is on a
trusted origin, which at launch means `claude.ai` and `chatgpt.com`. Updates add
origins as more apps adopt the standard. Nothing is imported or registered per
app.

**The identity-document fetch is the most dangerous code here**, because the app
chooses the address:
- HTTPS and trusted origins only, checked before any network activity.
- DNS is resolved first. Private, loopback, link-local and metadata addresses
  are refused, and the connection goes to the vetted address, which defeats DNS
  rebinding.
- No redirects; 5-second timeout; 64 KB limit.
- Redirect addresses are matched exactly against the fetched document.

**Tokens:**

| Token | Form | Lifetime |
|---|---|---|
| authorization code | encrypted (JWE), bound to app, redirect, PKCE challenge | 60 seconds |
| access token | signed (JWS, ES256): app ID, grant version | 15 minutes |
| refresh token | encrypted (JWE): app ID, grant version | lapses after 30 days unused |

**Grants live on the server, not in tokens.** Every request checks the app's
current grant — which accounts, which of Read, Organize, Send — against the
in-memory copy of `universal-mail-state`. This is what lets you:
- add an account to an app without reconnecting it
- change permissions instantly
- disconnect instantly (red team S5)

The tokens themselves stay stateless.

**Built on `jose`, not a full OAuth library.** Full libraries store codes and
refresh tokens through a storage layer, which would mean a database or a secret
write on every refresh. The subset needed here is small, so it's built directly
on `jose`, which already does v1's verification and all the cryptography. Protocol
conformance is enforced by the suite in §8.5.

#### Owner sign-in

The owner is whoever can read mail at the sign-in address, or holds a
fingerprint saved by that person.

**Codes, the default:**
- 8 characters from an unambiguous 30-character alphabet, shown as `K7Q2-F9XM`,
  compared in constant time.
- Single use; expire after 10 minutes; 5 wrong tries end a code.
- At most 5 codes an hour per account, plus a per-requester limit.
- Sent to the sign-in address through any working account.

**Fingerprint, face or device PIN (passkeys), optional:**
- Offered after a code approval, or from your page.
- **Required to grant Send**, and to add another fingerprint.

**System emails are invisible to the AI.** Codes, notifications and alerts carry
an `X-Universal-Mail: system` header and a server-generated Message-ID. Every
tool excludes them from every folder, and they're moved to Trash once used.

This closes the path where a prompt-injected AI reads a code and passes it on
(red team S1). Together with Send requiring a fingerprint and every new
connection being emailed, a leaked code can no longer quietly give a stranger
sending access to your mail.

### 6.6 Server runtime

- **One mail service per account**, created on first use, with v1's 30-second
  folder cache. A connection per operation, as in v1: batching and the cache
  already fixed the slowness seen in practice (§12).
- **Safe parsing.** Messages are parsed in a worker thread with a memory cap,
  a time limit, and limits on MIME depth, part count and header size. A message
  that fails returns *"This email couldn't be opened safely"* and is remembered,
  so it isn't parsed again (S3).
- **Response budget.** 100,000 characters per body part, 200,000 per response,
  with *"N more — use get_email"* markers (P3).
- **Search timeout.** A slow full-text search ends with a plain hint to narrow it
  (P8).
- **Structured request log.** One line per request: time, route, tool, account
  name, app origin, status, result code, milliseconds. Never content, addresses,
  tokens or claim values. "Last used" on your page comes from here.
- **Token and grant refusals are logged with a reason** and counted per app.
- **Cold starts.** Startup CPU boost, secrets loaded once at start, mail
  libraries loaded lazily (P4).
- **Graceful shutdown** on SIGTERM. The container runs `node` directly so the
  signal arrives.
- **Page and approval hardening:**
  - can't be framed by another site (`frame-ancestors 'none'`)
  - CSRF tokens bound to each request
  - `no-store` caching
  - masked addresses until signed in
  - rate limits
  - 15-minute idle sessions (S7–S9)

### 6.7 Tools

**The same 16 tools and names.** Changes from v1:

| Change | Why |
|---|---|
| `account` on every tool; **optional when the app can reach only one account** | multiple accounts, without burdening single-account users |
| each connection's tool list names only the accounts that app was granted | the AI can't name an account it doesn't have |
| `search_email` with no `account` searches all granted accounts at once | *"find the Marriott email"* works without knowing where it is |
| `get_email` / `get_thread` take `format`: `text` (default) or `full` | plain text by default; HTML only when wanted |
| `mark_read`, `mark_unread`, `flag_email` accept `uids` | batch, as moves already do |
| `search_email` returns a `cursor` | results beyond 100 become reachable |
| `get_thread` takes `allFolders` (default false) | the full scan is opt-in (P2) |
| every error carries a plain-English `remedy` | the fix, in the message |
| tool descriptions steer the model | batch with `uids`; re-find by `messageId` after a write; ask which account before sending |

**Carried from v1:** batch relocation, `messageId` search, `untrustedContent: true`
on every message, the response envelope and its four statuses, and every
safety rule. Moving mail between accounts isn't supported: copy-then-delete
across servers would break the no-guessing rules.

---

## 7. Diagnostics

### 7.1 Stages

A failed stage stops the stages that depend on it and marks them `NOT_RUN`.

| Stage | Checks |
|---|---|
| `google` | project, billing, trial status, services, server identity rights, cost alarm present |
| `server` | running version matches the setup file, image signature, `/health`, discovery |
| `signin` | the server issues and verifies an owner test token |
| `account:<name>` | reading and sending sign-in, folders, capabilities against the profile |
| `tools:<name>` | every read tool against real mail, metadata only |
| `live:<name>` | at install, update and "Check": every write tool on items it creates, then removes |
| `sent:<name>` | Sent mode and last probe |
| `apps` | per app: last request, refusal reasons over 24 hours |

### 7.2 The report

```json
{
  "report": "universal-mail-check",
  "schema": 1,
  "readme": "Stages run in order; NOT_RUN means an earlier stage failed. Each failure has a code, cause and fix. Contains no mail content, passwords, tokens or claim values.",
  "version": "2.0.0",
  "at": "2026-09-24T15:02:11Z",
  "result": "FAIL",
  "stages": [
    { "stage": "server", "status": "PASS" },
    { "stage": "account:fleet", "status": "FAIL",
      "code": "MAIL-APP-PASSWORD-REJECTED",
      "cause": "Gmail no longer accepts the app password.",
      "fix": "Make a new app password, then use Fix it on your Universal Mail page." },
    { "stage": "tools:fleet", "status": "NOT_RUN" }
  ],
  "facts": { "accounts": 2, "providers": ["yahoo", "gmail"], "trial": false }
}
```

**Redacted by construction.** The report builder accepts only typed fields.
Provider and Google error text is mapped to a code and never passed through, so
a report is always safe to paste into a chat.

### 7.3 One registry of codes

Every code — setup messages, tool errors, refusals, check stages, the page —
comes from one registry, each with a plain-English cause and fix. The same words
appear everywhere the code does.

| Family | Examples |
|---|---|
| `SETUP-` | `SETUP-BILLING-MISSING`, `SETUP-ORG-POLICY`, `SETUP-FREE-TRIAL` |
| `GOOGLE-` | `GOOGLE-SERVICE-NOT-READY`, `GOOGLE-PERMISSION-NOT-READY` |
| `MAIL-` | `MAIL-APP-PASSWORD`, `MAIL-NO-SAFE-MOVE`, `MAIL-PARSE-UNSAFE` |
| `SIGNIN-` | `SIGNIN-APP-NOT-TRUSTED`, `SIGNIN-CODE-EXPIRED`, `SIGNIN-FINGERPRINT-REQUIRED` |
| `SENT-` | `SENT-DUPLICATE`, `SENT-COPY-DELAYED` |
| tool codes | v1's 24 codes, each with a `remedy` |

---

## 8. Testing

### 8.1 Tiers

| Tier | Runs against | Catches | When |
|---|---|---|---|
| **Unit** | mocks and fault injection | logic, recovery rules — v1's 155 tests carried forward | every change |
| **Protocol** | a real IMAP server and SMTP capture, per provider profile | real protocol behavior, v1's biggest blind spot | every change, in CI |
| **Sign-in conformance** | the running sign-in server | protocol, SSRF, code and fingerprint defects | every change, in CI |
| **Setup** | a fake `gcloud` that can replay each Google failure | every message in §4.7 appears exactly as written; resume works from every step | every change, in CI |
| **Fresh install** | a real, empty Google Cloud project on a dedicated test billing account | the whole path, including Google's propagation delays | nightly, and before every release |
| **Live** | the owner's real accounts | provider surprises | install, update, "Check" |

The live tier is the same code as the owner's "Check that everything works".

### 8.2 Setup failure matrix

Each scenario asserts the exact message, the exact code, and that the stated
position ("nothing was changed", "progress saved") is true:

billing missing · billing suspended · free-trial account · org policy · project
quota · slow service enablement · slow permission spread · Cloud Shell
disconnect after each step · wrong app password · normal password pasted ·
unknown provider · provider without safe move · Sent duplicate · self-test
failure · update fails and rolls back.

### 8.3 Provider profiles

The 16-tool workflow runs against each profile, on a real IMAP server in a
container configured to advertise that profile's capabilities:

| Profile | Must prove |
|---|---|
| `yahoo-like` | limited scan finds replies; exactly one Sent copy |
| `gmail-like` | thread ID used; no duplicates from labels; moves act as label changes |
| `minimal` (UIDPLUS, no MOVE) | the UIDPLUS move path is safe |
| `hostile` (neither) | every move refuses and touches nothing |
| `server-sent` | the server saves exactly one Sent copy |
| **multi-account** | five accounts across profiles; search-all merges correctly; grants isolate accounts; one broken account doesn't affect the others |

A **fault proxy** in `testkit` sits between the server and the test mail server.
It drops connections after chosen commands, delays responses and blanks search
results, which reproduces Yahoo's broken header search, disconnect-after-DATA
and interrupted moves on a real protocol stack.

**Hostile-message corpus:** deep nesting, huge headers, malformed encodings.
Each must yield `MAIL-PARSE-UNSAFE`, never a crash.

### 8.4 Coverage and CI

Coverage is measured, with a floor that must not fall. CI runs the unit,
protocol, conformance and setup tiers on every push. A release is cut only after
the fresh-install test passes.

### 8.5 Sign-in conformance and security

- **Every flow:** code with PKCE, refresh, grant changes, disconnect,
  30-day lapse.
- **Every refusal:** untrusted origin, redirect mismatch, PKCE missing or
  `plain`, expired code, wrong audience, grant lacks the account or the action.
- **SSRF:** private, loopback, link-local and metadata addresses; DNS resolving
  to a private address; redirects; oversized and slow responses.
- **Codes:** sent only to the sign-in address; single use; expiry, attempt and
  rate limits enforced; system emails invisible to every tool in every folder.
- **Fingerprints:** required to grant Send; required to add another.
- **Pages:** framing refused, CSRF enforced, nothing app-supplied rendered, Send
  unticked by default.

### 8.6 "Tested with"

Your page and the docs list apps as **tested** only after a real connection
passes the live tier. At launch: Claude tested, ChatGPT supported.

---

## 9. Security model

### Trust roots

| Holder | Can |
|---|---|
| Google Cloud project owner | everything, including fixing sign-in from Cloud Shell. By design, the ultimate owner |
| the owner — reads the sign-in address, or holds a saved fingerprint | approve apps, grant permissions, use the page |
| an app's token | exactly its current grant, until disconnected or 30 days unused |

### Threats

| Threat | Control |
|---|---|
| A stranger's AI account obtaining your mail via a leaked code | system emails invisible to AI; Send needs a fingerprint; every connection emailed; code wording; unguessable `{key}` |
| Code guessing | 8 characters, 5 tries, 10 minutes, send limits |
| Hostile email crashing the server | sandboxed parsing, limits, poisoned-message memory |
| SSRF via app identity fetch | trusted origins, resolve-then-connect, private ranges refused, no redirects, limits |
| Protocol bugs | minimal subset, exact redirect match, S256 only, conformance suite |
| Approval-page phishing or clickjacking | trusted origins only; no app-supplied content; framing refused; CSRF |
| Tampered setup file or image | pinned signed release; image signature verified |
| Signing key theft | keys in Secret Manager; rotation with short history; 15-minute access tokens; instant grant revocation |
| Prompt injection from mail | `untrustedContent` on every message; Send off by default and fingerprint-gated; no rules or forwarding tools |
| Credentials leaking through diagnostics | typed report builder; provider and Google text never passed through |
| Surprise costs | free-tier-only services; $1 alarm; free-trial shutdown handled |

### Carried from v1 unchanged

No blind mutation retry. `UNKNOWN` rather than guessing. Reading never marks
mail read. Never invent a destination. Refuse unsafe moves. Replace a draft
before deleting the original. Never retry an ambiguous send. No permanent
delete.

---

## 10. Migrating from v1

Running setup in the Cloud Shell that holds the v1 deployment offers **Update
from version 1**:

1. Read the existing service and its Yahoo secret references.
2. Write the two secrets. Your Yahoo account becomes `personal`; its address
   becomes the sign-in address.
3. Map `SENT_COPY_MODE=yahoo` to the provider-saves Sent mode.
4. Start the new version. Discovery now points at the built-in sign-in server.
5. Claude's next request is refused, and it signs in again through the approval
   page. Reconnect the connector if it doesn't.
6. Run **Check and fix**. On success, the Auth0 tenant can be deleted.

Mail and folders are untouched throughout. The previous version remains the
rollback until step 6.

---

## 11. Delivery plan

Each phase ends usable, and only when its exit test passes.

| Phase | Delivers | Exit test |
|---|---|---|
| **1. Engine** | multi-account core with `account`; provider profiles and detection; safe parsing; provider-profile tests on a real IMAP server; fault proxy; hostile-message corpus; coverage and CI | the 16-tool workflow passes on every profile, including five accounts at once |
| **2. Sign-in** | built-in sign-in server; trusted-origin identity documents with SSRF guard; codes and optional fingerprints; approval page; server-side grants; invisible system emails; conformance suite | Claude connects to two accounts with Auth0 disabled; the security suite passes |
| **3. Setup** | Open in Cloud Shell; the eight steps; every §4.1 check including free-trial detection; waiting and resume; the message standard; the $1 alarm; signed image; fake-gcloud matrix; nightly fresh install | **a person who has never used a command line, given only §3, reaches "All done" on a new Google account with two providers** |
| **4. Your page and emails** | the page (§3.6) and every email in §3.7 | adding an account, fixing a revoked password and disconnecting an app all work from a phone |
| **5. Everyday polish** | `format`, batch flags, search cursor, response budget, per-provider threads, remedies | the 100-message cleanup that took 90+ calls in v1 takes under 10 |

---

## 12. Decisions

### Made

- Product name **Universal Mail MCP**; "Universal Mail" in anything a person
  reads.
- Google Cloud only; free tier only; $1 alarm; free-trial shutdown handled at
  setup.
- Open in Cloud Shell and `node setup.js`, for setup and everything later.
- Any number of accounts; one address for all apps and accounts; per-app,
  per-account Read / Organize / Send.
- Built-in, stateless sign-in server on `jose`, with grants on the server and
  trusted-origin identity documents.
- Codes by default; fingerprint optional, but required for Send.
- System emails invisible to the AI.
- Your Universal Mail page for day-to-day management; Cloud Shell only for
  machine tasks.
- Setup is the test run; "done" requires a passing self-test.
- One message standard and one code registry.
- Claude labelled **tested**; ChatGPT **supported, not yet verified**, until
  proven.

### Deferred — and what would bring each back

| Item | Why deferred | Revisit when |
|---|---|---|
| Microsoft accounts and Gmail without app passwords (XOAUTH2) | needs the person to register an app with Microsoft or Google — real extra setup | first follow-up release |
| Self-registering apps (developer tools) | fake-name risk, more to build, a mechanism the standard is moving away from | enough people ask, or a major app requires it |
| Connection pooling | batching and the folder cache already fixed the observed slowness; free-tier CPU makes pooling fragile | measurements show logins dominate response time |

### Cut — and why

| Item | Why |
|---|---|
| Adding apps by hand | only technical users would need it |
| Fingerprint-only mode | codes always work, so no one can be locked out, and a whole recovery flow disappears |
| Forced 90-day re-approval | a recurring nuisance for everyone against a rare risk. Instead, access lapses after 30 days unused, disconnect is instant, and "last used" is visible |
| Walled-off connectors per account | per-app, per-account grants already cover it |
| Hosts other than Google Cloud; running locally | one path, done well |
| The one-time setup link | nothing to register at install, so no window for a stranger to claim the server |
| Automatic updates | the server would need rights to redeploy itself, and a compromised release could take over every installation at once. Updates stay one prompted Cloud Shell step |
| Automatic organization: server-side rules, an activity digest, unattended-run features | the AI does the organizing through the existing batch move, flag and search tools, on whatever schedule the AI app offers. The server's job is a move that works |

### Red-team findings → resolution

| Finding | Resolution |
|---|---|
| S1 leaked code → stranger's AI account | invisible system emails; fingerprint for Send; connection emails; code wording; `{key}` |
| S2 setup-file integrity | pinned signed release via Open in Cloud Shell; image signature verified |
| S3 hostile email crash | sandboxed parsing with limits; poisoned-message memory |
| S4 weak codes | 8 characters; attempt limit as a second layer; constant-time compare |
| S5 slow revocation | grants checked on every request |
| S6 endless refresh tokens | lapse after 30 days unused; forced renewal cut (above) |
| S7 code-send abuse | per-account and per-requester limits; `{key}` |
| S8 address disclosure | masked until signed in |
| S9 framing and CSRF | framing refused; CSRF tokens; `no-store` |
| S10 persistent passkey | fingerprint required to add another; emailed; listed on the page |
| P1 reuse against throttled CPU | pooling deferred |
| P2 whole-mailbox thread scans | per-provider strategy; limited fallback; full scan opt-in |
| P3 response size | 200,000-character response budget |
| P4 cold starts | CPU boost; secrets at start; lazy loading |
| P5 Docker Hub pull limits | public Artifact Registry |
| P6 serialized parallel calls | deferred with pooling |
| P7 state reads | in-memory, refreshed on own writes |
| P8 slow search | timeout with a remedy |

---

## 13. Subscription *(added 2026-09-28: the owner's decision to charge for it)*

**The shape stays.** Universal Mail remains a private server in the person's
own Google account. Paying buys the product, its updates and its support; it
never buys us their mail, their passwords or a copy of anything. Nothing about
not paying touches their mail, which lives with their provider; their page
always works, so they can renew; Remove always works.

### 13.1 What the person sees

| When | What |
|---|---|
| Install | *"Your 30-day trial started today. Nothing to pay and no card until you decide to keep it."* (setup's All done, and the page) |
| Day 23 | email: *"Your Universal Mail trial ends in 7 days"*, with the page link |
| Day 30 | email: *"Your trial has ended"*; everything keeps working for 14 days |
| Day 44 | email: *"Universal Mail is now read-only"*: reading and search still work; organizing and sending answer with one plain sentence and the page link |
| Buying | the website (a link on the page) → the merchant of record's checkout → the receipt page shows a **license code** `UM-XXXX-XXXX-XXXX` |
| Activating | the page's **Subscription** section: paste the code → *"Paid through 28 October 2026"* |
| Renewing | nothing: the server renews on its own, daily |
| Not renewed (card failed, cancelled) | email: *"Your subscription couldn't be renewed"*; 14 days of grace; then read-only |

**Prices (defaults, the owner's to change):** $4 a month or $36 a year, per
person, any number of accounts. **Merchant of record:** Paddle by default (it
handles global sales tax, invoices, refunds and chargebacks).

### 13.2 How it works

- **The trial needs nothing.** It counts from `installedAt` (already saved at
  step 6). No key, no card, no call home.
- **A license is a signed token** (ES256, `jose`, as everything else here) from
  the **license service**: `iss` the service, `sub` the license code, `aud`
  this install's id, `exp` the paid-through date, `plan`, `portal` (the
  merchant's manage-subscription link). The server verifies it locally with the
  service's public key (`/jwks`), kept in state, so restarts and outages need
  no network.
- **The install id** is random, made by the server the first time it's needed
  and saved in state. The `{key}` never leaves the server.
- **Activation** posts `{ code, install }` to the service, which binds the
  install to the license (up to 3 installs per license, so a reinstall works)
  and returns the token. A wrong code: *"That code wasn't recognised."* The
  service unreachable: *"Couldn't reach the subscription service. Try again in
  a few minutes."* Nothing saved either way.
- **Renewal** is a duty (§3.7), daily with the update check: the same call;
  a fresh token moves `exp` forward. A refusal is noted (the email above). An
  outage leaves the license as it is: grace covers it.
- **States**, computed from the install date, the license and the clock:
  `trial` (days left) · `active` (paid through) · `grace` (14 days after the
  trial or the paid-through date: everything works) · `read-only`.
- **Read-only** is enforced in one place: the mail router. `read` actions pass;
  `organize` and `send` throw `SUBSCRIPTION-READ-ONLY` with the sentence and
  the page link, which the AI relays. The page, sign-in, Check and Remove are
  untouched.
- **The report's facts** carry `subscription: { state, daysLeft }`.

### 13.3 The license service

One small service of ours (`src/licenseService/`), deployed once to the
release project as `universal-mail-license`: the only thing we run.

| Route | Does |
|---|---|
| `GET /jwks` | the public signing key |
| `POST /activate` `{ code, install }` | binds the install, returns a token |
| `POST /renew` `{ code, install }` | a fresh token while the subscription is paid |
| `POST /webhook/paddle` | signature checked; `subscription.activated / updated / canceled / past_due` update the record; the first activation mints the code |
| `GET /buy` | to the checkout |

- **Storage:** Firestore (native mode, free tier) through its REST API as the
  service's own identity, the way the server writes secrets (§6.3). One
  document per license: email, plan, paid-through, status, installs, portal
  link, the merchant's subscription id. No mail, no passwords: nothing of the
  person's beyond an email address.
- **Signing key:** generated once by `scripts/license-setup.sh` into the release
  project's Secret Manager; the service reads it at start.
- **Abuse:** codes are 12 random characters (~60 bits); activation is limited
  per address; the service logs codes only as `{code}`.
- **The server finds the service** by `LICENSE_SERVICE_URL`, baked into the
  image at release like `UPDATE_FEED_URL`. Without it (a build from source),
  everything behaves as a permanent trial: no gate.

### 13.4 Decisions and what's deferred

- **Read-only, not locked.** Reading keeps working after a lapse because the
  person's mail is theirs and the AI reading it costs us nothing; organizing
  and sending are the paid work. The alternative (every tool refused) is one
  constant away, recorded in docs/OPEN-QUESTIONS.md as the owner's.
- **Grace before any refusal**, always 14 days, so a card that fails on a
  Friday never breaks someone's weekend.
- **The public repository stays public.** Anyone can build the image without
  the service address; they get the permanent trial. Paying customers buy the
  signed releases, updates and support.
- **Deferred:** team plans; a hosted page; offline licensing; refunds and
  cancellation flows (the merchant of record's); the website itself.
