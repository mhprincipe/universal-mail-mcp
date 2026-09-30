# The live test

One prompt that uses all 21 tools on one account, with a real AI app and your
real mailbox, and cleans up after itself. Run it after each update, and on
each account you care about (for example Yahoo, then Gmail).

## What it does, and doesn't

- It **makes its own test mail**: one email to your own address with a small
  file attached, a draft, a reply and a forward. Every subject starts with
  "UM test" and a four-letter code, so it can't touch anything else.
- It **only reads** your other mail: listing, searching, opening, summarizing
  who sends to you, and one attachment if you have any.
- It **sends only to your own address**, apart from one send to an address
  that can't exist (`nobody@example.invalid`), which must be held unsent.
- It **marks only its own test email as junk, then brings it straight back**
  (moving it out of Junk tells your provider it isn't spam).
- It **leaves behind** a folder (a label in Gmail) called **UM test**: no tool
  deletes folders, so remove it in your mail app. Everything else it made ends
  up in Trash.
- It takes about 10 minutes: mail you send yourself can take a few minutes to
  arrive (Yahoo especially), so it sends first and looks for it later.

## Before you start

1. Your installation is up to date: Cloud Shell, `cd ~/universal-mail && git pull`,
   then `node setup.js`, **2 (Update)**.
2. On your Universal Mail page, the app (Claude or ChatGPT) has **Read**,
   **Organize** and **Send** for the account, saved; and sending is on for it.
3. In the prompt's first line, put the account's **name as your page shows
   it** (Your accounts) and **its email address**. Nothing else needs changing.
4. One app at a time, in a new chat.

## The prompt

```text
Run a complete test of the Universal Mail connector on my account "yahoo", whose address is "you@example.com". Pass account "yahoo" on every call unless a step says otherwise. Use only the Universal Mail tools.

Rules for the whole test:
- Make up a random four-letter code now, say ABCD, and start every subject you write with "UM test ABCD" so this test's mail can't be confused with anything else.
- Send only to my address above, except step 9, which must be held unsent. Never confirm a new recipient.
- Change only the mail this test creates. Never unsubscribe from a real sender and never mark real mail as junk.
- Use the folders list_folders marks as Sent, Drafts, Trash, Junk and Archive (Gmail: All Mail), whatever their names.
- Mail I send myself can take a few minutes to arrive. Never search for the same thing more than 8 times. If it hasn't arrived, say so, and go on with the next step that doesn't need it.
- If a step fails, say so and go on. Retry nothing more than once.

Keep a table as you go: step, tools used, worked (yes/no), what you saw, anything odd.

SEND FIRST
1. list_folders. Note which folders are marked Inbox, Sent, Drafts, Trash, Junk and Archive or All Mail.
2. send_email to my address. Subject "UM test ABCD mail", a two-line body, and a file you write: files [{ filename: "totals.csv", text: "item,amount\ncoffee,4.50\ntea,3.00\n" }]. Note the messageId, sentAt and the attachments the answer lists.

READING (nothing changes)
3. search_email the Inbox with limit 5. Then limit 2, and page once with the cursor: no message twice.
4. get_email the newest Inbox message with format text, then format full. Then get_thread on it.
5. summarize_senders on the Inbox. Show the top 5: messages, unread, how each offers to unsubscribe (one-click, link, email or none), and any cautions.
6. search_email the Inbox for the 50 newest. List each one that has cautions, with the caution in full, and say whether it looks right.
7. search_email the Inbox with hasAttachments true, limit 3. If any, get_attachment the first one's first attachment and say what kind it is (and for text, what it's about in one sentence). Then re-find it by messageId: its read state must be unchanged. If none, say so.
8. If I have more than one account: search_email with no account for the word "invoice", limit 5, and say which account each result came from. Otherwise skip.

HELD, FOLDERS AND DRAFTS
9. send_email to nobody@example.invalid, subject "UM test ABCD held", one line. It must be held with MAIL-NEW-RECIPIENT and nothing sent. Quote the answer's message. Don't confirm or retry.
10. create_folder "UM test", then again: the second answer should say created false.
11. create_draft to my address, subject "UM test ABCD draft", one line, files [{ filename: "notes.md", text: "# Notes\nfirst" }]. Find it in Drafts by subject. update_draft it with a new body and another file: files [{ filename: "more.txt", text: "second file" }]. get_email the updated draft (its new uid): the new body, and both notes.md and more.txt attached.

THE TEST MAIL
12. Find "UM test ABCD mail" in the Inbox (search by subject, up to 8 times). Say how many searches it took. Its search result should list attachmentNames ["totals.csv"]; a search with attachmentName "totals" should find it too. get_attachment index 0: it should be text, the CSV above.
13. On it: mark_read, then mark_read again (the second answer's changed list should be empty), then mark_unread. flag_email flagged true, then false. After each, re-find it by messageId and report read and flagged.
14. move_email it to "UM test" and re-find it there by messageId. archive_email it and re-find it. junk_email it: say which folder it went to. restore_email it to the Inbox. trash_email it, then restore_email it to the Inbox. Re-find it by messageId after each; its uid changes every time.
15. unsubscribe on it: it must refuse (the email is from this account itself) and change nothing.
16. reply_email to it with one line, and attachments: [{ mailbox, uid, index: 0 }] of the test mail, which sends totals.csv back. The answer should list totals.csv.
17. forward_email it to my address with the note "Forward test". The answer should list totals.csv.
18. Search the Inbox for "UM test ABCD" (up to 8 times) until the reply and the forward have arrived, or you run out. Then get_thread on the test mail: the reply should be in it if it arrived. Mark every "UM test ABCD" message you found read in one call (uids), then unread in one call.

CLEAN UP
19. trash_email every "UM test ABCD" message in the Inbox in one call, the ones in Sent in one call, and the draft. Search the Inbox once more for "UM test ABCD" and trash anything that arrived late. Leave the "UM test" folder.
20. Show the table, then a short list of anything slow, wrong or confusing. Then tell me to open my Universal Mail page and check Recent activity.
```

## Afterwards, on your page

**Recent activity** should list, newest first: the trash, the marks, the
forward and the reply (each with 1 attachment), the moves (to UM test, Archive,
Junk and back), the draft and its update, the flag and unflag, and the first
send (1 attachment). Not listed: the held send and the refused unsubscribe
(nothing happened), and the second "mark read" (it changed nothing).

To try **undo**, press **Put back** on the last trash: the test email comes
back to the Inbox. Delete it in your mail app afterwards.

## Provider differences you'll see

| | Yahoo | Gmail |
|---|---|---|
| Delivery to yourself | 1 to 3 minutes | seconds |
| Sent copy | filed by Yahoo a minute or so later | at once |
| Junk folder | Bulk | [Gmail]/Spam |
| Archive | Archive | [Gmail]/All Mail (a message can show in several folders) |
| Text search | matches the words asked | matches words anywhere, so it can return unrelated mail; subject searches are exact |
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
