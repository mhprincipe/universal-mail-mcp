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

**Thread strategies**

| ID | Behavior | Tier |
|---|---|---|
| THR-01 | Gmail-like: a thread is found with a single thread-ID search | U (scripted fake) |
| THR-02 | when the provider's header search is reliable, it alone finds the thread: no scan of recent messages *(replaced during build: the plan said "`THREAD=REFERENCES` is used when offered". ImapFlow has no THREAD support, and THREAD works one folder at a time while a conversation spans folders, so it would save nothing over the header search those servers already do reliably. This test keeps the aim, fewer round trips, with less code.)* | P |
| THR-03 | the Yahoo-like fallback scans only Inbox, Sent, Archive and the seed message's folder | P |
| THR-04 | `allFolders: true` scans every selectable folder | P |
| THR-05 | Gmail-like: a full scan skips All Mail, and a message under several labels appears once | U (scripted fake) |
| THR-06 | the fallback still finds a reply when HEADER search returns nothing | P (fault proxy) |

**Protocol tier: real IMAP per profile**

| ID | Behavior | Tier |
|---|---|---|
| PRO-01 | the 16-tool workflow passes on `yahoo-like` | P |
| PRO-02 | the 16-tool workflow passes on `gmail-like` | P |
| PRO-03 | the 16-tool workflow passes on `minimal` (the UIDPLUS move path) | P |
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
| SET-22 | password prompts don't echo, and say so | U |
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

### Release *(added during build)*

| ID | Behavior | Tier |
|---|---|---|
| REL-01 | release.json names the official image by its sha256 digest, exactly as setup's image check requires; tags and malformed digests are refused | U |
| REL-02 | the update feed says the version and whether it is a security release, as the server reads it | U |
| REL-03 | the server image, built from the Dockerfile and started as Cloud Run starts it: waiting before its address, serving as itself after, unhealthy with a named setting when damaged, not running as root | K (package) |
| REL-04 | the published release branch runs on its own: `node setup.js report` with no node_modules, the pinned image, the feed, a package.json saying ES modules *(added: found release.yml omitted it)* | K (package) |
| REL-05 | `scripts/release-setup.sh` creates the release project, public image store and keyless publishing for this repository only; safe to rerun; stops plainly without billing; waits and retries while a just-enabled service still refuses *(added; retry found live)* | K (package) |
| REL-06 | one image store, named once: the setup script, the workflow and setup's trusted image agree; the workflow publishes through `publish-setup.mjs` *(added)* | U |

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
| Engine | 55 |
| Sign-in | 57 |
| Setup | 58 |
| Installed server | 6 |
| Release | 8 |
| Page and emails | 17 |
| Everyday polish | 11 |
| Diagnostics | 9 |
| **New** | **234** |
| **Total** | **389** |

Tests added during the build are marked in their tables, with the reason.
This copy, in `universal-mail-mcp`, is the canonical plan.
