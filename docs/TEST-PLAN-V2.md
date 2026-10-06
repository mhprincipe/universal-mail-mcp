# Universal Mail MCP — test plan

**Status:** proposed, 2026-09-24. Drives the build of [DESIGN-V2.md](DESIGN-V2.md).
**Method:** test-driven. Every behavior starts as a failing test.

---

## 1. How we work

### The loop

1. **Pick the next test** from §6, in order.
2. **Write it and run it. See it fail for the right reason.** The failure must
   be an assertion about behavior. "Module not found", a typo or a missing
   export doesn't count. If needed, add an empty stub first so the real failure
   shows.
3. **Write the least code that makes it pass.**
4. **Run the whole suite.** Everything green.
5. **Refactor** with the suite green.
6. **Record the cycle** in the TDD journal (§10): the test ID, the first line of
   the red failure, and the green result.

### Rules

- **One behavior per test.** Each test's name is a sentence describing that
  behavior.
- **No skipping to get green.** A test stays red until the code passes it, or
  it's deleted with a written reason.
- **Every bug becomes a red test before it's fixed**, whether it's found in CI,
  in a live check, or reported by a user.
- **Flaky tests are quarantined with a written reason**, never retried
  automatically until they pass.
- **Assert counts and states, not timings.** Timing is measured in the
  fresh-install tier and reported, not used as a gate.
- **The unit tier can't reach the network.** Sockets and `fetch` throw
  `EXTERNAL_IO_FORBIDDEN`, as in v1.
- **Secrets are tested with canaries.** Plant known strings, then scan logs,
  reports, HTML and disk for them.

---

## 2. Where the code lives

**v1 is in daily use, so v2 is built somewhere else.** v2 gets a new sibling
project, `universal-mail-mcp/`, started from a copy of v1's engine and its 155
tests. v1 is not modified.

**v1's tests are ported first, as the baseline.** They must all pass before the
first new red test is written. Their coverage sets the first coverage floor.

---

## 3. Layout and commands

```text
universal-mail-mcp/
  packages/core/test/unit          engine logic, mocks and fault injection
  packages/core/test/protocol      real IMAP per provider profile   (needs Docker)
  packages/server/test/unit
  packages/server/test/signin      sign-in server conformance and security
  packages/server/test/pages       your page and approval page      (Playwright)
  packages/setup/test/unit
  packages/setup/test/matrix       setup against fake gcloud
  packages/testkit/test            the harness tests itself
  e2e/fresh-install                real, empty Google Cloud project (nightly)
  e2e/live                         the same code as "Check and fix"
```

| Command | Runs | Needs |
|---|---|---|
| `npm test` | unit, sign-in, setup matrix | nothing |
| `npm run test:protocol` | real-IMAP profiles, invariants | Docker |
| `npm run test:pages` | page and approval flows, phone and desktop | Playwright browsers |
| `npm run verify` | everything above, plus build and the coverage floor | Docker, Playwright |
| `npm run test:fresh` | full install on real Google Cloud, then teardown | test billing account |

---

## 4. Tools

| Need | Tool |
|---|---|
| test runner | Vitest, as in v1 |
| coverage | V8 coverage through Vitest, with a floor per package |
| real IMAP | Dovecot in a container via Testcontainers, configured per profile |
| SMTP capture | a local server built on `smtp-server` |
| network faults | the testkit fault proxy, sitting between the server and Dovecot |
| Gmail extensions | a scripted IMAP fake, because Dovecot doesn't speak Gmail's extensions |
| DNS and autoconfig | a fake resolver and a fake HTTP server |
| Google Cloud | a fake `gcloud` on `PATH` that replays scripted responses and records every call |
| time | a fake clock, for expiries, lapses and rate limits |
| tokens | real ES256 keys generated per run with `jose` |
| fingerprints | a software WebAuthn authenticator in testkit |
| pages | Playwright, at phone and desktop sizes |
| hostile email | a corpus in `testkit/corpus` |
| secrets | canary strings plus a scanner |

---

## 5. Phase 0 — the test kit

The harness is code too. It gets its own small tests before anything relies on
it.

| ID | Behavior |
|---|---|
| TK-01 | the network guard throws `EXTERNAL_IO_FORBIDDEN` in the unit tier |
| TK-02 | a Dovecot container starts with a named profile and advertises exactly that profile's capabilities |
| TK-03 | the seeding helper creates folders and messages and returns their UIDs |
| TK-04 | the fault proxy passes traffic unchanged by default |
| TK-05 | the fault proxy drops the connection after a named command |
| TK-06 | the fault proxy blanks HEADER search results, reproducing the Yahoo quirk |
| TK-07 | the fault proxy delays a response by a set time |
| TK-08 | SMTP capture records exactly the messages delivered |
| TK-09 | the fake `gcloud` replays its script, records every call, and fails loudly on any unscripted call |
| TK-10 | the fake clock advances deterministically |
| TK-11 | the software authenticator registers a passkey and signs with it |
| TK-12 | the canary scanner finds a planted canary in logs, reports, HTML and files |
| TK-13 | the whole product runs over MCP against a real mail server and a capturing SMTP server *(added during build: the PRO tests need it; options for a fault proxy, a server that files Sent copies itself, and an SMTP drop after DATA)* |

---

## 6. The test list

Each table lists tests in the order they're written. Tier is **U** unit, **P**
protocol, **S** sign-in, **M** setup matrix, or **W** web pages.

### Phase 1 — Engine

**Baseline:** port v1's 155 tests; all pass; measure coverage and set the floor.

**Accounts**

