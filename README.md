# Universal Mail MCP

Your email accounts (Yahoo, Gmail, iCloud, Fastmail, AOL, Zoho and other IMAP
providers) connected to your AI apps (Claude and ChatGPT), through a private
server in your own Google Cloud account. Your AI can search, read, organize
and, when you allow it, send your email. You choose, per app and per account,
what each may do.

**Status:** version 2.3.0 (1.0). Installed and in daily use: every tool tested
live on Yahoo with Claude and with ChatGPT; Gmail connected live. What changed in each version:
[CHANGELOG.md](CHANGELOG.md).

## Install

[Open in Google Cloud Shell](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/mhprincipe/universal-mail-mcp&cloudshell_git_branch=release)
and type `node setup.js`. It asks for your email addresses and an app password
for each (it shows where to make one), sets everything up, and gives you two
private addresses: your Universal Mail page, and the address for your AI apps.

Running it again later shows a menu: Check and fix, Update, Show my address,
Remove. If anything stops, `node setup.js report` gives a block that's safe to
paste into your AI.

Then connect Claude and ChatGPT and choose their permissions: see the
[user guide](docs/USER-GUIDE.md).

## Documentation

| Document | For |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | installing, connecting apps, accounts and permissions, everyday use, troubleshooting |
| [docs/TOOLS.md](docs/TOOLS.md) | the 16 tools: inputs, answers, permissions, codes |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | releasing, updating, logs and timings, known provider behaviour |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | a map of the code |
| [docs/TESTING.md](docs/TESTING.md) | the test tiers, the rules, the test kit, live runs |
| [docs/DESIGN-V2.md](docs/DESIGN-V2.md) | what it is and why: the full design and its decisions |
| [docs/TEST-PLAN-V2.md](docs/TEST-PLAN-V2.md) | every test, by ID |
| [docs/TDD-JOURNAL.md](docs/TDD-JOURNAL.md) | every red-green cycle and live run |
| [docs/LIVE-TEST-PROMPT.md](docs/LIVE-TEST-PROMPT.md) | prompts that exercise every tool on a real mailbox |
| [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | decisions for the owner, and what's still open |
| [docs/PRODUCT-DESCRIPTION.md](docs/PRODUCT-DESCRIPTION.md) | market copy |
| [docs/v1/](docs/v1/) | the first version's documents (Yahoo only, Auth0), kept for history |

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
the journal. Releasing: [docs/OPERATIONS.md](docs/OPERATIONS.md).

This project began as a copy of the working v1 engine (`yahoo-mail-mcp`), which
v2 has replaced.
