# Universal Mail: user guide

Universal Mail connects your email accounts (Yahoo, Gmail, iCloud, Fastmail and
other IMAP providers) to your AI apps (Claude and ChatGPT), through a private
server that runs in your own Google Cloud account. Your AI can then search,
read, organize and, when you allow it, send your email.

This guide covers everything you do yourself. For how it works, see
[DESIGN-V2.md](DESIGN-V2.md); for running and releasing it, see
[OPERATIONS.md](OPERATIONS.md).

---

## 1. What you need

- **A Google account** with **a card on file for Google Cloud** (Google asks for
  one even for free use). Universal Mail is designed to stay in the free tier,
  and setup adds a $1 cost alarm.
- **An app password for each email account.** It's a separate password, made
  in your provider's security settings, that lets one app read your mail
  without your real password. Setup and your page show where to make it:

  | Provider | Where | Button | Needs first |
  |---|---|---|---|
  | Yahoo | https://login.yahoo.com/account/security | Generate app password | |
  | AOL | https://login.aol.com/account/security | Generate app password | |
  | Gmail | https://myaccount.google.com/apppasswords | Create | 2-Step Verification |
  | iCloud | https://account.apple.com/account/manage | App-Specific Passwords | two-factor authentication |
  | Fastmail | https://app.fastmail.com/settings/security | New app password | |
  | Zoho | https://accounts.zoho.com/home#security/app_password | Generate New Password | two-factor authentication, IMAP turned on in Zoho Mail |

  Paste it as your provider shows it: spaces (Gmail shows `abcd efgh ijkl mnop`)
  are ignored. Never paste an app password into a chat with your AI.
- **Claude** (any plan with custom connectors) and/or **ChatGPT** (Plus or
  higher, on the web).

Outlook.com and Microsoft 365 don't allow app passwords, so they aren't
supported yet.

---

## 2. Install

1. Open **Google Cloud Shell** from the install link in the
   [README](../README.md) (it opens Cloud Shell with the current release).
2. Type `node setup.js` and press Enter. It asks a few questions (your email
   addresses, each app password, a short name for each account, which address
   gets sign-in codes) and explains each one as it goes. Answers you type for a
   password are hidden.
3. When it finishes it shows two addresses. **Keep both private**:
   - **Your Universal Mail page**: bookmark it. You manage everything there.
   - **Your AI-app address** (ends in `/mcp`): you paste it into Claude and
     ChatGPT.

If setup stops, it says why and what to do. `node setup.js report` prints a
block you can paste into your AI for help; it contains no mail and no secrets.

---

## 3. Connect your AI apps

Each app is approved once, on your page, with your fingerprint or an emailed
code. Then you choose what it may do with each account.

### Claude

1. Claude → **Settings → Connectors → Add custom connector**.
2. Name it `Universal Mail` and paste your AI-app address. Add.
3. Claude opens your approval page: approve it.

### ChatGPT (Plus or higher, on the website)

1. chatgpt.com → **Settings → Security and login** → turn on **Developer mode**
   (on some versions it's under **Apps → Advanced settings**).
2. **Settings → Plugins** (or **Apps**) → **Add / Create** → a new app. Name it
   `Universal Mail`, paste your AI-app address, choose **OAuth**, leave any
   client ID or secret empty, tick "I understand", **Create**.
3. ChatGPT opens your approval page: approve it.
4. Optional: set Universal Mail to **Allow low-risk tools**, so searching and
   reading run without asking. ChatGPT always asks before a change (sending,
   moving, trashing); you can approve a tool once for a whole chat.

The ChatGPT desktop app's own "MCP" settings are for its coding agent and won't
work for this: add the app on the website.

### Give each app its permissions

Your page → **Connected apps** → the app → **Permissions**. For each account,
tick what the app may do, then **Save permissions** (it asks for your
fingerprint):

| Permission | Lets the app |
|---|---|
| **Read** | list folders, search, open messages, threads and attachments, see who sends the most |
| **Organize** | mark read/unread, flag (star), move, archive, trash, restore, mark as junk, unsubscribe from newsletters, create folders and drafts |
| **Send** | send, reply and forward |

An app sees only the accounts you ticked for it. **Ticking isn't enough: click
Save permissions.** After adding an account, give each app permission for it
here.

---

## 4. Everyday use

Talk to your AI normally. Some examples:

- *"Find the Marriott timeshare email."* (searches every account you allowed)
- *"Show the unread mail in my gmail Inbox from this week."*
- *"Star the emails from my accountant for review."* (a flag in Yahoo, a star in Gmail)
- *"Show everything I've flagged."*
- *"Archive every LinkedIn job alert in yahoo from this week."*
- *"What does the PDF my landlord sent say?"* (reads attachments: text, PDF, Word, pictures)
- *"Find the email with the insurance PDF."* (search knows attachment names)
- *"Forward the invoice from Sam to my accountant."* (the attachments go with it)
- *"Send Pat last month's statement PDF, and a CSV of the totals."* (a file from your mail, and one your AI writes)
- *"Who fills my inbox? Unsubscribe me from the newsletters I never open, and mark the rest of that junk as spam."*
- *"Draft a reply to Sam saying Thursday works."* (a draft; nothing is sent)
- *"Send it."* (only if the app has **Send** for that account)

Good to know:

- **Email content is treated as untrusted.** The AI is told never to follow
  instructions found inside an email.
- **Scam warnings.** When an email shows signs of a scam (a name claiming a
  well-known company from an address that isn't theirs, a look-alike domain
  such as `paypa1.com`, replies that would go somewhere else), your AI is told
  and should tell you before you reply, click or pay. Ordinary mail carries none.
- **Someone new.** Before your AI sends or replies to someone this account has
  never written to, it stops and asks you to confirm the address. That catches a
  mistyped address and a scammer's first "reply to this".
- **Unsubscribing** uses the standard one-click way that large senders offer.
  It's never used for an email that looks like a scam (that would only confirm
  your address is read); your AI suggests marking those as junk instead. Some
  senders (LinkedIn's job alerts, for one) offer only a link: your AI says so,
  and you use it from your mail app. Universal Mail doesn't open links for you.
- **Undo does only what's needed.** Undoing "mark read" puts back only the
  messages that were unread before.
- **Send limits.** Each account sends at most 30 emails an hour and 200 a day,
  so a confused AI can't flood anyone. Change them on your page.
- **Nothing is deleted permanently.** "Delete" means Trash, and anything in
  Trash can be restored until your provider empties it.
- **Your own Sent copy can take a minute.** Some providers (Yahoo, Gmail) file
  it themselves; the answer says so. Don't send twice.
- **Gmail's folders are labels.** One message can be in several at once, and
  archiving takes it out of the Inbox into All Mail.
- **Some provider quirks are normal**: Yahoo adds a `References` header ending
  in `.ref` to mail it stores; new mail can take a minute to become searchable.

---

## 5. Your Universal Mail page

Sign in with your fingerprint or an emailed code. Sessions end after 15 minutes
idle, and every change is emailed to you.

| Section | What you can do |
|---|---|
| **Your accounts** | see each account's status and when it was last used; **Fix it** or change its app password; turn **sending** on or off; **Rename** it (what your AI calls it; its password and every app's permissions carry over); **Remove** it (type its name to confirm); **Add an email account** |
| **Your accounts: Sending limits** | how many emails an hour and a day this account may send (30 and 200 to start) |
| **Connected apps** | see each app and when it last used your mail; change its **Permissions**; **Disconnect** it; step-by-step **Connect an AI app** |
| **Recent activity** | what each app did in the last 30 days: moves, archives, trash, junk, marks, flags, drafts, folders, unsubscribes, sends and forwards (with how many attachments) (who did it, which account, how many; never the mail itself). **Put back** a move, archive or trash; undo a mark or a flag. A send can't be undone; one to someone new says so. |
| **Health** | **Check that everything works**: runs the server's checks and shows a report you can paste into your AI (no mail, no secrets) |
| **Sign-in** | set up your fingerprint |
| **Subscription** | where your trial or plan stands; enter a license code |

