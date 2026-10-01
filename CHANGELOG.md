# Changelog

Every release, newest first. The test IDs point into
[docs/TEST-PLAN-V2.md](docs/TEST-PLAN-V2.md); the full story of each is in
[docs/TDD-JOURNAL.md](docs/TDD-JOURNAL.md).

## 2.4.4 (2026-10-01): the final fixes before the final test

No tool's name, inputs or description changed: Claude and ChatGPT need no
refresh for this update.

- **Unsubscribe on Yahoo** (UNS-12): every Yahoo sender showed "none", LinkedIn
  included. Headers are now asked for as they're written (List-Unsubscribe);
  Yahoo answered nothing to the lower-case names. The same goes for the
  References a reply needs to join its conversation.
- **"Amazon Deals" from an unrelated domain gets a caution** (SCM-09): sales
  words no longer hide a company's name.
- **Unsubscribing from your own email** has its own answer (MAIL-UNSUBSCRIBE-OWN),
  without the junk suggestion.
- **A search of every account says which it searched** (ENG-30).
- **Said in the answers:** a search for attachments notes that pictures shown in
  an email's text don't count (FND-07); a Gmail conversation notes its messages
  come from All Mail (THR-07).
- **The live test** is now one Claude prompt that picks up where it stopped,
  cleans each account as it goes and checks the send limit with you, plus your
  checks on the page and a short ChatGPT check.

## 2.4.3 (2026-09-30): from the everything test

- **You're told when your AI apps can't see new tools** (NTC-01, NTC-02). Found
  live: Claude kept the tool list it saw when it was connected, and couldn't
  use five tools added since. When a version adds tools, you get one email
  naming them, with how to refresh Claude and ChatGPT.
- **Quieter scam warnings on newsletters** (SCM-08): mail sent through a
  mailing service (Constant Contact, Shopify Email, Mailchimp and others) with
  replies to the business's own domain is ordinary; 5 of 8 cautions in the live
  run were this. Replies to a personal mailbox are still pointed out.
- **Exact text search on Gmail** (FND-06): Gmail's standard search matched the
  words anywhere; its own search takes the phrase.
- **Account names with their provider** (ENG-29): "google (Gmail), yahoo
  (Yahoo Mail)" in the tools and their refusals, so an AI doesn't guess "gmail".
- The coverage floor rises to 94/85/94/96.

## 2.4.2 (2026-09-30): what the first live run found

- **Find mail with attachments** (FND-01..05): search results name their
  attachments, and search can ask for mail with attachments, or by an
  attachment's name. (Found live: a search for "pdf" found nothing; mail
  servers' text search doesn't look at attachment names.)
- **Faster filtered searches** (FND-03): a search the server matches loosely
  (Yahoo's subject search) reads 50 candidates at a time, not 5: 20 round trips
  and 8.6 s in the live log.
- **What a sender offers to unsubscribe** (WHO-06, UNS-02, UNS-11): the summary
  says one click, a link, an email address or none (LinkedIn offers a link:
  the live "No" was right, but said too little). The refusal says the same,
  and your own email is simply "nothing to unsubscribe from".
- **More scam warnings** (SCM-07): insurers, banks, lenders, credit bureaus,
  phone companies, shops and government services, found live with "Liberty
  Mutual Team" sent from an unrelated domain; the sender summary shows
  "replies go elsewhere" too (WHO-07).
- **Forwards join the original's conversation** (FWD-07).
- **Undo does only what changed** (ACT-10, ACT-11); **at most 20 emails wait
  to be read** (PAR-09); **the reader's memory limit counts only its own
  memory** (ATT-12): the security review's remaining small items.
- **Tidying:** the v1 files moved to `docs/v1/`; a deprecated way of starting a
  process in the test kit replaced; unit tests get 20 seconds; the live-test
  prompts rewritten for Yahoo's delivery delay.
- **Proposed, not built:** confirming a new recipient on your page
  ([docs/DESIGN-CONFIRM-ON-PAGE.md](docs/DESIGN-CONFIRM-ON-PAGE.md)).

## 2.4.1 (2026-09-30): sending files and cleaning up

- **Send attachments** (OUT-01..07): send, reply and drafts can carry
  attachments already in your mail (copied as they are, up to 18 MB) and small
  text files your AI writes (.txt, .csv, .md, .json, .ics and a few more).
  Editing a draft keeps its attachments (it used to refuse). A first message to
  someone new with attachments names the files when it asks you.
- **Forward** (FWD-01..06): a new Send tool, `forward_email`: your note, the
  original's details and text, and its attachments.
- **Junk** (JNK-01..04): `junk_email` moves mail to the folder your provider marks
  as spam, which teaches its filter; undo from your page.
- **Unsubscribe** (UNS-01..10): `unsubscribe` uses the one-click standard that
  large senders offer. Never for an email that looks like a scam; the request is
  made only to a safe, public https address.
- **Who fills my inbox** (WHO-01..05): `summarize_senders` counts the newest
  messages in a folder by sender, with unread counts and whether one-click
  unsubscribe is offered.
- **Recent activity** lists forwards, junk and unsubscribes, and counts
  attachments on sends (ACT-09).
- **Releases** take their security mark only from the tag's own message
  (REL-09): 2.4.0 was marked a security release by mistake.
- 21 tools in all. The security review of these changes is in
  [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).

## 2.4.0 (2026-09-30): serving people

Built around the principles now in the design (DESIGN-V2 §1): the owner stays
in charge, mistakes can be undone, and the AI is told what a careful person
would notice.

- **Reading attachments** (ATT-01..11): a new read tool, `get_attachment`.
  Text, CSV, HTML, PDF and Word files come back as text; pictures up to 3 MB as
  images the AI can look at; other kinds are described. Read in the parsing
  sandbox with time, memory and structure limits; the email stays unread.
- **Scam warnings** (SCM-01..06): search results and opened emails carry
  `cautions` when a name claims a well-known company from someone else's
  address, shows an address that isn't the sender's, or the domain is a
  look-alike or disguised, or replies would go elsewhere. Quiet on ordinary mail.
- **Someone new** (RCP-01..05): a send or reply to someone the account has
  never written to is held until you confirm (`MAIL-NEW-RECIPIENT`).
- **Send limits** (LIM-01..04): 30 an hour and 200 a day per account by
  default, changed on your page (`MAIL-SEND-LIMIT`).
- **Recent activity with undo** (ACT-01..08): your page lists what each app
  changed in the last 30 days, never the mail itself; put back a move, archive
  or trash, or undo a mark or flag. Saved with your settings, and when Cloud Run
  stops the server.
- **Accessibility** (A11Y-01): every page passes axe's automated rules; each
  has a main landmark, and the report box a label.
- **Safer defaults**: the shared-secret test mode is never a default (SIG-86);
  CI and `npm run test:all` stop on a known high-severity dependency problem
  (REL-08); `ip-address` 10.7.2.
- **A security review** of all of the above, with nine fixes, each tested
  first: [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).
- **No provider's name in the engine** (ENG-28): `src/mail/`, and the settings
  `MAIL_ADDRESS` and `MAIL_APP_PASSWORD` (the old `YAHOO_` names still work).
  Installations are unaffected.
- **Proposed for 2.5**, not built: signing in with Microsoft and Google, so
  Outlook.com and Microsoft 365 can be added
  ([docs/DESIGN-PROVIDER-SIGNIN.md](docs/DESIGN-PROVIDER-SIGNIN.md)).

## 2.3.1 (2026-09-29): a clean test suite

- v1's Auth0 sign-in modes are gone from the code; a setting naming one now
  stops the start instead of running some other way (SIG-85). Installations
  are unaffected: they always use the built-in sign-in.
- v1's deployment scripts, smoke tests and verify runner are gone (about 25
  files), with the 74 tests that only checked them.
