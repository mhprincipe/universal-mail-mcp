# The live test prompt

One account, every tool, nothing of yours touched. Paste the whole block
below into a new Claude (or ChatGPT) chat with Universal Mail on. It works
only on messages it creates itself (sent to your own address), a draft it
creates, and one folder it makes. Run it before and after a change and the
server's log gives the timings to compare (`node setup.js report`, or the
one-line command at the end).

What it leaves behind: a folder called **Universal Mail test** (there is no
tool that deletes folders: remove it in your mail app), and its test messages
in Trash.

---

```text
Please run a full test of the Universal Mail connector on my email account "yahoo" (pass account "yahoo" on every call), step by step, exactly in this order. Use only the Universal Mail tools. Never send to anyone but my own address, and never move, flag or delete any message you didn't create in this test. If a step fails, say so and go on to the next one; don't retry more than once.

Keep a table as you go: step, tool used, worked (yes/no), what you saw, anything odd. At the end show the table and a short list of anything that felt slow, wrong or confusing.

Known and expected, so don't count them as problems: my provider delivers a message, and files its Sent copy, a minute or two after sending; you can't pause, so never search for a message more often than the steps below say. Yahoo itself adds a References header ending in ".ref" to mail it receives.

1. List my folders.
2. Search my Inbox for the 5 newest messages. Then search it again with limit 3 and page once with the cursor. Then search for messages from my own address.
3. Open the newest Inbox message with format text, then the same one with format full. Then get its thread.
4. Create a folder called "Universal Mail test".
5. Send me an email (to my own address) with the subject "Universal Mail test <today's date and time>" and a two-line body.
6. While it's on its way: create a draft to my own address with the subject "Universal Mail draft test" and a one-line body. Search Drafts for it. Update the draft with a different body. Open the updated draft.
7. Now search my Inbox by the test email's subject: at most 5 searches. If it isn't there after 5, say so, skip to step 14 and clean up what exists. Note its messageId and uid.
8. On that message: open it; mark it read; mark it unread; flag it; unflag it. After each change, re-find it by messageId and tell me what the read and flagged fields say.
9. Move it to "Universal Mail test". Re-find it there by messageId.
10. Archive it. Re-find it in Archive by messageId.
11. Trash it. Re-find it in Trash. Restore it. Re-find it in the Inbox.
12. Reply to the test message (to my own address only) with a one-line body. Don't look for the reply yet.
13. Batch test: search the Inbox for "Universal Mail test" (at most 3 searches, to give the reply time to arrive). Mark the test messages you find (the original, and the reply if it's there) read in one call using uids, then unread in one call.
14. Clean up: trash the test messages in the Inbox in one call, and the draft. Then search Sent once for "Universal Mail test" and trash what you find there. Leave the "Universal Mail test" folder; I'll remove it myself.
15. Show the table and your notes.
```

Replace `yahoo` with the account's name on your page (Your accounts) if it's
different. Run one app at a time: two at once share the account's connection
and blur the timings.

---

## Gmail

Gmail's folders are labels, archiving means All Mail, mail to yourself lands in
both Inbox and Sent Mail, and threads use Gmail's own conversation id. This
prompt checks those. Replace `gmail` with the account's name on your page.
It leaves behind a label called **Universal Mail Gmail test**.

```text
Please run a full test of the Universal Mail connector on my Gmail account, step by step, in this order. Use only the Universal Mail tools, and pass account "gmail" on every call unless a step says otherwise. Never send to anyone but my own Gmail address, never change any message you didn't create in this test, and never change anything in my other accounts. If a step fails, say so and go on; don't retry more than once.

Keep a table as you go: step, tool, worked (yes/no), what you saw, anything odd. At the end show the table and a short list of anything that felt slow, wrong or confusing.

Good to know, so you don't count them as problems: Gmail folders are labels, so one message can show up in several folders (Inbox, [Gmail]/All Mail, a label) with a different uid in each. Mail I send to myself appears in both the Inbox and [Gmail]/Sent Mail. Gmail usually delivers to myself within seconds.

1. List the account's folders. Note which folders have the Sent, Drafts, Trash, Junk, All Mail and Flagged roles.
2. Search its Inbox for the 5 newest messages. Then limit 3 and page once with the cursor.
3. Open the newest Inbox message with format text. Then get its thread.
4. Create a folder (label) called "Universal Mail Gmail test".
5. Send me an email at my Gmail address with the subject "Universal Mail Gmail test A" and a two-line body. Note the messageId and sentAt from the answer.
6. Search the Inbox for "Universal Mail Gmail test A" (at most 5 searches). Note its uid and messageId. Then search [Gmail]/Sent Mail for it once, and say whether it's there too.
7. On the Inbox copy: mark it read, mark it unread, flag (star) it, unflag it. After each, re-find it by messageId and report read and flagged.
8. Move it to "Universal Mail Gmail test". Re-find it there by messageId. Then search the Inbox by messageId once and say whether it's still there.
9. Archive it. Say which folder the archive answer names. Re-find it there by messageId, and check it's no longer in the Inbox or the label.
10. Reply to it (to my own address only) with a one-line body. Then get the thread of the original and say whether the reply is in it (search at most 3 times for the reply first if it isn't).
11. Create a draft to my own address, subject "Universal Mail Gmail draft", one-line body. Find it in the Drafts folder. Update it with a different body. Open the updated draft. Then search Drafts and [Gmail]/All Mail once each for "Universal Mail Gmail draft" and report every copy you find.
12. Search all my accounts at once (no account) for "Universal Mail Gmail test" and say which account each result comes from. Read-only: don't change anything in other accounts.
13. Batch test: find the test messages in the Inbox (the reply, and the original if it's there) and mark them read in one call using uids, then unread in one call.
14. Clean up: trash every test message and draft you created, in this account only (the original, the reply, their Sent copies if separate, the draft and any old draft copy). Then search [Gmail]/All Mail once for "Universal Mail Gmail" and report anything left. Leave the "Universal Mail Gmail test" label; I'll remove it myself.
15. Show the table and your notes.
```