Adding an account runs the same checks as setup, including sending one test
email from the account to itself (to learn whether the provider files its own
Sent copy). You can delete that email.

---

## 6. Updating

When a new version is out you get an email. To install it:

1. Open Cloud Shell and run `cd ~/universal-mail && git pull` (it's done when it
   lists changed files, or says "Already up to date").
2. Run `node setup.js`, type **2 (Update)** and press Enter. It installs the new
   version, tests it, and puts the old one back if the test fails.

`node setup.js` also offers **1 Check and fix**, **3 Show my address** and
**4 Remove**.

---

## 7. When something goes wrong

| What you see | What to do |
|---|---|
| The AI says an account is **not available to this app** | Your page → Connected apps → that app → Permissions: tick the account, **Save permissions**. Check the account's name (Your accounts): it's the name your AI must use. |
| The AI says it **isn't allowed** to organize or send | Same place: tick **Organize** or **Send** for that account, and save. |
| **Sending is off** for an account | Your accounts → **Turn sending on**. |
| The AI says an account **reached its sending limit** | Wait, or your page → Your accounts → **Sending limits** to raise it. |
| The AI asks you to **confirm a recipient** | Normal for someone this account has never written to. Check the address is really who you mean, then say yes. |
| The AI says a sender **doesn't offer one-click unsubscribe** | Open the email in your mail app and use its unsubscribe link, or ask your AI to mark it as junk. |
| An app **did something you didn't want** | Your page → **Recent activity** → **Put back** (or undo the mark or flag). |
| **Password not accepted** on your page | Make a new app password at your provider; your page → **Fix it**. |
| The AI can't connect at all | Your page → **Check that everything works**. If the page won't load: Cloud Shell → `node setup.js` → **1 Check and fix**. |
| Anything else | Your page → **Check that everything works** → paste the report into your AI, or run `node setup.js report` in Cloud Shell. |

---

## 8. Known limits

- Attachments can be read (text, CSV, HTML, PDF, Word and pictures up to 3 MB);
  other kinds (spreadsheets, zip files, older .doc files) are described, not
  opened. Any attachment already in your mail can be sent or forwarded, up to
  18 MB per email. Your AI can write only small text files to attach (.txt,
  .csv, .md, .json, .ics, .xml); it can't attach files from your computer or
  from the chat.
- Unsubscribing works only where the sender offers one click; otherwise use the
  link in your mail app.
- A sent email can't be taken back: the activity log lists it but can't undo it.
- Folders can be created but not renamed or deleted (do that in your mail app).
- Nothing is ever permanently deleted by Universal Mail.
- Threads are found in your Inbox, Sent, Archive and the message's own folder
  (ask for "all folders" for a slower, complete search). On providers whose
  header search is unreliable (Yahoo), only the 200 newest messages per folder
  are checked for replies that aren't searchable yet.
- Outlook.com and Microsoft 365 aren't supported yet.
- Tested live: every tool on Yahoo, with Claude and with ChatGPT; Gmail
  connected and working. Other providers are tested against simulated mail
  servers in their layouts.

---

## 9. Removing Universal Mail

Cloud Shell → `node setup.js` → **4 Remove**. It deletes the Google Cloud
project and everything in it (Google finishes within 30 days, at no charge).
Then remove the connector in Claude and the app in ChatGPT, and revoke the app
passwords at your providers. Your email itself is never touched.
