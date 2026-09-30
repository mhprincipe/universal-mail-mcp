# Operations runbook

Releasing Universal Mail, keeping an installation current, and finding out
what happened. Written from what was actually done and seen during the live
install and tuning (September 2026). For using it, see
[USER-GUIDE.md](USER-GUIDE.md).

---

## Where things live

| What | Where |
|---|---|
| Source | `main` branch of this repository |
| What installs run | the append-only `release` branch: setup's files, pinned to one image |
| The update feed | `latest.json` on the `release` branch (`{"version": …, "security": …}`) |
| The server image | the repository named in `scripts/release-files.mjs` (`REPOSITORY`), signed with cosign |
| An installation's settings | two Secret Manager secrets in the owner's project: `universal-mail-state` (accounts, grants, no passwords) and `universal-mail-credentials` (app passwords and keys) |
| One-time release setup | `scripts/release-setup.sh` (done), `scripts/license-setup.sh` (only when selling) |

Nothing secret is ever logged: passwords, keys and tokens are masked, and the
tool log never contains arguments or answers.

---

## Releasing a version

1. **Everything green** on your machine: `npm run test:all` (a dependency audit
   that stops on a known high-severity problem, the typecheck, the unit tier and
   its coverage floor, then the slow tier: real mail servers in Docker, the built
   setup and the server image).
2. **Version** in three places: `package.json`, the top two `version` lines of
   `package-lock.json` (only those), and `src/version.ts`.
3. **Record it**: the journal row(s) in `docs/TDD-JOURNAL.md`, the plan rows
   and totals in `docs/TEST-PLAN-V2.md`, and `CHANGELOG.md`.
4. **Commit and push `main`.** CI (`.github/workflows/ci.yml`) runs the
   dependency audit (REL-08), the typecheck, the unit tier with its coverage floor, and the slow tier. Wait for
   it to pass. Without the `gh` CLI:
   `curl -s "https://api.github.com/repos/mhprincipe/universal-mail-mcp/actions/runs?head_sha=$(git rev-parse HEAD)"`.
5. **Tag the commit** `vX.Y.Z` (an annotated tag; put "security" in its first
   line to mark a security release: only the tag's message counts, never the
   commit's, REL-09) and push the tag. Pin the tag to the commit
   you mean (`git tag -a vX.Y.Z <sha> -m "…"`) and check that commit's subject
   first: a script once tagged the previous commit when a check stopped the
   commit.
6. **The release workflow** (`.github/workflows/release.yml`) checks the tag
   matches `package.json`, runs CI again, builds the image (with
   `UPDATE_FEED_URL` and `LICENSE_SERVICE_URL`), pushes and signs it, pins
   setup's files to its digest, and appends a commit to the `release` branch.
7. **Verify**, from anywhere:
   - `latest.json` on the release branch shows the new version;
   - the image manifest for the version answers 200 (anonymous token from the
     registry), and a `.sig` tag exists for it;
   - a fresh `git clone -b release` shows the new "Release X.Y.Z" commit on top
     of the previous one (append-only: `git merge-base --is-ancestor HEAD~1 HEAD`).

---

## Keeping an installation current

In Cloud Shell:

```bash
cd ~/universal-mail && git pull
node setup.js
```

The menu: **1 Check and fix** (tests everything, repairs what it can),
**2 Update** (installs the latest release, tests it, puts the old one back if
the test fails), **3 Show my address**, **4 Remove**.

Cloud Shell remembers a default project; installs and log commands name the
project explicitly, so it doesn't matter, but pointing it at the installation
avoids confusion: `gcloud config set project <project-id>`.

---

## Finding out what happened

### Every tool call (timing and outcome)

One JSON line per call: the tool, the account, total milliseconds, ok/code, and
`phases`, where the time went, by step (DIA-12, DIA-13):

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="universal-mail" AND jsonPayload.event="tool"' --project=<project-id> --freshness=1h --limit=300 --format='value(timestamp,jsonPayload.name,jsonPayload.account,jsonPayload.ms,jsonPayload.ok,jsonPayload.code,jsonPayload.phases)'
```

| Phase | Is |
|---|---|
| `imap.connect` | a new login to the mail server (the kept connection was gone) |
| `imap.getMailboxLock` | opening a folder (SELECT/EXAMINE); 0 when it was already open |
| `imap.search`, `imap.fetchAll`, `imap.fetchOne`, `imap.messageMove`, `imap.messageFlagsAdd`, … | mail server commands by kind |
| `imap.noop` | the check of a connection idle for over two minutes |
| `imap.wait` | queued behind another call on the same account (two apps at once) |
| `smtp.send` | handing a message to the provider |
| `parse` | reading a message safely |

Reference numbers from the live Yahoo runs on 2.2.6: every Yahoo command
~0.3-0.4 s; a re-find after a change ~0.6 s; get_email ~0.7 s; send 2.4 s and
reply 3.2 s (all `smtp.send`); get_thread ~6 s (mostly Yahoo's header search).

### Requests the server turned away

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="universal-mail" AND httpRequest.status>=400' --project=<project-id> --freshness=1d --limit=50 --format='value(timestamp,httpRequest.requestMethod,httpRequest.status,httpRequest.latency,httpRequest.requestUrl)'
```

Normal entries: `401` on `/…/mcp` (an app asked before signing in) and `404` on
`/.well-known/openid-configuration` (ChatGPT probing before it finds the OAuth
metadata).

### What the apps did

Your page's **Recent activity** lists what each app changed in the last 30 days
(never content), with undo for moves, marks and flags. It is kept in memory and
saved with the settings (`universal-mail-state`) about 30 seconds after a change,
and at once when Cloud Run stops the server (SIGTERM); it's capped at 100
entries and 16 KB so the settings record stays under Secret Manager's 64 KB.

### Messages and attachments that couldn't be read

Messages and attachments are read in a separate worker with a 10-second limit,
a 256 MB heap and a watch on the memory it takes outside the heap (160 MB).
One that passes a limit is stopped, remembered (so it isn't tried again), and
answered `MAIL-PARSE-UNSAFE`; the email itself still opens when only an
attachment failed. The server log line names the limit, never the content.

### Everything, for help

- On the page: **Health → Check that everything works** gives a report.
- In Cloud Shell: `node setup.js report` gives setup's log and the server's own
  log. Both contain no mail and no secrets, so they can be pasted into an AI.

### The live test

`docs/LIVE-TEST-PROMPT.md` has prompts that exercise every tool on one account
(Yahoo-style and Gmail), only on messages the test creates. Run one app at a
time: two at once queue behind each other on the same account and blur the
timings.

---

## Known provider behaviour

| Provider | Behaviour | Handled by |
|---|---|---|
| Yahoo | header search misses new mail | a check of the newest 200 messages (ENG-21, ENG-22) |
| Yahoo | batch moves report old/new UIDs mispaired | pairs checked by Message-ID (ENG-20) |
| Yahoo | subject search ignores "Re:" | results checked against the subject (POL-13) |
| Yahoo | files its own Sent copy a minute or two later | no lookup; the answer says so (ENG-24) |
| Yahoo | IMAP dates compare whole days | a day either side, exact times applied (POL-12) |
| Yahoo | lists the address as its own display name | dropped (POL-15) |
| Yahoo | adds a `References … .ref` header to mail it stores | its own; Universal Mail adds none (ENG-19) |
| Any | an open folder isn't told about new mail until asked | not found → NOOP → asked once more (ENG-25) |
| Gmail | folders are labels; archive = All Mail; threads by conversation id | provider profile |
