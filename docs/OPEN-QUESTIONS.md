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
| 5 | **The update feed's address** (where the server looks for new versions) and **the GitHub repository** the release pipeline publishes from. | `UPDATE_FEED_URL` is baked into the image at release; with none set, no update check is made. The workflows use repository variables you set once. |
| 6 | **`DONE-ALREADY` ("✓ Already done") was removed** from setup's messages: it was never shown and isn't in the design. | Removed (DIA-04 found it). |

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

1. Set the repository variables in `release.yml` and push a tag (`v2.0.0`): the
   pipeline tests, builds, signs, pins the image in `release.json`, and
   publishes the `release` branch and the feed.
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
