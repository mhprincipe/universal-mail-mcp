# Universal Mail MCP

Your email accounts (Yahoo, Gmail, iCloud, Fastmail, AOL, Zoho and other IMAP
providers) connected to your AI apps (Claude and ChatGPT), through a private
server in your own Google Cloud account. Your AI can search, read, organize
and, when you allow it, send your email. You choose, per app and per account,
what each may do.

**Status:** version 2.4.5. Installed and in daily use: every tool tested live
on Yahoo with Claude and with ChatGPT; Gmail connected live. 2.4 added reading
attachments, scam warnings, a check before writing to someone new, send limits,
and an activity log with undo; 2.4.1 added sending attachments, forwarding,
marking junk, one-click unsubscribe and a "who fills my inbox" summary; 2.4.2
fixes what the first live run of those found. What changed in each version:
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
| [docs/TOOLS.md](docs/TOOLS.md) | the 21 tools: inputs, answers, permissions, codes |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | releasing, updating, logs and timings, known provider behaviour |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | a map of the code |
| [docs/TESTING.md](docs/TESTING.md) | the test tiers, the rules, the test kit, live runs |
| [docs/DESIGN-V2.md](docs/DESIGN-V2.md) | what it is and why: the full design and its decisions |
| [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) | the 2.4 and 2.4.1 security reviews: what was found, what was fixed, what's left |
| [docs/DESIGN-CONFIRM-ON-PAGE.md](docs/DESIGN-CONFIRM-ON-PAGE.md) | proposed: confirming a new recipient on your page instead of in the chat, for the owner's review |
| [docs/DESIGN-PROVIDER-SIGNIN.md](docs/DESIGN-PROVIDER-SIGNIN.md) | proposed for 2.5: signing in with Microsoft and Google (for Outlook), for the owner's review |
| [docs/TEST-PLAN-V2.md](docs/TEST-PLAN-V2.md) | every test, by ID |
| [docs/TDD-JOURNAL.md](docs/TDD-JOURNAL.md) | every red-green cycle and live run |
| [docs/LIVE-TEST-PROMPT.md](docs/LIVE-TEST-PROMPT.md) | one prompt that tests everything on every account |
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
npm run test:all       # a dependency audit, then all of the above, in order
```

The loop: pick the next test from the plan, see it fail for the right reason,
write the least code that passes, run everything green, then record the cycle in
the journal. Releasing: [docs/OPERATIONS.md](docs/OPERATIONS.md).

This project began as a copy of the working v1 engine (`yahoo-mail-mcp`), which
v2 has replaced.
