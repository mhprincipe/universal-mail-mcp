# The live test

The final check of a release, on your real mail with real AI apps: one
prompt in Claude that tests everything on every account, a short list you
check yourself on your page, and a short prompt in ChatGPT. About 45 minutes
in all. What can't safely be done to real mail (broken connections,
booby-trapped attachments, two apps at once) is tested automatically on every
change; see [TESTING.md](TESTING.md).

## What it does, and doesn't

- It **makes its own test mail** in each account: one email to the account's
  own address with a small file attached, a draft, a reply and a forward.
  Every subject starts with "UM test", a four-letter code and the account's
  name, so it can't touch anything else. It cleans up each account as soon as
  that account is done.
- It **only reads** your other mail: listing, searching, opening, summarizing
  who sends to you, and one attachment if you have any.
- It **sends only to each account's own address**. Three sends must be refused
  unsent: one to an address that can't exist (`nobody@example.invalid`), one
  with a file kind that isn't allowed, and one over the send limit.
- It **marks only its own test email as junk, then brings it straight back**
  (moving it out of Junk tells your provider it isn't spam).
- It **asks you to change one setting and change it back**: Yahoo's sending
  limit, to 1 an hour for a minute, to see a send refused. Gmail's is never
  touched.
- It **leaves behind** a folder (a label in Gmail) called **UM test** in each
  account (no tool deletes folders). If it's already there from an earlier run,
  that's fine.
- **Not tested, on purpose:** actually confirming a new recipient (it never
  sends to a stranger).

## Before you start

1. Your installation is up to date: Cloud Shell, `cd ~/universal-mail && git pull`,
   then `node setup.js`, **2 (Update)**.
2. In a new Claude chat, ask: *"List the Universal Mail tools you have."* It
   should list **21**. (Only if it lists fewer: refresh the connector, USER-GUIDE
   §6. Updates that don't add tools don't need it.)
3. On your Universal Mail page, Claude has **Read**, **Organize** and **Send**
   for **every** account, saved; and sending is on for each.
4. When Claude first asks to use a Universal Mail tool, choose to allow it
   **always for this chat**, so its prompts don't stop the run.
5. Keep your Universal Mail page open in another tab for part 4.

## 1. The Claude prompt

```text
Run a complete test of the Universal Mail connector, on every email account it can reach. Use only the Universal Mail tools.

Rules for the whole test:
- Make up a random four-letter code now, say ABCD. Start every subject you write with "UM test ABCD" and the account's name, so this test's mail can't be confused with anything else.
- Send only to each account's own address (step 3 finds it). Where a step says a send must be refused, check that it was. Never confirm a new recipient.
- Change only the mail this test creates. Never unsubscribe from a real sender and never mark real mail as junk.
- Use the folders list_folders marks as Inbox, Sent, Drafts, Trash, Junk and Archive (Gmail: All Mail), whatever their names.
- Mail sent to yourself can take a few minutes to arrive (Yahoo especially). Never search for the same thing more than 8 times. If it hasn't arrived, say so and go on with what doesn't need it.
- If a step fails, say so and go on. Retry nothing more than once.
- If you run out of tool calls in a reply, finish the step you're on, tell me exactly where you stopped (part, account, step, the code), and when I say "continue", pick up from there with the same code.

Keep one table as you go: account, step, tools used, worked (yes/no), what you saw, anything odd.

PART 1: THE ACCOUNTS
1. list_folders with no account. With more than one account it must refuse with MAIL-ACCOUNT-REQUIRED and name them (with their providers): those are the accounts to test. With one account it simply answers, and that is the only account.
2. list_folders with account "no-such-account". It must refuse with MAIL-ACCOUNT-UNKNOWN and name the accounts you can use.
3. For each account: list_folders and note its marked folders. Then search its Sent folder with limit 1: the From address of the newest message is the account's own address.
4. For each account, send its test mail now, so it arrives while you work: send_email to the account's own address, subject "UM test ABCD <account> mail", a two-line body, and a file you write: files [{ filename: "totals.csv", text: "item,amount\ncoffee,4.50\ntea,3.00\n" }]. Note the messageId, sentAt and the attachments the answer lists.
5. If there is more than one account: search_email with no account for the word "invoice", limit 5. Each result must say which account it came from, and the answer must say which accounts were searched.

PART 2: EACH ACCOUNT IN TURN (steps 6 to 21 for one account, then all of them again for the next)

Reading: nothing changes
6. search_email the Inbox with limit 5. Then limit 2, and page once with the cursor: no message twice.
7. get_email the newest Inbox message with format text, then format full. Then get_thread on it (on Gmail, the answer says its messages come from All Mail).
8. summarize_senders on the Inbox. Show the top 5: messages, unread, how each offers to unsubscribe (one-click, link, email or none), and any cautions. Across all senders, say how many offer one-click, link, email and none: on a mailbox with newsletters, "none" for every sender would be wrong.
9. search_email the Inbox for its 50 newest. List each one with cautions, the caution in full, and say whether it looks right. Also say if you see a sender whose name claims a well-known company from an address that isn't that company's and has no caution.
10. search_email the Inbox with hasAttachments true, limit 3 (the answer notes that pictures shown in an email's text don't count). If any besides the test mail, get_attachment one of its attachments and say what kind it is (and for text, what it's about in one sentence); then re-find that message by messageId: its read state must be unchanged. If none, say so.

Refusals: nothing may happen
11. send_email to nobody@example.invalid, subject "UM test ABCD <account> held", one line. It must be held with MAIL-NEW-RECIPIENT and nothing sent. Quote the answer's message. Don't confirm or retry.
12. send_email to the account's own address, subject "UM test ABCD <account> refused", with files [{ filename: "run.exe", text: "x" }]. It must be refused with MAIL-FILE-NOT-ALLOWED and nothing sent.

Folders and drafts
13. create_folder "UM test", then again: the second answer must say created false (the first may too, if the folder is there from an earlier run).
14. create_draft to the account's own address, subject "UM test ABCD <account> draft", one line, files [{ filename: "notes.md", text: "# Notes\nfirst" }]. Find it in Drafts by subject. update_draft it with a new body and another file: files [{ filename: "more.txt", text: "second file" }]. get_email the updated draft (its new uid): the new body, and both notes.md and more.txt attached.

The test mail
15. Find "UM test ABCD <account> mail" in the Inbox: search by subject, up to 8 times, and say how many it took. Its result must list attachmentNames ["totals.csv"], and a search with attachmentName "totals" must find it too. get_attachment index 0: text, the CSV above. get_attachment index 5: it must be ATTACHMENT_NOT_FOUND.
16. mark_read it, then mark_read again (the second answer's changed list must be empty), then mark_unread. flag_email flagged true, then false. Re-find it by messageId at the end and report read and flagged.
17. move_email it to "No Such Folder": it must refuse with FOLDER_NOT_FOUND and nothing move. Then move_email it to "UM test", archive_email it, junk_email it (say which folder it went to), restore_email it to the Inbox, trash_email it, and restore_email it to the Inbox. Re-find it by messageId after each: its uid usually changes (on Gmail, All Mail keeps its own).
18. unsubscribe on it. It must refuse with MAIL-UNSUBSCRIBE-OWN (the email is from this account itself) and change nothing.
19. reply_email to it with one line, and attachments: [{ mailbox, uid, index: 0 }] of the test mail, which sends totals.csv back: the answer must list totals.csv. Then forward_email it to the account's own address with the note "Forward test": the answer must list totals.csv.
20. Search the Inbox for "UM test ABCD <account>" (up to 8 times) until the reply and the forward have arrived, or you run out. get_thread on the test mail: the reply should be in it if it arrived. Mark every "UM test ABCD <account>" message you found read in one call (uids), then unread in one call.
21. Clean up this account now: trash_email every "UM test ABCD" message in its Inbox in one call, the ones in Sent in one call, and the draft. Search the Inbox once more and trash anything that arrived late. Leave the "UM test" folder. Then go on to the next account.

PART 3: THE SEND LIMIT (only if there is an account named yahoo; otherwise the first account)
22. Tell me: "Please set yahoo's sending limit to 1 an hour on your Universal Mail page (Your accounts, yahoo, Sending limits), then say done." Wait until I say done.
23. send_email to yahoo's own address, subject "UM test ABCD yahoo limit", one line. It must be refused with MAIL-SEND-LIMIT and nothing sent, because this test already sent from yahoo in the last hour. Quote the answer's message.
24. Tell me: "Please set yahoo's sending limit back to 30 an hour and 200 a day, then say done." Wait until I say done.

PART 4: THE REPORT
25. Show the table.
26. Then, for each account, a checklist of PASS or FAIL, one line each, and a count at the end ("N of M passed"):
- refusals: no account named; an unknown account; the held send; run.exe; the missing folder; the missing attachment; unsubscribing from your own mail; the send limit (yahoo)
- reading: paging without repeats; get_email text and full; get_thread; summarize_senders with a sensible spread of one-click, link, email and none; cautions that look right; nothing obviously missed
- attachments: the test mail's attachmentNames; the attachmentName search; reading the CSV; a real attachment read without marking it read (or none to read)
- changes: folder; draft and its update with both files; mark read twice (the second changed nothing); flag; the moves, junk and back, trash and back; reply and forward with the file; the thread with the reply
- clean-up: nothing of this test left but the UM test folder
27. Then a short list of anything slow, wrong or confusing, and one line comparing the accounts. Then tell me to check my Universal Mail page and run the ChatGPT check.
```

## 2. Your checks on your page

On your Universal Mail page:

1. **Recent activity**, for each account, lists: the test send (1 attachment),
   the draft and its update, the first mark read and the mark unread, the flag
   and unflag, the moves (to UM test, Archive, Junk and back, Trash and back),
   the reply and the forward (1 attachment each), the batch marks, and the
   trash. **Not** listed: the held, refused and over-limit sends, the refused
   move, the refused unsubscribe, and the second mark read (they changed
   nothing).
2. **Undo:** press **Put back** on one of the last trash entries. The test email
   comes back to the Inbox. Delete it in your mail app afterwards.
3. **Your accounts:** yahoo's sending limit is back to 30 an hour and 200 a
   day.
4. **Health → Check that everything works:** every check passes.
5. **Your email:** you received the "Universal Mail has new tools for your AI
   apps" email after updating to 2.4.3 (once), and the "is available" emails
   for the updates.

## 3. The ChatGPT check

In a new ChatGPT chat with Universal Mail on (approve each tool it asks for):

```text
Using only the Universal Mail tools, check these and keep a table (step, tool, worked yes/no, what you saw):
1. List the Universal Mail tools you have, and how many.
2. list_folders with no account: it should refuse with MAIL-ACCOUNT-REQUIRED and name my accounts.
3. search_email the Inbox of each account with limit 3.
4. get_email the newest Inbox message of the first account, without marking it read.
5. If you have summarize_senders, run it on the first account's Inbox and show the top 3.
6. send_email from the first account to nobody@example.invalid, subject "UM test ChatGPT held", one line. It must be held with MAIL-NEW-RECIPIENT and nothing sent. Don't confirm or retry.
7. Show the table.
```

If ChatGPT lists fewer than 21 tools, it still has the list from when you
connected it: it works with those, and refreshing it (USER-GUIDE §6) is only
needed for it to use the newer ones. Claude's run covers every tool.

## Provider differences you'll see

| | Yahoo | Gmail |
|---|---|---|
| Delivery to yourself | 1 to 3 minutes | seconds |
| Sent copy | filed by Yahoo a minute or so later | at once |
| Junk folder | Bulk | [Gmail]/Spam |
| Archive | Archive | [Gmail]/All Mail (a message can show in several folders) |
| Text search | matches the words asked | the exact phrase (Gmail's own search, since 2.4.3) |
| Extra headers | a `References … .ref` header on stored mail | none |

## If something looks slow or wrong

The timings, one line per tool call, from the server's log (Cloud Shell;
replace `<your-project-id>` with your installation's project, the one
`node setup.js` shows). Each line ends with where the time went:
`imap.connect` is a login, `imap.search`, `imap.fetchOne` and the rest are mail
server commands, `smtp.send` is handing a message to the provider, `parse` is
reading one; each with its total milliseconds (`ms`) and how many times (`n`).

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="universal-mail" AND jsonPayload.event="tool"' --project=<your-project-id> --freshness=3h --limit=300 --format='value(timestamp,jsonPayload.name,jsonPayload.ms,jsonPayload.ok,jsonPayload.code,jsonPayload.phases)'
```

Anything the server turned away (for instance Claude's "Temporarily unable to
authenticate"), one line per request:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="universal-mail" AND httpRequest.status>=400' --project=<your-project-id> --freshness=1d --limit=50 --format='value(timestamp,httpRequest.requestMethod,httpRequest.status,httpRequest.latency,httpRequest.requestUrl)'
```