---

## What's new in 2.4

Attachments, scam warnings, the check before writing to someone new, and the
activity log. It reads only mail that's already there, sends only to your own
address, and makes one send attempt that is held on purpose (to an address that
can't exist, so nothing could leave even if it weren't). Replace `yahoo` with
the account's name.

```text
Please test the new Universal Mail features on my account "yahoo" (pass account "yahoo" on every call), in this order. Use only the Universal Mail tools. Never send to anyone but my own address, and never confirm a new recipient. Don't change any message. If a step fails, say so and go on.

Keep a table: step, tool, worked (yes/no), what you saw, anything odd. Show it at the end.

1. Find a message with an attachment: search my Inbox with text "pdf" (limit 10) and open the results one at a time with get_email (at most 10) until one has a non-empty attachments list. If none, try Archive the same way. Tell me its subject, whether it was read before you opened it, and its attachments (name, type, size, index).
2. Read its first attachment with get_attachment. Tell me what kind it came back as (text, image, unsupported or unreadable) and, for text, what it's about in one sentence of your own. If it has a PDF, Word file or picture you haven't read, read one of those too. Then re-find the message by messageId and tell me whether its read state is unchanged.
3. Search my Inbox for the 50 newest messages. List every one that carries cautions, with the caution in full, and say whether each looks right to you. If none, say so.
4. Send an email to nobody@example.invalid with the subject "Universal Mail new-recipient test" and one line of body. It should be held with MAIL-NEW-RECIPIENT and nothing sent. Tell me exactly what the answer said. Do not confirm or retry.
5. Send me an email at my own address with the subject "Universal Mail 2.4 test" and one line of body. It should go straight through, since it's my own address.
6. Search the Inbox for "Universal Mail 2.4 test" (at most 5 searches). Flag it, then move it to Archive.
7. Show the table and your notes. Then tell me: open my Universal Mail page, look at Recent activity, and press "Put back" on the archive and "Unflag again" on the flag.
```

Afterwards, on your page: **Recent activity** should list the send (1
recipient), the flag and the move to Archive. **Put back** on the move returns
the message to the Inbox. **Unflag again** should then say the message has
moved since and change nothing: undo never acts on a message that isn't where
it was left. The held send isn't listed, because nothing was sent. Unflag and
trash the test message in your mail app when you're done.

---

The timings, one line per tool call, from the server's log (Cloud Shell,
after the test; replace the project id with yours). Since 2.2.4 each line
ends with where the time went: `imap.connect` is a login, `imap.search`,
`imap.fetchOne` and the rest are mail server commands, `smtp.send` is
handing a message to the provider, `parse` is reading one; each with its
total milliseconds (`ms`) and how many times (`n`).

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="universal-mail" AND jsonPayload.event="tool"' --project=<your-project-id> --freshness=3h --limit=300 --format='value(timestamp,jsonPayload.name,jsonPayload.ms,jsonPayload.ok,jsonPayload.code,jsonPayload.phases)'
```

Anything the server turned away (for instance Claude's "Temporarily unable to
authenticate"), one line per request:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="universal-mail" AND httpRequest.status>=400' --project=<your-project-id> --freshness=1d --limit=50 --format='value(timestamp,httpRequest.requestMethod,httpRequest.status,httpRequest.latency,httpRequest.requestUrl)'
```
