# Open questions, decisions made for you, and the live-install checklist

Written 2026-09-25 at the end of the autonomous development run. Development
is complete except where a decision is yours, or only the live Google install
can settle something. Each decision below was made with a safe default and can
be changed.

## Decisions that are yours

| # | Question | What was built meanwhile |
|---|---|---|
| 1 | **The `live:` check stage.** | **Decided 2026-09-26: try it live.** Built (DIA-09): each check leaves a "Universal Mail check" folder and one test message in Trash per account. |
| 2 | **Converting v1 installs a new service beside it**, in v1's own Google project, never touching v1. | **Confirmed 2026-09-26.** |
| 3 | **Tool names and descriptions no longer say "Yahoo".** | **Confirmed 2026-09-26.** |
| 4 | **A new account added on your page runs setup's sending test** without asking first. | **Confirmed 2026-09-26.** |
| 5 | **The update feed's address** (where the server looks for new versions) and **the GitHub repository** the release pipeline publishes from. | **Settled 2026-09-26:** repository `mhprincipe/universal-mail-mcp`; images in the Google project `universal-mail-rel-zqrw`; the feed is `latest.json` on the `release` branch (no GitHub Pages). `scripts/release-setup.sh` creates the Google side and prints the three variables. |
| 6 | **`DONE-ALREADY` ("✓ Already done") was removed** from setup's messages: it was never shown and isn't in the design. | Removed (DIA-04 found it). |
| 7 | **After a lapse: read-only, or every tool refused?** (design §13.4) | **Built: read-only.** Reading and search keep working; organizing and sending answer with one sentence and the page link. The other choice is one constant away (`readOnly` in `src/multiMail.ts` gates `organize` and `send`; gating `read` too would make it a lockout). |
| 8 | **Prices and plans.** | **Built as defaults: $4 a month or $36 a year**, per person, any number of accounts, a 30-day trial with no card, 14 days of grace. The numbers live in `src/page/views.ts` (the page) and in Paddle (the prices). |
| 9 | **Merchant of record.** | **Built for Paddle** (global sales tax, invoices, refunds handled by them). Its webhook signature and event shapes are as documented; the first real purchase confirms them (`src/licenseService/paddle.ts`). |

## Things only the live install can settle

These are isolated in one place each, logged in detail, and marked in the
code. The setup log (`node setup.js report`) and the server's log carry enough
to diagnose each one.

| What | Where | What to look at if it goes wrong |
|---|---|---|
| How `gcloud` shows a **free-trial** billing account | `billing()` in `src/setup/gcloud.ts` | the `gcloud` lines in the setup log (Google's own words are kept) |
| Checking the **project quota** before creating a project | `canCreateProject()` (today: learned when creating, before any other change) | `SETUP-PROJECT-QUOTA` in the log |
| The **company-policy** check for public services | `blocksPublicServices()` | the `org-policies describe` line |
| Google's exact **error wording** for refusals | `classify()` in `gcloud.ts` | an unexpected refusal shows as `SETUP-UNEXPECTED` with Google's words in the log |
| **Real DNS and autoconfig** lookups for custom domains | `realLookups()` in `src/setup/realMail.ts` | `detect-detail` events: via, provider, both host names |
| The requester **IP behind Cloud Run** (limits code requests per requester) | settled in code: the installed server trusts one proxy hop (Cloud Run's front end); tested | if Google ever adds a second hop, requesters would look alike; codes stay limited per sign-in address regardless |
| Whether Cloud Run's metadata token can **add and destroy secret versions** with `secretVersionManager` | `src/secretWriter.ts` | `state_save_failed` with a status in the server log |
| **Header search reliability** per provider (Yahoo's HEADER search is unreliable; others may be fine) | provider profiles | thread results; `reliableHeaderSearch` per account |

## Live-install checklist (the novice test)

0. **Done 2026-09-27.** **Once, as the publisher (about 5 minutes).** Open
   [Cloud Shell](https://shell.cloud.google.com), then:

   ```bash
   git clone https://github.com/mhprincipe/universal-mail-mcp.git && cd universal-mail-mcp
   bash scripts/release-setup.sh
   ```

   It creates the project `universal-mail-rel-zqrw` (billing must be open on
   your account), the public image store, and a keyless link that lets only
   this repository's release workflow publish. It is safe to run again. At the
   end it prints three lines: add each on GitHub under the repository's
   Settings → Secrets and variables → Actions → **Variables** → New
   repository variable.
1. **Done 2026-09-27:** image `sha256:9fffa6d4…`, signed, publicly readable; release branch and feed live. Push the tag `v2.0.0` (the version is already 2.0.0): the pipeline tests,
   builds, signs, pins the image in `release.json`, and publishes the
   `release` branch with the feed. Watch it under the repository's Actions tab.
2. Open Cloud Shell from the release branch and run `node setup.js` with one
   Yahoo account. Watch for: every step's wording, the free-trial question,
   the sending test, and "All done".
3. If anything stops: `node setup.js report`, paste it into your AI.
4. Connect Claude with the AI-app address; approve with a code. Ask it to list
   folders, search, and read a message (nothing is marked read).
5. On your page: sign in, add a fingerprint, run Check, copy the report.
6. From a phone: add an account, fix a password, disconnect an app (the
   Phase 4 exit test).
7. Run `node setup.js` again: the menu; Check and fix; Show my address.
8. Only then convert v1 (menu appears on its own in v1's project), and keep v1
   until you're happy.

## Selling it: what only you can do (design §13)

Everything below the line is built and tested; nothing here needs code. Until
step 4 is done, every release is a **permanent free trial** (no service
address baked in), so none of this blocks the live install.

1. **A business to sell from:** an LLC (or your country's equivalent), a
   business bank account, a support email address. Terms of service and a
   privacy policy (yours is short: you hold an install id, a license code and
   the merchant's ids; never mail, passwords or a copy of anything).
2. **A Paddle account** (paddle.com; they verify the business, usually a few
   days). In it: two prices (monthly $4, yearly $36), and from its settings:
   a **client-side token**, the two **price ids**, and a **webhook** whose
   destination you'll get in step 3, with its **secret**.
3. **The service, once**, in Cloud Shell, in the repository clone:

   ```bash
   PADDLE_WEBHOOK_SECRET=... PADDLE_CLIENT_TOKEN=... PADDLE_PRICE_MONTHLY=pri_... PADDLE_PRICE_YEARLY=pri_... bash scripts/license-setup.sh
   ```

   It prints `LICENSE_SERVICE_URL` (a GitHub repository variable, like the
   three before it) and the two addresses to paste into Paddle: the webhook
   destination and the checkout's success page.
4. **A release** after the variable is set: from then on new installs get a
   30-day trial, then the Subscription section on their page. Installs from
   earlier releases join in at their next update.
5. **Try it yourself first**, with Paddle's sandbox: buy from your own page,
   watch "Paid through" appear within a day (or at once after Check), cancel,
   watch the emails arrive.