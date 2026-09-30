# Architecture

A map of the code. The full reasoning (what was chosen, what was cut and why) is
in [DESIGN-V2.md](DESIGN-V2.md) §6; this page is where to find things.

## Shape

```text
 Claude / ChatGPT ──HTTPS──▶ Cloud Run: one container, one instance
                              │
                              ├─ /.well-known/…      OAuth metadata (public)
                              ├─ /authorize, /token  sign-in server: CIMD apps, PKCE,
                              │                      approval by fingerprint or emailed code
                              ├─ /{key}/             your Universal Mail page
                              ├─ /{key}/mcp          MCP (streamable HTTP) ─▶ 17 tools
                              └─ /{key}/check        setup's check (signed, minutes-long)
                                                             │
                                          per account, per app's grant (MailRouter)
                                                             │
                                             MailService ─▶ IMAP (one kept connection)
                                                         └▶ SMTP (per send)
```

Settings live in two Secret Manager secrets (`universal-mail-state`,
`universal-mail-credentials`), read at start and rewritten as whole new
versions when your page changes something. The server keeps no mail.

## Source

| Path | What |
|---|---|
| `src/index.ts`, `src/app.ts` | start-up: an installation (setup's saved settings), the built-in sign-in, or direct mode (one shared secret, for the test kit and local development only) |
| `src/tools.ts` | the 17 MCP tools: schemas, descriptions, answer shaping, the per-call log line, and the hook that records organize and send calls in the activity log |
| `src/timing.ts` | where a call's time goes (`phases`): per-call context, timed IMAP commands |
| `src/multiMail.ts` | the router: which accounts and permissions a caller has; read-only when a subscription lapses |
| `src/accounts.ts`, `src/accountsConfig.ts` | account names, resolving one, its configuration |
| `src/mail/mailService.ts` | the mail rules: search, threads, attachments, drafts, send (limits, first-time recipients) and Sent copies, moves, flags |
| `src/mail/imap.ts` | the IMAP engine: one kept connection per account, calls in turn, recovery, provider workarounds; whether this account has written to an address |
| `src/mail/mime.ts` | composing messages (Message-ID from the sender's domain, no References of its own) |
| `src/safeParse.ts`, `src/parseWorker.ts`, `src/parseCore.ts` | reading messages in a sandboxed worker with structure, time and memory limits |
| `src/attachmentCore.ts` | reading one attachment, inside that worker: text, HTML, PDF (unpdf), Word (mammoth), images |
| `src/cautions.ts` | scam warnings from a message's From and Reply-To: brand names, addresses in names, look-alike and disguised domains |
| `src/sendLimits.ts` | per-account send counts for the hour and the day, shared by every app |
| `src/activity.ts`, `src/page/activity.ts` | the activity log (what each app changed, never content) and undo on your page |
| `src/providers.ts` | provider profiles (servers, capabilities, where to make an app password) and detection |
| `src/signin/` | the authorization server: identity documents (CIMD) from trusted origins, grants, approval, passkeys, tokens |
| `src/page/` | your Universal Mail page: accounts, apps and permissions, health, sign-in, subscription |
| `src/check/` | the server's own checks, and the report |
| `src/installed.ts` | the installed settings, and saving changes to them |
| `src/subscription/`, `src/licenseService/` | the subscription: license state on the server; the separate license service (Paddle) |
| `src/setup/` | `node setup.js`: the Cloud Shell installer, its messages, log and report |
| `src/systemMail.ts` | the server's own emails (sign-in codes, notices), hidden from the AI |
| `src/toolCodes.ts`, `src/errors.ts` | every failure code, with its one-sentence remedy |

## Things that shape the code

- **One kept IMAP connection per account.** Calls take turns on it. It's
  checked with NOOP after two minutes idle, and dropped after any failure that
  isn't the mail's own refusal (design §12, ENG-18, ENG-26).
- **A folder opened for changes serves the reads that follow**; reads only ever
  peek, so nothing is marked read by reading (ENG-27).
- **Provider quirks are handled in the engine, measured live**: see the table
  in [OPERATIONS.md](OPERATIONS.md).
- **Apps sign in with their published identity document** (Claude's, ChatGPT's),
  never with a shared secret, and are approved by the owner. ChatGPT may prove
  itself with a signed assertion; that is verified against its own keys
  (SIG-83, SIG-84).
- **Nothing the AI does is taken on trust where a person can check it**: a
  send to someone new is held for the owner, sends are capped per account,
  every change is listed on the page with undo (design §1).
- **Every change is saved as a whole new secret version**, credentials before
  state, so the state never names an account without its password.
- **Releases are pinned by image digest and signed**, and installs trust only
  the one image repository named in `scripts/release-files.mjs`.
