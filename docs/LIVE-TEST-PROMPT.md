# The live test

One prompt that tests everything, on every email account your AI app can
reach: all 21 tools, the checks that must refuse, and each provider's ways.
Paste it as it is: it finds your accounts and their addresses itself. Run it
after each update.

## What it does, and doesn't

- It **makes its own test mail** in each account: one email to the account's
  own address with a small file attached, a draft, a reply and a forward.
  Every subject starts with "UM test", a four-letter code and the account's
  name, so it can't touch anything else.
- It **only reads** your other mail: listing, searching, opening, summarizing
  who sends to you, and one attachment if you have any.
- It **sends only to each account's own address**. Two sends must be refused
  unsent: one to an address that can't exist (`nobody@example.invalid`), one
  with a file kind that isn't allowed.
- It **marks only its own test email as junk, then brings it straight back**
  (moving it out of Junk tells your provider it isn't spam).
- It **leaves behind** a folder (a label in Gmail) called **UM test** in each
  account: no tool deletes folders, so remove them in your mail app.
  Everything else it made ends up in Trash.
- It takes 10 to 20 minutes: mail you send yourself can take a few minutes to
  arrive (Yahoo especially), so it sends first and looks later.
- **Not tested here, on purpose:** the send limits (30 an hour would need 30
  sends), confirming a new recipient (it never confirms one), and your page
  (you check Recent activity at the end).

## Before you start

1. Your installation is up to date: Cloud Shell, `cd ~/universal-mail && git pull`,
   then `node setup.js`, **2 (Update)**.
2. On your Universal Mail page, the app (Claude or ChatGPT) has **Read**,
   **Organize** and **Send** for **every** account, saved; and sending is on for
   each.
3. Your AI app sees all 21 tools: ask a new chat "List the Universal Mail tools
   you have". Fewer? Refresh the connector (USER-GUIDE §6); apps keep the list
   they saw when they were connected.
4. One app at a time, in a new chat.

## The prompt

```text
Run a complete test of the Universal Mail connector, on every email account it can reach. Use only the Universal Mail tools.

Rules for the whole test:
- Make up a random four-letter code now, say ABCD. Start every subject you write with "UM test ABCD" and the account's name, so this test's mail can't be confused with anything else.
- Send only to each account's own address (step 3 finds it). Where a step says a send must be refused, check that it was. Never confirm a new recipient.
- Change only the mail this test creates. Never unsubscribe from a real sender and never mark real mail as junk.
- Use the folders list_folders marks as Inbox, Sent, Drafts, Trash, Junk and Archive (Gmail: All Mail), whatever their names.
- Mail sent to yourself can take a few minutes to arrive. Never search for the same thing more than 8 times. If it hasn't arrived, say so and go on with what doesn't need it.
- If a step fails, say so and go on. Retry nothing more than once.

Keep one table as you go: account, step, tools used, worked (yes/no), what you saw, anything odd.

PART 1: THE ACCOUNTS
1. list_folders with no account. With more than one account it must refuse with MAIL-ACCOUNT-REQUIRED and name them: those are the accounts to test. With one account it simply answers, and that is the only account.
2. list_folders with account "no-such-account". It must refuse with MAIL-ACCOUNT-UNKNOWN and name the accounts you can use.
3. For each account: list_folders and note its marked folders. Then search its Sent folder with limit 1: the From address of the newest message is the account's own address.
4. For each account, send its test mail now, so it arrives while you work: send_email to the account's own address, subject "UM test ABCD <account> mail", a two-line body, and a file you write: files [{ filename: "totals.csv", text: "item,amount\ncoffee,4.50\ntea,3.00\n" }]. Note the messageId, sentAt and the attachments the answer lists.
5. If there is more than one account: search_email with no account for the word "invoice", limit 5. Each result must say which account it came from.

PART 2: EACH ACCOUNT IN TURN (steps 6 to 20 for one account, then all of them again for the next)

Reading: nothing changes
6. search_email the Inbox with limit 5. Then limit 2, and page once with the cursor: no message twice.
7. get_email the newest Inbox message with format text, then format full. Then get_thread on it.
8. summarize_senders on the Inbox. Show the top 5: messages, unread, how each offers to unsubscribe (one-click, link, email or none), and any cautions.
9. search_email the Inbox for its 50 newest. List each one with cautions, the caution in full, and say whether it looks right.
10. search_email the Inbox with hasAttachments true, limit 3. If any, get_attachment the first one's first attachment and say what kind it is (and for text, what it's about in one sentence); then re-find that message by messageId: its read state must be unchanged. If none, say so.

Refusals: nothing may happen
11. send_email to nobody@example.invalid, subject "UM test ABCD <account> held", one line. It must be held with MAIL-NEW-RECIPIENT and nothing sent. Quote the answer's message. Don't confirm or retry.
12. send_email to the account's own address, subject "UM test ABCD <account> refused", with files [{ filename: "run.exe", text: "x" }]. It must be refused with MAIL-FILE-NOT-ALLOWED and nothing sent.

Folders and drafts
13. create_folder "UM test", then again: the second answer must say created false.
14. create_draft to the account's own address, subject "UM test ABCD <account> draft", one line, files [{ filename: "notes.md", text: "# Notes\nfirst" }]. Find it in Drafts by subject. update_draft it with a new body and another file: files [{ filename: "more.txt", text: "second file" }]. get_email the updated draft (its new uid): the new body, and both notes.md and more.txt attached.

The test mail
15. Find "UM test ABCD <account> mail" in the Inbox: search by subject, up to 8 times, and say how many it took. Its result must list attachmentNames ["totals.csv"], and a search with attachmentName "totals" must find it too. get_attachment index 0: text, the CSV above. get_attachment index 5: it must be ATTACHMENT_NOT_FOUND.
16. mark_read it, then mark_read again (the second answer's changed list must be empty), then mark_unread. flag_email flagged true, then false. After each, re-find it by messageId and report read and flagged.
17. move_email it to "No Such Folder": it must refuse with FOLDER_NOT_FOUND and nothing move. Then move_email it to "UM test", archive_email it, junk_email it (say which folder it went to), restore_email it to the Inbox, trash_email it, and restore_email it to the Inbox. Re-find it by messageId after each: its uid changes every time.
18. unsubscribe on it. It must refuse, because the email is from this account itself, and change nothing.
19. reply_email to it with one line, and attachments: [{ mailbox, uid, index: 0 }] of the test mail, which sends totals.csv back: the answer must list totals.csv. Then forward_email it to the account's own address with the note "Forward test": the answer must list totals.csv.
20. Search the Inbox for "UM test ABCD <account>" (up to 8 times) until the reply and the forward have arrived, or you run out. get_thread on the test mail: the reply should be in it if it arrived. Mark every "UM test ABCD <account>" message you found read in one call (uids), then unread in one call.

PART 3: CLEAN UP AND REPORT
21. For each account: trash_email every "UM test ABCD" message in the Inbox in one call, the ones in Sent in one call, and the draft. Search the Inbox once more for "UM test ABCD" and trash anything that arrived late. Leave the "UM test" folders.
22. Show the table. Then, for each account, a short list of anything slow, wrong or confusing, and one line comparing the accounts. Then tell me to open my Universal Mail page and check Recent activity.
```

## Afterwards, on your page

**Recent activity** should list, for each account: the first send (1
attachment), the draft and its update, the marks and flags, the moves (to UM
test, Archive, Junk and back, Trash and back), the reply and the forward (1
attachment each), and the trash. Not listed: the held and refused sends, the
refused move and the refused unsubscribe (nothing happened), and the second
"mark read" (it changed nothing).

To try **undo**, press **Put back** on one of the last trash entries: that
test email comes back to the Inbox. Delete it in your mail app afterwards.

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