- `npm run test:all` runs everything automated in one command.
- The coverage floors rose to what the suite reaches (93/83/94/96).
- The direct mode's health answer names the product and its real version.
- TESTING.md says what is proven where: automated, live, or not yet.

## 2.3.0 (2026-09-29): 1.0

The first release to call finished for everyday use: every tool tested live on
Yahoo with Claude and with ChatGPT, and Gmail connected live.

- **Rename an account** on your page (PG-19): what your AI calls it. Its
  password, settings and every app's permissions carry over; apps use the new
  name at once, without reconnecting.
- **App passwords with spaces** (as Gmail shows them) work, on the page and in
  setup (PG-03, SET-84).
- **Clearer "no such account"**: says the account isn't available *to this app*
  and how to give it permission, instead of suggesting it doesn't exist (SIG-30).
- **Display names**: a "name" that is only the address again (Yahoo) is left
  out, so search and get_email agree (POL-15).
- **Documentation**: a user guide, a tool reference, an operations runbook, an
  architecture map and a testing guide for v2; the v1 documents moved to
  `docs/v1/`; a Gmail live-test prompt.

## 2.2.6 (2026-09-29): tuned from measurements
- A folder opened for changes serves the reads that follow, with nothing marked
  read (ENG-27): a re-find after a change went from 1.5 s to 0.6 s on Yahoo.
- The kept connection is checked after two minutes idle, not 30 s (ENG-26).
- Send and reply answers include `sentAt`, the server's time (POL-14).

## 2.2.5 (2026-09-29): ChatGPT
- ChatGPT signs in as it really is: its published document, and optionally a
  signed assertion verified against its own keys (SIG-83, SIG-84). Passed live.
- Your page shows today's steps for connecting ChatGPT (PG-18).

## 2.2.4 (2026-09-29): measure first
- Each tool's log line says where its time went, by step (DIA-13).
- The live test prompt waits less and cleans up reliably.

## 2.2.3 (2026-09-28): the slow tools
- get_thread and the Message-ID fallback read the newest messages by position
  (ENG-22); create_folder checks before creating (ENG-23); a Yahoo send doesn't
  look for its late Sent copy, and a reply reads only the headers it needs
  (ENG-24); mail that arrives while a folder is open is found (ENG-25).
- A subject search returns only real matches (POL-13).

## 2.2.2 (2026-09-28): fixes from the first full live run
- Batch moves report each message's own new UID, checked by Message-ID (ENG-20).
- Re-finding by Message-ID works where Yahoo's header search misses (ENG-21).
- `since`/`before` honour the time of day (POL-12); HTML-only mail has text (PAR-08).

## 2.2.1 (2026-09-28)
- A search page is full even when hidden sign-in-code emails are the newest (SIG-82).

## 2.2.0 (2026-09-28): one kept connection
- One mail connection per account, reused (ENG-18): the ~3.3 s login per call is gone.
- Nothing sent says "Yahoo MCP" any more (ENG-19).

## 2.1.1 (2026-09-28)
- One log line per tool call, with its time and outcome (DIA-12).

## 2.1.0 (2026-09-28): the subscription
- Trial, grace, read-only after a lapse; licenses; the license service (design §13).
  Switched off until a license service is configured.

## 2.0.1 - 2.0.4 (2026-09-27): the first live install
- Setup's questions stay visible in a real terminal; Ctrl+C stops plainly.
- Budgets billed to the right project; the check reaches the server; step 8
  waits long enough; the report includes the server's log; a rerun installs
  the new image.

## 2.0.0 (2026-09-27)
- The first release: any common provider, many accounts, a private server set
  up by one command, Claude connected through the built-in sign-in server.
