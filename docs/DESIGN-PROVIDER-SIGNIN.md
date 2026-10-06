# Design for review: signing in with Microsoft (and Google)

**Status:** phase 1 built in 2.5.0 (2026-10-06): personal Outlook.com accounts. Waiting on the owner's registration (docs/MICROSOFT-SETUP.md). See §8 for what was decided and how it was built.
**Goal:** Outlook.com, Hotmail, Live and Microsoft 365 accounts, which no longer
accept app passwords; and, if the owner chooses, Gmail without app passwords.

---

## 1. Why

Microsoft turned off app passwords for Outlook.com mail (2024) and is retiring
password sign-in for mail programs in Microsoft 365. So the one sign-in method
Universal Mail uses today, an app password, can't reach the largest group of
mailboxes it doesn't cover. Google still allows app passwords for personal
Gmail (with 2-Step Verification), so Gmail works today; signing in with Google
would only remove a step.

## 2. What the person sees

On their page, **Add an email account → Sign in with Microsoft**:

1. The page shows a short code and a link (microsoft.com/devicelogin).
2. They open the link, type the code, sign in to Microsoft and approve
   "Universal Mail: read and send your mail".
3. The page notices within seconds, runs the usual checks (folders, a test
   email to themselves), and the account appears, like any other.

No password is typed into Universal Mail. Removing the account on the page
deletes what Microsoft issued; they can also revoke it in their Microsoft
account at any time.

**Why a code and not a redirect:** every installation has its own address, and
Microsoft needs every redirect address registered in advance. A code ("device
code" sign-in) needs no redirect address and no secret in the product, so one
registration serves every installation.

## 3. How it works

| Part | Design |
|---|---|
| **Registration** | One Microsoft Entra app registration, owned by the publisher: multi-tenant plus personal accounts, a public client (no secret), device-code sign-in allowed. Its client id is built into releases, like the update feed's address. |
| **Scopes** | `https://outlook.office.com/IMAP.AccessAsUser.All`, `https://outlook.office.com/SMTP.Send`, `offline_access`. Nothing else. |
| **Sign-in** | The server asks Microsoft for a device code, shows it on the page, and polls for the result (the interval Microsoft gives). |
| **Storage** | The refresh token is kept exactly like an app password: in `universal-mail-credentials`, never logged, never shown. Removing the account deletes it. |
| **Mail** | The same engine: IMAP and SMTP with XOAUTH2 (`outlook.office365.com`, `smtp.office365.com`). An access token lasts about an hour; a fresh one is fetched when the kept connection opens or its token has expired. |
| **Provider profile** | `outlook`: Microsoft's folder names ("Sent Items", "Deleted Items", "Junk Email", "Archive"), its Sent-copy behaviour (learned by the usual sending test), its quirks (learned live, as with Yahoo). |
| **Failure** | A refresh token Microsoft stops honouring (password changed, access revoked, 90 days unused) turns the account amber with **Sign in again**, and the "something broke" email, like a refused app password today. |

**Google (if chosen):** the same shape with Google's endpoints and the
`https://mail.google.com/` scope. See §5 for why this is a business decision.

## 4. Testing

- **Unit:** a fake Microsoft (device-code and token endpoints) in the test kit:
  approval, slow approval, declined, expired code, refresh, a revoked token.
- **Slow tier:** Dovecot can accept XOAUTH2 through its OAuth2 password
  database, validated against a fake token service: the real engine signs in
  with a token, re-authenticates when it expires, and fails cleanly when it's
  revoked.
- **Live:** an Outlook.com account (the owner's or a friend's), then a
  Microsoft 365 account, with the live-test prompt, as with Yahoo.

## 5. What only the owner can do, and decisions

1. **Microsoft:** create the app registration in a Microsoft Entra tenant
   (free), and, to avoid Microsoft's "unverified publisher" warning, complete
   **publisher verification** (needs a Microsoft Partner Network id, which
   needs a registered business: the same LLC step as selling).
2. **Microsoft 365 companies** can block this: some turn off IMAP/SMTP for their
   staff, require an administrator's approval for outside apps, or block
   device-code sign-in. Personal Outlook.com accounts work cleanly.
   **Decision:** accept that for phase 1; plan a phase 2 on Microsoft Graph
   only if business customers need it.
3. **Google:** reading Gmail through its API or IMAP with `mail.google.com` is a
   *restricted* scope. A public app needs Google's verification and an annual
   independent security assessment, which costs thousands of dollars a year.
   An unverified app is limited to 100 users and shows a warning.
   **Recommendation:** keep app passwords for Gmail (they work) and revisit
   only if Google retires them.
4. **Where the registrations live:** in the publisher's accounts, not in each
   installation, so setup stays one command.

## 6. Size and order

- **Phase 1, Microsoft sign-in on the current engine:** large. Roughly the
  subscription's size: the device-code flow on the page, token storage and
  refresh, XOAUTH2 in the engine, the Outlook profile, the fake Microsoft, the
  Dovecot XOAUTH2 tier.
- **Before starting:** the owner's registration (§5.1) and a test account.
- **Phase 2 (only if needed):** Microsoft Graph for tenants that turn off IMAP
  and SMTP.

## 7. Questions for the owner

1. Go ahead with Microsoft phase 1?
2. Personal users first (Outlook.com), or Microsoft 365 companies too?
3. Agree to keep app passwords for Gmail for now?
4. Can you get an Outlook.com account for testing, and create the Entra app
   registration? I'll write the exact clicks.


## 8. Decided and built (2.5.0)

The owner's answers (2026-10-06): **go ahead with phase 1**, **Outlook.com first**
(personal accounts; company accounts later), **Gmail keeps app passwords**, and
test with **the owner's own Outlook.com account**.

| Part | As built |
|---|---|
| **The app id** | A server setting, `MICROSOFT_CLIENT_ID`, not built into releases: once the owner registers, it's set on the server and no release is needed. Without it, the Outlook option isn't shown and a Microsoft account answers `MICROSOFT_NOT_SET_UP`. |
| **Authority** | `https://login.microsoftonline.com/consumers` (personal accounts), a setting (`MICROSOFT_AUTHORITY`) for tests. |
| **Sign-in on the page** | Add an Outlook.com account → the code and Microsoft's page shown → Finish (no script, no polling: the person presses it after approving). The device code stays in the server's memory for that page session. |
| **Tokens** | `src/microsoft.ts`: an access token kept until five minutes before it ends, one refresh at a time. Microsoft hands out a new refresh token with each refresh; it's used at once and **saved at most weekly** (a saved one stays good 90 days unused; saving each would write the secret hourly). Saving it doesn't rebuild the mail access. |
| **Mail** | IMAP and SMTP with XOAUTH2, the same engine; SMTP gets a fresh transport per send. |
| **Setup's check** | IMAP `AUTHENTICATE XOAUTH2` and SMTP `AUTH XOAUTH2`, a challenge answered as the protocol asks. Check and fix never asks for an app password for a Microsoft account. |
| **Testing** | Unit: a scripted Microsoft. Slow tier: Dovecot accepting only XOAUTH2 (its static password is the access token), an SMTP server accepting only the token, a stand-in token endpoint. The live run waits for the registration. |
| **Found while building** | Microsoft no longer lets a personal account register an app outside a directory: the owner needs an Entra directory first (MICROSOFT-SETUP.md). |