| ID | Behavior | Tier |
|---|---|---|
| ENG-01 | accounts are looked up by name | U |
| ENG-02 | an unknown account name fails with `MAIL-ACCOUNT-UNKNOWN` and lists the valid names | U |
| ENG-03 | `account` can be omitted when the caller can reach exactly one account | U |
| ENG-04 | `account` is required when the caller can reach more than one, and the error lists them | U |
| ENG-05 | a search with no account covers every reachable account and tags each result with its account | U |
| ENG-06 | search-all merges results newest first across accounts | U |
| ENG-07 | one account failing during search-all returns the others plus a warning | U |
| ENG-08 | each account has its own folder cache | U |
| ENG-09 | a move between accounts is refused and changes nothing | U |
| ENG-10 | search-all over five accounts opens exactly one connection per account | U |
| ENG-11 | a named account the caller can reach is used *(added during build: path found untested by coverage)* | U |
| ENG-12 | naming an account the caller can't reach is refused without revealing the others *(added during build: exposed a permission bypass)* | U |
| ENG-13 | a move within one account goes to that account and no other *(added during build: path found untested by coverage)* | U |
| ENG-18 | one kept connection per account: many calls log in once; calls take turns; checked after a pause (a dead or silent one replaced); never reused after a failure, kept after a mail-level refusal; a failed login not kept; an account change logs the old ones out; on Dovecot, fifteen tools log in once and mark nothing read, and a cut connection is replaced *(added: the live baseline showed ~3.3 s of login per call)* | U+P |
| ENG-19 | sent and saved mail names no one but its sender: the Message-ID uses the sender's domain; the operation header names Universal Mail *(added: found live)* | U |
| ENG-20 | a batch move reports each message's own new UID: sent sorted, every pair checked by Message-ID in the destination; copies paired in order; one it can't confirm left unmapped, never guessed *(added: found live, Yahoo mispaired an unsorted batch)* | U+P |
| ENG-21 | re-finding by Message-ID works where the provider's header search misses (Yahoo): the folder's newest 200 messages are checked directly; a reliable provider isn't second-guessed *(added: found live)* | U+P |
| ENG-22 | `get_thread` and the Message-ID check read a folder's newest 200 messages by position, never asking for every UID the folder holds; an empty folder is skipped; paging is kept *(added: tuning, get_thread ~8 s live)* | U+P |
| ENG-23 | `create_folder` on a folder that already exists answers `created: false` from a fresh listing, asking nothing to be created and keeping the connection; one created elsewhere in between is still success *(added: tuning, 4.5 s live)* | U+P |
| ENG-24 | where the provider files its own Sent copy, a send doesn't look for it (it appears a minute later) and says so; a reply reads only the original's envelope and References, and threads exactly as before *(added: tuning, send ~4 s, reply ~5 s live)* | U+P |
| ENG-25 | a message that arrives while its folder is open on the kept connection can be read and replied to at once: not found → NOOP → asked once more *(added: found while tuning)* | U+P |
| ENG-26 | a pause of up to two minutes costs no check of the kept connection (the check took Yahoo about a second); longer, it's checked as before *(added: measured live, DIA-13)* | U |
| ENG-27 | a folder already open for changes serves the reads that follow without opening it again (reads only peek, and nothing is marked read); another folder, or one open read-only, is read read-only *(added: measured live, DIA-13: 0.4-1 s per reopen)* | U+P |
| ENG-28 | no provider's name in the engine: it lives in `src/mail/`; the settings are `MAIL_ADDRESS` and `MAIL_APP_PASSWORD`, the old `YAHOO_` names still work and the new ones win *(added: 2.4)* | U |
| ENG-29 | accounts are described with their provider (by mail server, else address domain) in the tools and the refusals; the names to pass stay plain *(added: 2.4.3, found live)* | U |
| ENG-30 | a search of every account says which accounts it searched *(added: 2.4.4, found live)* | U |
| ENG-14 | an unencrypted mail connection is allowed only to this machine; each transport setting maps to the right connection options *(added during build: the protocol tier's local test server is unencrypted, and the product must never allow that anywhere else)* | U |
| ENG-15 | sending always requires encryption, on any port; a server that won't encrypt gets nothing, with a plain answer *(added during build: v1 only required it on port 587, so a custom port would have sent in whatever mode the server chose)* | U |
| ENG-16 | several accounts load from the stored account list and a separate password list; v1's single-account settings become one account called `main`; a bad account is named in the error and its password never appears *(added during build: the accounts had no way in)* | U |
| ENG-17 | with several accounts, every tool takes `account`; one is required and listed when there is more than one; search without one covers them all *(added during build: the tools served one account)* | U |

**Providers**

| ID | Behavior | Tier |
|---|---|---|
| PRV-01 | a known domain selects its profile | U |
| PRV-02 | an MX lookup maps a custom domain to its hosting provider's profile | U |
| PRV-03 | autoconfig is consulted when the domain and MX are unknown | U |
| PRV-04 | SRV records are consulted after autoconfig | U |
| PRV-05 | when nothing is found, the result is "needs input", never a guess | U |
| PRV-06 | live capabilities override the profile, and the mismatch is recorded | U |
| PRV-07 | every launch profile has app-password guidance: page, button and prerequisites | U |
| PRV-08 | an account with neither MOVE nor UIDPLUS is marked unsafe for moves at detection | U |
| PRV-09 | every launch profile names encrypted IMAP and SMTP servers *(added during build: a profile without servers can't be used, and nothing checked they were encrypted)* | U |

**Safe parsing**

| ID | Behavior | Tier |
|---|---|---|
| PAR-01 | an ordinary message parses in the worker and matches v1's output | U |
| PAR-02 | every message in the hostile corpus returns `MAIL-PARSE-UNSAFE` within the time limit | U |
| PAR-03 | killing a worker doesn't stop the server, and the next request succeeds | U |
| PAR-04 | a message that failed to parse isn't parsed again: remembered by a fingerprint of its bytes *(changed during build: the plan said "same Message-ID", but any sender can copy a Message-ID, so a hostile email could block a genuine one)* | U |
| PAR-05 | the limits on MIME depth, part count and header size each trigger on their own | U |
| PAR-06 | an ordinary email caught behind a stuck or crashing one still opens *(added during build: killing a worker also failed the innocent emails queued on it, and PAR-04 would then have remembered them as unsafe)* | U |
| PAR-07 | a slow-starting worker doesn't count against an email's time limit, and a worker that never starts is reported as unavailable, not blamed on the email *(added during build: under load, a fresh worker's start-up ran out an ordinary email's time limit)* | U |
| PAR-08 | an HTML-only email has readable text made from its HTML (words, no tags, no styles); an email with its own text part keeps it *(added: found live)* | U |
| PAR-09 | past 20 waiting, an email is turned away at once ("busy, try again"), not remembered as unsafe; those waiting still open *(added: 2.4.2, security review)* | U |

**Thread strategies**

| ID | Behavior | Tier |
|---|---|---|
| THR-01 | Gmail-like: a thread is found with a single thread-ID search | U (scripted fake) |
| THR-02 | when the provider's header search is reliable, it alone finds the thread: no scan of recent messages *(replaced during build: the plan said "`THREAD=REFERENCES` is used when offered". ImapFlow has no THREAD support, and THREAD works one folder at a time while a conversation spans folders, so it would save nothing over the header search those servers already do reliably. This test keeps the aim, fewer round trips, with less code.)* | P |
| THR-03 | the Yahoo-like fallback scans only Inbox, Sent, Archive and the seed message's folder | P |
| THR-04 | `allFolders: true` scans every selectable folder | P |
| THR-05 | Gmail-like: a full scan skips All Mail, and a message under several labels appears once | U (scripted fake) |
| THR-06 | the fallback still finds a reply when HEADER search returns nothing | P (fault proxy) |
| THR-07 | on Gmail, a conversation's answer says its messages come from All Mail, and that those places work for every tool *(added: 2.4.4, found live)* | U |

**Protocol tier: real IMAP per profile**

| ID | Behavior | Tier |
|---|---|---|
| PRO-01 | the whole-tool workflow (17 tools since 2.4) passes on `yahoo-like` | P |
| PRO-02 | the whole-tool workflow passes on `gmail-like` | P |
| PRO-03 | the whole-tool workflow passes on `minimal` (the UIDPLUS move path) | P |
| PRO-04 | `hostile`: every move refuses with `SAFE_MOVE_UNAVAILABLE`, and the mailbox is unchanged | P |
| PRO-05 | `server-sent`: the server saves exactly one Sent copy | P |
| PRO-06 | five accounts across profiles: accounts stay isolated, and one broken account doesn't affect the others | P |
| PRO-07 | a disconnect after DATA returns `SEND_STATUS_UNKNOWN`, with exactly one delivery | P (fault proxy) |
| PRO-08 | an interrupted move is verified by Message-ID before any retry | P (fault proxy) |
| PRO-09 | a batch move of 100 messages is one MOVE command and maps every UID | P |

**Safety invariants, run on every profile**

| ID | Behavior | Tier |
|---|---|---|
| INV-01 | no tool marks a message read | P |
| INV-02 | no tool moves mail to a folder that doesn't exist under that exact name | P |
| INV-03 | no change is retried without proof that the first attempt didn't happen | P |
| INV-04 | an ambiguous send is never retried | P |
| INV-05 | a replacement draft is saved before the original is deleted | P |
| INV-06 | no tool can permanently delete | P |
| INV-07 | every message carries `untrustedContent: true` | P |

**Exit:** PRO-01 to PRO-09 and every invariant green, including five accounts at once.

### Phase 2 — Sign-in

**Discovery and address**

| ID | Behavior | Tier |
|---|---|---|
| SIG-01 | resource metadata names the resource and the issuer | S |
| SIG-02 | server metadata advertises CIMD, S256 only, and issuer identification | S |
| SIG-03 | a request without the `{key}` gets a 404 and reveals nothing | S |
| SIG-04 | the `{key}` never appears in the request log | S |

**App identity documents**

| ID | Behavior | Tier |
|---|---|---|
| SIG-10 | an identity document on a trusted origin is accepted | S |
| SIG-11 | an untrusted origin is refused before any network activity | S |
| SIG-12 | private, loopback, link-local and metadata addresses are refused | S |
| SIG-13 | a hostname that resolves to a private address is refused (DNS rebinding) | S |
| SIG-14 | redirects are not followed | S |
| SIG-15 | documents over 64 KB, or slower than 5 seconds, are refused | S |
| SIG-16 | redirect addresses must match the document exactly | S |

**Authorization and tokens**

| ID | Behavior | Tier |
|---|---|---|
| SIG-20 | PKCE is required, and `plain` is refused | S |
| SIG-21 | a code expires after 60 seconds | S (fake clock) |
| SIG-22 | a code is bound to its app and redirect address; swapping either fails | S |
| SIG-23 | the authorization response includes the issuer (RFC 9207) | S |
| SIG-24 | access tokens are ES256, last 15 minutes, and carry the app ID and grant version | S |
| SIG-25 | refresh works and issues a new refresh token each time | S |
| SIG-26 | access lapses after 30 days unused; any use within 30 days extends it | S (fake clock) |
| SIG-27 | a code works once *(added during build: an OAuth requirement the plan had no test for; stateless codes could be replayed within 60 seconds)* | S |
| SIG-28 | the keys load from the credentials secret; bad keys fail plainly, without echoing them *(added during build: the production key path had never run)* | S |
| SIG-29 | `/jwks` publishes the public key only, and it verifies our tokens; `/revoke` answers 200 *(added during build)* | S |

**Grants**

| ID | Behavior | Tier |
|---|---|---|
| SIG-30 | a request is allowed only for accounts and actions in the app's current grant | S |
| SIG-31 | changing a grant takes effect on the next request, without reconnecting | S |
| SIG-32 | disconnecting takes effect on the next request | S |
| SIG-33 | one app's token can't use another app's grant | S |
| SIG-34 | the tool list names only the accounts the app was granted | S |
| SIG-35 | an account added to a grant appears without a new token | S |

**Sign-in codes**

| ID | Behavior | Tier |
|---|---|---|
| SIG-40 | codes are 8 characters from the unambiguous alphabet | U |
| SIG-41 | a code works once | S |
| SIG-42 | a code expires after 10 minutes | S (fake clock) |
| SIG-43 | five wrong attempts end a code | S |
| SIG-44 | each account gets at most 5 codes an hour | S (fake clock) |
| SIG-45 | a per-requester limit applies across accounts | S |
| SIG-46 | codes go only to the sign-in address | S |
| SIG-47 | if the sign-in account can't send, the code goes out through another working account | S |
| SIG-48 | codes are compared with the constant-time function | U |

**System emails are invisible to the AI**

| ID | Behavior | Tier |
|---|---|---|
| SIG-50 | system emails never appear in a search, in any folder, including Sent and Trash | P |
| SIG-51 | `get_email` and `get_thread` treat a system email's UID as not found | P |
| SIG-52 | move, flag and trash can't target a system email | P |
| SIG-53 | a used code email is moved to Trash | P |
| SIG-54 | a system email carries the system marker and Message-ID, and no Sent copy is kept *(added during build: the sender codes need)* | U |

**Fingerprints**

| ID | Behavior | Tier |
|---|---|---|
| SIG-60 | a fingerprint can be registered only in a session already approved by a code | S |
| SIG-61 | granting Send requires a fingerprint | S |
| SIG-62 | adding a second fingerprint requires the first | S |
| SIG-63 | with no fingerprint saved, Read and Organize can be granted but Send can't | S |
| SIG-64 | a passkey response for another site, or a replayed challenge, is refused *(added during build)* | S |
| SIG-65 | a fingerprint on the approval page unlocks Send without an emailed code; with none saved nothing is offered; a forged one is refused and logged *(added during build: without it, Send could never be granted from the page)* | S |

**Approval page**

| ID | Behavior | Tier |
|---|---|---|
| SIG-70 | the page refuses to be framed by another site | S |
| SIG-71 | a missing or wrong CSRF token is refused | S |
| SIG-72 | responses aren't cached | S |
| SIG-73 | nothing the app supplies is shown except its escaped name and verified origin | S |
| SIG-74 | Send is unticked by default | W |
| SIG-75 | addresses are masked before sign-in | W |
| SIG-76 | approving sends a "connected" email; disconnecting sends a "disconnected" email | S |
| SIG-77 | every approval dead end has a plain answer and approves nothing: wrong code, don't connect, nothing chosen, Send forced without a fingerprint, expired page, too many codes, a code that can't be emailed *(added during build: coverage showed none of them had run)* | S |

**Refusals**

| ID | Behavior | Tier |
|---|---|---|
| SIG-80 | every refusal logs a reason code, and never a token or claim value | S |
| SIG-81 | refusals are counted per app | S |
| SIG-82 | hidden system emails don't use up a search page: the limit counts only what the AI sees; older messages fill in; paging covers every visible message once *(added: found live, "asked for 5, got 3")* | U+P |
| SIG-83 | ChatGPT signs in with its real published document (extra fields, `private_key_jwt`, `jwks_uri`): as a public client like Claude, or with a signed assertion, with or without `client_id`, for the code and for refresh *(added: connecting ChatGPT)* | U |
| SIG-84 | an assertion that doesn't prove the app is `invalid_client` (401), never ignored: another key, issuer, subject or audience; expired or hours-long; no or reused one-time id; unknown type; a different `client_id`; keys named off the app's own origin (another trusted app's included) or unreachable *(added: connecting ChatGPT)* | U |
| SIG-85 | v1's retired Auth0 sign-in modes are refused at start, never quietly replaced by another way in *(added: the clean-up, 2.3.1)* | U |
| SIG-86 | a server whose sign-in mode wasn't chosen refuses to start: the shared-secret test mode is never a default *(added: 2.4)* | U |
| SIG-87 | an app's identity document and keys are fetched at most once per five minutes, not once per token request (the token step is public) *(added: security review, 2.4)* | U |

**Exit:** a scripted Claude-like client connects to two accounts with Auth0 absent, and the whole Phase 2 suite is green.

### Phase 3 — Setup

**Messages**

| ID | Behavior | Tier |
|---|---|---|
| SET-01 | every message a person sees comes from the registry | U |
| SET-02 | every registry entry has what happened, the fix, where they stand, and a code | U |
| SET-03 | no user-facing text contains jargon: IMAP, SMTP, OAuth, token, deploy, environment and the rest of the banned list | U |
| SET-04 | every message fits within 80 columns | U |

**Flow, against fake `gcloud` and fake mail servers**

| ID | Behavior | Tier |
|---|---|---|
| SET-10 | nothing changes in Google Cloud before step 3 (from the recorded calls) | M |
| SET-11 | email passwords are checked before the project is created | M |
| SET-12 | every step checks whether it's already done; a complete install run twice changes nothing | M |
| SET-13 | interrupted after step N, a rerun resumes at step N with no duplicate creates — for every N | M |
| SET-14 | slow service enablement shows the waiting message, then succeeds | M (fake clock) |
| SET-15 | enablement that never becomes ready gives `GOOGLE-SERVICE-NOT-READY` and "progress saved" | M |
| SET-16 | slowly spreading permissions are waited for, then succeed | M |
| SET-17 | "All done" appears only after the self-test passes | M |
| SET-18 | a failed self-test names the failing check and never shows "All done" | M |
| SET-19 | the $1 budget is created | M |
| SET-20 | an unsigned or mismatched image is refused before it's started | M |
| SET-21 | passwords never reach disk (canary scan of the Cloud Shell home folder) | M |
| SET-22 | password prompts don't echo, and say so; each question's last line survives readline's redraw; Ctrl+C or the input ending at a question stops setup plainly (SETUP-INTERRUPTED) *(3 added: found live)* | U |
| SET-23 | pressing Enter at every prompt produces a correct install | M |
| SET-24 | an account can be skipped with `s`, and the rest complete | M |
| SET-25 | the built `setup.js` needs nothing beyond Node's built-in modules | U |
| SET-60 | every run is logged: steps, every Google call with its outcome, time and Google's own words, every password check's outcome, and anything unexpected with its full trace *(added during build: the live install must leave enough to diagnose it)* | M |
| SET-61 | no password or key ever reaches the log, even inside Google's error text *(added)* | M |
| SET-62 | `node setup.js report` gives one block that is safe to paste, repeats collapsed, without the address key *(added)* | M |
| SET-63 | the `gcloud` adapter runs exactly the planned commands and reads their answers; a secret travels only on standard input *(added: the commands, written down for the live install to confirm)* | M |
| SET-64 | Google's known refusals become the plain problems; anything else carries the command and Google's words *(added)* | M |
| SET-65 | every command is logged with arguments, exit status, time and Google's words, never its input or output *(added)* | M |
| SET-66 | a rerun recognises everything that already exists, from Google's own answers *(added: found by coverage)* | M |
| SET-67 | no `gcloud`, signed out, no billing, closed billing and company policies are read correctly *(added: found by coverage)* | M |
| SET-68 | the password check (built-ins only) signs in to read and to send, counts folders, sees safe moves; a wrong password, a silent server, a closed port and an unencrypted remote server each give the right answer in time; STARTTLS on both, against servers that refuse sign-in before encryption; an untrusted certificate is "insecure" *(added)* | U |
| SET-69 | the same check against a real IMAP server *(added)* | P |
| SET-71 | an unreachable or insecure mail server is never blamed on the password: its own message, the same password tried again on Enter, the true reason in the log *(added: found reading the flow)* | M |
| SET-72 | the real mail check: a known domain needs no lookups; custom domains found by mail records or autoconfig (the domain's own, then Thunderbird's; https only, no redirects, size and time limits, plain host names only); what was found is logged *(added)* | U |
| SET-73 | the sending test: one system-marked email to the account itself, then Sent (by its flag, else its usual name) opened read-only and its newest messages counted by Message-ID; 0, 1 or 2 copies; a refusal stops before counting; each stage logged; against a tiny server and Dovecot (Yahoo and Gmail layouts) *(added)* | U+P |
| SET-74 | the server is started again after step 7 saves the Sent modes, so step 8 checks what was saved *(added: found wiring step 8)* | M |
| SET-75 | step 8's client: signs a check token with the saved key, asks the server, logs the report whole; version mismatch, mismatched keys, no check at the address, no answer (three tries), a lost answer (a fresh token), and missing keys each give their own words *(added)* | M |
| SET-76 | each save keeps only the newest two secret versions; the server's role is version manager *(added: cost)* | M |
| SET-77 | `node setup.js`: a whole install through the real gcloud adapter, prompt, screen, progress and log; `report`; outside Cloud Shell; unknown arguments *(added)* | M |
| SET-78 | the launcher, built and run as its own process: `report`, outside Cloud Shell, the release's pinned image *(added)* | K (package) |
| SET-79 | the menu's gcloud commands: the running image, removing our $1 alarm only, deleting the project *(added)* | M |
| SET-80 | every stop ends with how to get help, unless its own steps already say it *(added: found by DIA-04)* | M |
| SET-81 | Check and fix checks Google's side first: billing unlinked, services off and a missing $1 alarm are put back; closed billing is reported and nothing else is touched *(added)* | M |
| SET-82 | the built launcher in a real terminal (Linux, Node 24, a stand-in gcloud): every question's last line stays on screen; Ctrl+C gives a plain, logged stop, never "unsettled top-level await" *(added: found live)* | K (package) |
| SET-83 | rerunning an unfinished install with a newer release starts the newer server before the check; the same release leaves it alone *(added: found live)* | M |
| SET-84 | an app password typed with the spaces its provider shows (Gmail) works as it is *(added: adding Gmail live)* | U |

### Release *(added during build)*

| ID | Behavior | Tier |
|---|---|---|
| REL-01 | release.json names the official image by its sha256 digest, exactly as setup's image check requires; tags and malformed digests are refused | U |
| REL-02 | the update feed says the version and whether it is a security release, as the server reads it | U |
| REL-03 | the server image, built from the Dockerfile and started as Cloud Run starts it: waiting before its address, serving as itself after, unhealthy with a named setting when damaged, not running as root | K (package) |
| REL-04 | the published release branch runs on its own: `node setup.js report` with no node_modules, the pinned image, the feed, a package.json saying ES modules *(added: found release.yml omitted it)* | K (package) |
| REL-05 | `scripts/release-setup.sh` creates the release project, public image store and keyless publishing for this repository only; safe to rerun; stops plainly without billing; waits and retries while a just-enabled service still refuses *(added; retry found live)* | K (package) |
| REL-06 | one image store, named once: the setup script, the workflow and setup's trusted image agree; the workflow publishes through `publish-setup.mjs` *(added)* | U |
| REL-07 | each release is one commit on top of the last on the release branch, so a clone takes it with a plain `git pull`; the workflow never force-pushes *(added: found live)* | K (package) |
| REL-08 | every change, and so every release, stops on a known high-severity problem in a production dependency, before any test runs *(added: 2.4)* | U |
| REL-09 | whether a release is a security release comes from the tag's own first line, never the commit's; a tag that is only a pointer to the commit stops the release; the workflow fetches the real tag first *(added: found releasing 2.4.0)* | U |

**Failure matrix.** Each test asserts the exact message, the code, and that
what it says about the person's position is true.

| ID | Scenario | Tier |
|---|---|---|
| SET-30 | billing missing | M |
| SET-31 | billing suspended | M |
| SET-32 | free-trial account: upgrade prompt; skipping records the reminder | M |
| SET-33 | company policy blocks public services | M |
| SET-34 | project quota used up | M |
| SET-35 | wrong app password: try again in place | M |
| SET-36 | normal password pasted instead of an app password | M |
| SET-37 | unknown provider | M |
| SET-38 | provider without a safe move | M |
| SET-39 | duplicate Sent copy detected | M |
| SET-40 | not running in Cloud Shell | M |

**Menu**

| ID | Behavior | Tier |
|---|---|---|
| SET-50 | an existing install shows the four-item menu | M |
| SET-51 | Check and fix repairs a revoked password | M |
| SET-52 | Update installs, checks, and rolls back when the check fails | M |
| SET-53 | Show my address prints both addresses | M |
| SET-54 | Remove requires typing a confirmation word, then deletes the project | M |
| SET-55 | Update from version 1 converts a v1 deployment, using a fixture of v1's settings | M |

**Exit:** the automated suite green, plus the novice test in §8.

### Phase 4 — Your page and emails

| ID | Behavior | Tier |
|---|---|---|
| PG-01 | sign in with a code; sign in with a fingerprint | W |
| PG-02 | a session ends after 15 minutes idle | W (fake clock) |
| PG-03 | adding an account runs the same checks as setup; a wrong password shows the same message | W |
| PG-04 | Fix it changes a password, and the account turns green | W |
| PG-05 | removing an account stops access immediately and deletes its password | W |
| PG-06 | permissions change per app and per account | W |
| PG-07 | an app can be disconnected | W |
| PG-08 | sending can be turned on and off per account | W |
| PG-09 | Check runs the stages; Copy report produces a redacted report | W |
| PG-10 | no page ever contains a password, token or email content (canary scan of every rendered page) | W |
| PG-11 | every change sends a "something changed" email | S |
| PG-12 | repeated sign-in failures on an account send **one** "something broke" email with Fix it, not one per failure | S |
| PG-13 | when the sign-in account is broken, alerts go out through another account | S |
| PG-14 | the free-trial reminder is sent before day 80 when the account wasn't upgraded | S (fake clock) |
| PG-15 | update-available emails mark security releases | S |
| PG-16 | every page works at phone width without sideways scrolling | W |
| PG-17 | "last used" per app comes from the request log | S |
| PG-18 | your page says how to connect ChatGPT as it is today: Plus or higher, Developer mode, a new app, the address, OAuth *(added: connecting ChatGPT)* | U |
| PG-19 | an account can be renamed on your page: its password, settings and every app's permissions carry over; apps use the new name at once, on the same connection (no new sign-in); a taken or malformed name is refused; you're emailed *(added: the owner, after Gmail was named for its address)* | U |
| NTC-01 | a version with new tools, apps connected: one email naming them and how to refresh each app; told once, even across a restart *(added: 2.4.3, found live)* | U |
| NTC-02 | a new installation or the same tools: nothing; a server updated from before 2.4.3 with apps connected: told once *(added: 2.4.3)* | U |

**Exit:** adding an account, fixing a revoked password and disconnecting an app all work at phone size.

### Phase 5 — Everyday polish

| ID | Behavior | Tier |
|---|---|---|
| POL-01 | `format` defaults to `text`, and html is absent | U |
| POL-02 | `format: full` includes the html | U |
| POL-03 | a body over 100,000 characters is clipped and marked | U |
| POL-04 | a response over 200,000 characters is cut, with "N more" markers | U |
| POL-05 | `mark_read`, `mark_unread` and `flag_email` accept `uids` and send one command | P |
| POL-06 | the search cursor pages through more than 100 results with no gaps or repeats | P |
| POL-07 | every tool error code has a remedy | U |
| POL-08 | tool descriptions carry the steering text (snapshot) | U |
| POL-09 | a slow full-text search ends with the "narrow your search" remedy | P (fault proxy) |
| POL-10 | `get_thread`'s full-folder scan happens only when asked for | P |
| POL-11 | sorting 100 messages across several folders takes 10 or fewer tool calls (counted) | P |
| POL-12 | `since` and `before` honour the time of day: the server is asked a day either side (IMAP compares whole days) and the exact times are applied; the limit counts only what's shown *(added: found live)* | U |
| POL-13 | a subject search returns only messages whose subject really contains what was asked (case and spacing aside): Yahoo's "Re: X" also finds "X" *(added: found live)* | U |
| POL-14 | a send's answer says when the provider accepted it (`sentAt`, the server's clock), so an AI needn't guess the time *(added: asked for in the live runs)* | U |
| POL-15 | a display "name" that is only the address again (as Yahoo lists it) is left out, so search and get_email agree; a real name is kept *(added: found live)* | U |

**Exit:** POL-11 green. That's v1's 90-call cleanup done in 10 or fewer.

### The installed server *(added during build: found wiring step 8)*

| ID | Behavior | Tier |
|---|---|---|
| INS-01 | the two saved records (state, credentials) become the server's settings; it answers at its public address and lets its own host name through, no other | U |
| INS-02 | the first start, before Google gives it an address: healthy, "starting", nothing else served | U |
| INS-03 | damaged or missing records (even on the first start): logged by setting and problem in fixed words, never a value; unhealthy, nothing served | U |
| INS-04 | a connected app, a disconnect and a fingerprint all survive a restart; reconnection numbers never repeat | U |
| INS-05 | saved state never holds a password or key; changes are saved one at a time, in order; a failed save is logged by status and retried with the next change | U |
| INS-06 | saves go through Secret Manager as the server's own identity; only the newest two versions are kept (free tier); refusals carry status only; time limits | U |

### Phase 6 — Subscription *(added 2026-09-28: design §13)*

| ID | Behavior | Tier |
|---|---|---|
| SUB-01 | the state from the install date, the license and the clock: trial with days left; grace 14 days after day 30; read-only after; with a license: active until paid-through, grace, read-only; a license for another install or an expired-by-years one counts as none | U |
| SUB-02 | a license is the service's signed token, verified with the key kept in state: tampered, another key, another audience: ignored, and the reason logged without the token | U |
| SUB-03 | read-only in the mail router: read passes; organize and send throw `SUBSCRIPTION-READ-ONLY` with the sentence and the page link; trial, active and grace change nothing | U |
| SUB-04 | the page's Subscription section: the state in one line; a code form; the buy/manage link; activation sends the code and the install id (never the key), saves the token and keys, and says "Paid through …" | U |
| SUB-05 | a wrong code: "That code wasn't recognised", nothing saved; the service unreachable or slow: "Couldn't reach…", nothing saved | U |
| SUB-06 | renewal daily with the update check: a fresh token moves paid-through; a refusal is noted once; an outage leaves the license as it is | U |
| SUB-07 | the emails: trial ends in 7 days; trial ended; now read-only; couldn't be renewed: each once, surviving a restart; none with an active license | U |
| SUB-08 | the report's facts carry the subscription state and days left | U |
| SUB-09 | setup's All done says the trial started; with no service address the server is a permanent trial and nothing is ever refused | M |
| SUB-10 | the license service: `/jwks`; activate binds the install and returns a token; a 4th install refused; renew returns a fresh token while paid and refuses when cancelled or past due; a wrong code 404 with the sentence; activation limited per address | U |
| SUB-11 | the Paddle webhook: a bad signature refused and nothing changed; activated, updated, cancelled and past-due events update the record; the first activation mints the code and it appears in the receipt's custom data | U |
| SUB-12 | the Firestore REST store: get and put as the service's identity, tested against a fake HTTP server; refusals carry status only | U |
| SUB-13 | the service image and `scripts/license-setup.sh` (the key, the secret, the deploy), against the scripted gcloud | K |
| SUB-14 | the whole loop: webhook → code → activate on the page → active → renew → cancel → grace → read-only → renew again → active | U |

### Phase 7 — Serving people *(added 2026-09-30: 2.4, design §1)*

**Attachments**

| ID | Behavior | Tier |
|---|---|---|
| ATT-01 | text, CSV, HTML, PDF and Word attachments come back as text, marked untrusted, and the email stays unread; one sent as `application/octet-stream` is read by its file name | U |
| ATT-02 | an image comes back as a picture the AI can look at, and the answer's JSON stays small; one over 3 MB is described instead | U |
| ATT-03 | other kinds are described, not read; a position that doesn't exist is `ATTACHMENT_NOT_FOUND`; a long text is clipped and says so | U |
| ATT-04 | a damaged PDF or Word file says it couldn't be read, and the email still opens | U |
| ATT-05 | `get_attachment` is a read: marked read-only for the apps, described as untrusted | U |
| ATT-06 | a PDF's text and an image come back from the message a real server holds, and the email stays unread | P |
| ATT-07 | an attachment that never finishes is stopped at the time limit and remembered; the email itself still opens | U |
| ATT-08 | an attachment that takes too much memory outside the heap (a PDF bomb) is stopped, and the email still opens *(added: security review)* | U |
| ATT-09 | reading an attachment applies the same structure limits as opening the email (depth, parts, header size) *(added: security review)* | U |
| ATT-10 | in the built image, the sandbox reads a PDF attachment: the reader and its libraries ship with it | K (package) |
| ATT-11 | each kind, read as the worker reads it: text with its charset, HTML, PDF, Word, an image, a large image, another kind, damaged files, a missing position *(added: coverage: the worker's code wasn't counted)* | U |
| ATT-12 | memory the rest of the server takes during a read doesn't count against it *(added: 2.4.2)* | U |

**Send limits**

| ID | Behavior | Tier |
|---|---|---|
| LIM-01 | 30 an hour and 200 a day by default; at a cap the send is refused before anything leaves (`MAIL-SEND-LIMIT`), allowed again once the hour or day has passed; a reply counts; a send the provider refused doesn't | U |
| LIM-02 | each account shows its limits on the page and they can be changed; nonsense is refused; the owner is emailed | U |
| LIM-03 | an account's saved limits reach its mail service; accounts saved before limits existed get the defaults | U |
| LIM-04 | sends fired together can't get past the limit: each takes its place before it goes, and gives it back only if the provider refused it *(added: security review)* | U |

**Scam warnings**

| ID | Behavior | Tier |
|---|---|---|
| SCM-01 | a name that claims a well-known company from an address that isn't theirs; a name that shows one email address while the mail comes from another | U |
| SCM-02 | look-alike domains: one character off a well-known one, or disguised letters (punycode) | U |
| SCM-03 | replies that would go somewhere other than the sender's own domain | U |
| SCM-04 | no false alarm on ordinary mail: the real companies, their mail services' subdomains, friends, newsletters replying on their own domain | U |
| SCM-05 | search results and an opened email carry the cautions, and the tools say to pass them on | U |
| SCM-06 | a hostile sender name (thousands of @s, or a long run with no spaces) is checked in a moment, not seconds: it runs on the main thread *(added: security review)* | U |
| SCM-07 | insurers, banks, lenders, credit bureaus, phone companies, shops and government services, named whole or with generic words, from someone else's address; quiet from their own, and on names that only share a word *(added: 2.4.2, found live)* | U |
| SCM-08 | mail sent through a mailing service with replies to the business's own domain is quiet; replies to a personal mailbox and a company's name are still said *(added: 2.4.3, found live; since 2.4.5 every business-to-business reply is quiet, SCM-10)* | U |
| SCM-09 | sales words don't hide a company's name: "Amazon Deals" from another domain is a claim to be Amazon *(added: 2.4.4, found live)* | U |
| SCM-10 | replies to another business's domain are quiet; replies to a personal mailbox, a look-alike or a disguised domain are said; MSN is Microsoft's *(added: 2.4.5, found live; the owner's decision)* | U |

**First-time recipients**

| ID | Behavior | Tier |
|---|---|---|
| RCP-01 | a send to someone never written to is held, nothing sent, naming them (`MAIL-NEW-RECIPIENT`); confirmed, it goes; people already written to, and the account itself, go straight through (bcc checked too) | U |
| RCP-02 | a reply to a sender never written to is held too (a scam's first reply) | U |
| RCP-03 | when the check can't be made (no Sent folder, a failed search), it asks rather than guessing | U |
| RCP-04 | on a real server: someone in Sent (To or Cc) is known; a stranger is held until confirmed | P |
| RCP-05 | only this account's own sent mail counts (a message planted in Sent doesn't), and only an exact address *(added: security review)* | U |

**Activity and undo**

| ID | Behavior | Tier |
|---|---|---|
| ACT-01 | what each organize or send tool did, in plain words, with what undo needs; reads, no-ops and failures leave nothing; newest first, at most 100, nothing older than 30 days, saved in one go | U |
| ACT-02 | what an app did shows on the page (app, action, account, count, folders; never content), and a move can be put back | U |
| ACT-03 | a message that has moved since can't be put back: the page says so and marks nothing undone | U |
| ACT-04 | sends are listed, not undoable | U |
| ACT-05 | the log is saved with the settings, so it outlasts a restart | U |
| ACT-06 | asked to stop (SIGTERM, as Cloud Run does), the server saves what is waiting and exits cleanly at once | K (package) |
| ACT-07 | what it keeps stays under 16 KB, oldest dropped first (the settings record has a 64 KB limit) *(added: security review)* | U |
| ACT-08 | undo finds the account by its address: after a rename it still works; if that address is gone, it refuses *(added: security review)* | U |
| ACT-09 | forwards, unsubscribes and junk are listed (junk with undo); attachments on sends and drafts are counted, never named; the page's words for each *(added: 2.4.1)* | U |
| ACT-10 | a mark or flag is logged, and undone, only for the messages it really changed (read in the same step that checks them); none changed: nothing logged; not known: all *(added: 2.4.2, security review)* | U |
| ACT-11 | on a real server, a mark says which it changed *(added: 2.4.2)* | P |

**Accessibility**

| ID | Behavior | Tier |
|---|---|---|
| A11Y-01 | every page the server renders passes axe's automated rules: sign-in, code, approval, and your page with accounts, apps and activity | U |

**Exit:** all of the above green; then tried live (not yet).

### Phase 8 — Files and clean-up *(added 2026-09-30: 2.4.1)*

**Sending attachments**

| ID | Behavior | Tier |
|---|---|---|
| OUT-01 | a send carries a file from another email, byte for byte, and a text file the AI wrote (UTF-8, labelled so); the answer lists them; the source email stays unread | U |
| OUT-02 | a reply and a draft carry them too; editing a draft keeps its attachments and adds more | U |
| OUT-03 | nothing is sent when an attachment isn't there, a written file's name or kind isn't allowed (programs, web pages, hidden names, folders, control characters, no extension), or they come to more than the limit | U |
| OUT-04 | the tools describe both kinds and what may be written | U |
| OUT-05 | held for someone new, the answer names the files that would go | U |
| OUT-06 | on a real server and SMTP capture: a stored file and a written one arrive byte for byte; the source stays unread | P |
| OUT-07 | every attachment as the sandbox hands it over: name, type, exact bytes; structure limits first *(added: coverage)* | U |

**Forwarding**

| ID | Behavior | Tier |
|---|---|---|
| FWD-01 | the note, then the original's sender, date, subject, recipients and text, and its attachments byte for byte; "Fwd:" subject; the original stays unread | U |
| FWD-02 | without attachments when asked; "Fwd:" never doubled; no note is fine | U |
| FWD-03 | to someone new: held, naming the files, nothing sent | U |
| FWD-04 | a message that isn't there: refused, nothing sent | U |
| FWD-05 | needs Send; marked as reaching outside | U |
| FWD-06 | on a real server: the forward reaches the SMTP capture with the original's text and attachments | P |
| FWD-07 | a forward refers to the original (References), without claiming to answer it *(added: 2.4.2, found live)* | U |

**Unsubscribing**

| ID | Behavior | Tier |
|---|---|---|
| UNS-01 | a sender offering one click is asked once, at its own https address; the email is left as it was | U |
| UNS-02 | no one click (mailto only, no promise header, nothing): left to the owner, nothing sent | U |
| UNS-03 | an email with cautions is never answered | U |
| UNS-04 | a refusal or error from the sender is reported with its status | U |
| UNS-05 | only https, a name, port 443, no password; every DNS answer public (private, loopback, link-local, metadata, mixed, none: refused before connecting); anything but 2xx, redirects included, fails | U |
| UNS-06 | the request: one POST of "List-Unsubscribe=One-Click" to the vetted address with the real host name; redirects not followed; slow or huge answers cut off | U |
| UNS-07 | the headers read from the server, folded and in any case, read-only; a system email is not found | U |
| UNS-08 | needs Organize; marked as reaching outside; never read-only | U |
| UNS-09 | the real parts: DNS answers passed on; https with the certificate checked (an untrusted one refused before anything is sent) *(added: coverage)* | U |
| UNS-10 | on a real server: the headers come from the stored message; the email stays unread | P |
| UNS-11 | the account's own email: nothing to unsubscribe from, with its own code (MAIL-UNSUBSCRIBE-OWN since 2.4.4) and no talk of junk; other refusals say what the sender offers *(added: 2.4.2, found live)* | U |
| UNS-12 | header lines are read from the whole header block, never asked for by name: on a server that answers nothing to named lines (Yahoo), the summary, the unsubscribe tool, replies and the thread scan see them; ids elsewhere in the header don't count *(added: 2.4.4; fixed 2.4.5, found live twice)* | U |

**Junk**

| ID | Behavior | Tier |
|---|---|---|
| JNK-01 | one or many go to the provider's Junk folder; restore brings one back | U |
| JNK-02 | no Junk folder marked: refused, nothing moved, never guessed | U |
| JNK-03 | needs Organize; one or a batch; not read-only | U |
| JNK-04 | on a real server: the folder marked Junk, whatever its name (Yahoo's "Bulk") | P |

**Finding mail with attachments** *(added: 2.4.2, found live)*

| ID | Behavior | Tier |
|---|---|---|
| FND-01 | each search result names its attachments; inline pictures with a content id aren't attachments | U |
| FND-02 | only with (or without) attachments, or by an attachment's name, any case; pages still fill, and paging never skips or repeats | U |
| FND-03 | a search checked after the server's reads 50 at a time (a plain one only what it shows); a page looks at 1,000 at most, then answers with a cursor and a warning | U |
| FND-04 | the search tool takes both filters, says so, and passes the warning on | U |
| FND-05 | on a real server, from the stored message structure | P |
| FND-06 | on Gmail, text search asks for the exact phrase with Gmail's own search; other servers keep the standard search *(added: 2.4.3, found live)* | U |
| FND-07 | a search for attachments says that pictures shown in an email's text aren't counted *(added: 2.4.4, found live)* | U |

**Who fills a folder**

| ID | Behavior | Tier |
|---|---|---|
| WHO-01 | senders by count (most first, whenever their mail came), with unread counts, newest date and one-click unsubscribe; addresses in any case count as one; top N | U |
| WHO-02 | a sender that looks like a scam carries its cautions | U |
| WHO-03 | only the newest N by position, read-only, envelopes, flags and two headers, never a body; system emails left out | U |
| WHO-04 | needs only Read; marked read-only | U |
| WHO-05 | on a real server: counts from the server's envelopes, flags and headers | P |
| WHO-06 | the best way each sender offers to unsubscribe: one click, a link, an email address, or none *(added: 2.4.2, found live)* | U |
| WHO-07 | a sender whose replies go to another domain carries that caution, once *(added: 2.4.2, found live)* | U |

**Exit:** all of the above green; then tried live (not yet).

### Phase 9 — Finding everything *(added 2026-10-06: 2.4.6, from the owner's logs and live checks)*

| ID | Behavior | Tier |
|---|---|---|
| FND-08 | on a server whose search isn't trusted (not Gmail), a search by sender, recipient or subject that found less than a page also checks the folder's newest 100 messages directly (envelopes, by position, first page only), matching any part of a name or address in any case; read and flagged still apply; the answer says how many the server's search left out; a real server's finds aren't listed twice *(found live: Yahoo's search found 4 of a sender's 16 in Trash)* | U+P |
| FND-10 | `search_email` with `allFolders`: every folder of one account but Trash and Junk (Gmail: All Mail once), newest first, each result naming its folder; the usual folders first, then the rest within 45 s, the answer saying how many were left; the direct check only in the usual folders; the folder list asked afresh *(the owner's choice)* | U+P |
| THR-08 | a conversation looked for in every folder: Inbox, Sent, Archive and its own folder first and always; the rest while within 45 s, the answer saying how many folders weren't searched *(found in the server's log: 206 s and 231 s on 44 Yahoo folders, one call cut at 300 s)* | U |
| THR-09 | in that search, the other folders check only their newest 50 messages directly (the usual ones 200) | U |
| SCM-11 | a sender's name with invisible characters between its letters (Unicode format characters, but not the joiner inside an emoji) is cautioned, and the name is checked with them taken out *(found live: a brand's name split by tag characters)* | U |
| BLK-01 | `matching` on the eight tools that take `uids` (move, archive, mark read/unread, flag, trash, junk, restore): acts on what a search finds; the answer says how many matched *(the owner's choice)* | U+P |
| BLK-02 | more than 100 match: the newest 100 are acted on, and the answer says to call again | U |
| BLK-03 | `matching` with nothing to match on is refused (`MAIL-MATCHING-EMPTY`), nothing changed; exactly one of `uid`, `uids` or `matching` | U |
| BLK-04 | nothing matched: a plain answer (`NOTHING_MATCHED`), nothing for the activity log; what matching acted on is logged with its count and undo | U |
| SET-85 | the sending test counts the copies in Sent from whole header blocks, by their Message-ID line: a server that answers nothing to named header lines (Yahoo) still shows the one it filed *(found reading the code after UNS-12)* | U+P |
| SET-86 | a provider known to file its own Sent copy a minute or two later (Yahoo, ENG-24) files its own even when the test saw none in its 20 s: on your page, in setup and in Check and fix *(found with SET-85: otherwise every email sent would leave two copies)* | U |
| FOL-01 | `list_folders` with `counts`: each folder's messages and unread from the server (STATUS), a folder that holds no mail skipped, the list asked afresh; without it, none asked *(the owner's choice)* | U+P |

**Exit:** all of the above green, mutation-checked; then tried live.

### Diagnostics — across phases

| ID | Behavior | Tier |
|---|---|---|
| DIA-01 | every report matches the schema | U |
| DIA-02 | a failed stage marks the stages that depend on it `NOT_RUN` | U |
| DIA-03 | canaries planted in every failure path never appear in a report | U |
| DIA-04 | every code used in the source is in the registry, and every registry code is used (static scan) | U |
| DIA-05 | every report opens with its plain-English readme | U |
| DIA-06 | the server's own stages: version, sign-in round trip, then per account sign-in (a revoked password, an outage and refused encryption each get their own code), the read tools on real mail, the Sent mode *(added)* | U |
| DIA-07 | the check token: minted by setup with Node's built-ins, verified by the server; five minutes, once only, only for the check route; a check token never opens the mail tools *(added)* | U |
| DIA-08 | the `/{key}/check` route: only setup's token opens it; the report, never cached; refusals and failures logged without their words; on real servers every stage passes and no mail is marked read *(added)* | U+P |
| DIA-09 | the `live:` stage: a test message in its own folder, found by ID, marked read and unread, flagged and unflagged, moved to Trash, each change confirmed; a change that doesn't happen fails it and the log names the step; no safe move leaves it in its folder *(added: owner's choice, 2026-09-26)* | U+P |
| DIA-10 | on the installed server (with your page), setup's check token reaches the check and gets the report; without a token no report is given *(added: found live: the page's route answered 403)* | U |
| DIA-11 | `node setup.js report` includes the server's own log once a project exists (oldest first, JSON whole); unreadable: one plain line, still exit 0 *(added: asked for live)* | M |
| DIA-12 | every tool call leaves one log line: the tool, the account, its time, its outcome and code; never its arguments or answer *(added: for the live performance test)* | U |
| DIA-13 | each tool's log line also says where its time went, by step name only: a login, each kind of mail server command, the SMTP send, parsing (total ms and count); a step that fails still counts; two calls at once keep their own *(added: the fourth live run: tuning by guesswork missed get_thread and send)* | U+P |

---

## 7. Coverage and CI

- **Coverage has a floor per package.** It starts at the v1 baseline and only
  rises; it's never lowered to make a build pass.
- **Every push runs:** unit, sign-in, setup matrix, protocol and pages.
- **Nightly, and before every release:** the fresh install on real Google Cloud.
- **A red test blocks merge. A release is cut only from green.**

---

## 8. Tests that aren't code

### The novice test (Phase 3 exit)

- **Participant:** someone who has never used a command line.
- **Setup:** a new Google account, two email providers, and only the
  instructions in DESIGN-V2.md §3, on paper or screen.
- **Observer:** silent. Records every pause longer than 30 seconds, every
  question and every wrong click.
- **Pass:** they reach "All done" and connect Claude with no help.
- **Every recorded hesitation becomes a wording change**, plus a SET test that
  locks the new wording in.

### Live acceptance per app

An app is labelled **tested** only after a real connection passes the live tier.
Claude must pass before release. ChatGPT is labelled tested only when it passes.

---

## 9. The first cycle

After the v1 baseline is ported and green, write these five in order:

1. **TK-01** — the network guard
2. **TK-02** — Dovecot with a named profile
3. **ENG-01** — accounts looked up by name
4. **ENG-02** — an unknown account name fails with the valid names listed
5. **ENG-03** — `account` optional when only one is reachable

Each one goes red, then green, then into the journal, before the next is
written.

---

## 10. The TDD journal

`docs/TDD-JOURNAL.md` in the new project, one row per cycle:

| Date | Test | Red (first line) | Change | Green | Suite total |
|---|---|---|---|---|---|

The journal is the evidence that every behavior started as a failing test. It's
also where a later reader finds out why a line of code exists.

---

## Totals

| Group | Tests |
|---|---|
| v1 baseline | 155 |
| Test kit | 13 |
| Engine | 87 |
| Sign-in | 67 |
| Setup | 71 |
| Installed server | 6 |
| Release | 12 |
| Page and emails | 21 |
| Everyday polish | 15 |
| Diagnostics | 15 |
| Subscription | 33 |
| Serving people (2.4) | 39 |
| Files and clean-up (2.4.1-2.4.4) | 53 |
| Finding everything (2.4.6) | 12 |
| **New** | **444** |
| **Total** | **599** |

Tests added during the build are marked in their tables, with the reason.
Of the v1 baseline, 74 tests were retired in 2.3.1 with the v1 code they
checked (the Auth0 sign-in modes, v1's deployment scripts and verify runner).
This copy, in `universal-mail-mcp`, is the canonical plan.
