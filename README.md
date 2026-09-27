# Universal Mail MCP

**Status:** development complete (test first, every behaviour in the plan
built and tested), awaiting the first live install. Open decisions and the
live-install checklist: [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).

**To install** (once a release is published):
[Open in Google Cloud Shell](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/mhprincipe/universal-mail-mcp&cloudshell_git_branch=release)
and type `node setup.js`. Running it again later shows a menu:
Check and fix, Update, Show my address, Remove. If anything stops,
`node setup.js report` gives a block that's safe to paste into your AI.

One person's email accounts, on any common provider, connected to their AI
apps, through a private server in their own Google Cloud account.

This project started as a copy of the working v1 engine (`yahoo-mail-mcp`),
which stays untouched and in daily use. v2 is built here, one failing test at a
time.

| Document | For |
|---|---|
| [docs/DESIGN-V2.md](docs/DESIGN-V2.md) | what we're building, and why |
| [docs/TEST-PLAN-V2.md](docs/TEST-PLAN-V2.md) | every test, in build order |
| [docs/TDD-JOURNAL.md](docs/TDD-JOURNAL.md) | every red-green cycle so far |
| [docs/PRODUCT-DESCRIPTION.md](docs/PRODUCT-DESCRIPTION.md) | market copy, with its pre-publication checklist |
| [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | decisions for the owner, what only the live install can settle, the checklist |

The other files in `docs/` describe v1. They still apply to the engine carried
forward, and will be replaced as v2 lands.

## Working on it

```bash
npm install
npm test               # unit tier; can't reach the internet, needs nothing
npm run test:protocol  # the slow tier: real mail servers in containers, the built
                       # setup.js and the server image; needs Docker Desktop running
npm run coverage       # unit tier plus the coverage floor, which may only rise
npm run typecheck
```

The loop: pick the next test from the plan, see it fail for the right reason,
write the least code that passes, run everything green, then record the cycle in
the journal.
