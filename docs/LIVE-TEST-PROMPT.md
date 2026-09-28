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

1. List my folders.
2. Search my Inbox for the 5 newest messages. Then search it again with limit 3 and page once with the cursor. Then search for messages from my own address.
3. Open the newest Inbox message with format text, then the same one with format full. Then get its thread.
4. Create a folder called "Universal Mail test".
5. Send me an email (to my own address) with the subject "Universal Mail test <today's date and time>" and a two-line body.
6. Wait about 30 seconds, then search my Inbox by that subject until you find it. Note its messageId and uid.
7. On that message: open it; mark it read; mark it unread; flag it; unflag it. After each change, re-find it by messageId and tell me what the read and flagged fields say.
8. Move it to "Universal Mail test". Re-find it there by messageId.
9. Archive it. Re-find it in Archive by messageId.
10. Trash it. Re-find it in Trash. Restore it. Re-find it in the Inbox.
11. Create a draft to my own address with the subject "Universal Mail draft test" and a one-line body. Search Drafts for it. Update the draft with a different body. Open the updated draft.
12. Reply to the test message (to my own address only) with a one-line body. Wait about 30 seconds and find the reply in Sent by its subject.
13. Batch test: in the Inbox, mark both test messages (the original and the reply, if it's there) read in one call using uids, then unread in one call.
14. Clean up: trash the test message, the reply and the draft. Leave the "Universal Mail test" folder; I'll remove it myself.
15. Show the table and your notes.
```

---

The timings, one line per tool call, from the server's log (Cloud Shell,
after the test; replace the project id with yours):

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="universal-mail" AND jsonPayload.event="tool"' --project=universal-mail-1338f9 --freshness=3h --limit=300 --format='value(timestamp,jsonPayload.name,jsonPayload.ms,jsonPayload.ok,jsonPayload.code)'
```
