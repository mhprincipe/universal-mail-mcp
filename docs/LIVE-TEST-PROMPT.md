# The live test prompt

One account, every tool, nothing of yours touched. Paste the whole block
below into a new Claude chat with the Universal Mail connector on. It works
only on messages it creates itself (sent to your own address), a draft it
creates, and one folder it makes. Run it before and after a change and the
server's log gives the timings to compare (`node setup.js report`, or the
one-line command at the end).

What it leaves behind: a folder called **Universal Mail test** (there is no
tool that deletes folders: remove it in your mail app), and its test messages
in Trash.

---

```text
Please run a full test of the Universal Mail connector on my one email account, step by step, exactly in this order. Use only the Universal Mail tools. Never send to anyone but my own address, and never move, flag or delete any message you didn't create in this test. If a step fails, say so and go on to the next one; don't retry more than once.

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

---

The timings, one line per tool call, from the server's log (Cloud Shell,
after the test; replace the project id with yours). Since 2.2.4 each line
ends with where the time went: `imap.connect` is a login, `imap.search`,
`imap.fetchOne` and the rest are mail server commands, `smtp.send` is
handing a message to the provider, `parse` is reading one; each with its
total milliseconds (`ms`) and how many times (`n`).

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="universal-mail" AND jsonPayload.event="tool"' --project=universal-mail-1338f9 --freshness=3h --limit=300 --format='value(timestamp,jsonPayload.name,jsonPayload.ms,jsonPayload.ok,jsonPayload.code,jsonPayload.phases)'
```

Anything the server turned away (for instance Claude's "Temporarily unable to
authenticate"), one line per request:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="universal-mail" AND httpRequest.status>=400' --project=universal-mail-1338f9 --freshness=1d --limit=50 --format='value(timestamp,httpRequest.requestMethod,httpRequest.status,httpRequest.latency,httpRequest.requestUrl)'
```
