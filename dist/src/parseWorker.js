import { parentPort } from 'node:worker_threads';
import { attachmentFiles, readAttachment } from "./attachmentCore.js";
import { parseMessage } from "./parseCore.js";
// One job at a time: { id, raw } (an email), { id, raw, attachment } (one of
// its attachments, by position) or { id, raw, files: true } (all of its
// attachments as they are, to send on) in; { id, ok, message | attachment |
// files | reason } out.
parentPort.on('message', async ({ id, raw, attachment, files }) => {
    try {
        if (files)
            parentPort.postMessage({ id, ok: true, files: await attachmentFiles(Buffer.from(raw)) });
        else if (attachment === undefined)
            parentPort.postMessage({ id, ok: true, message: await parseMessage(Buffer.from(raw)) });
        else
            parentPort.postMessage({ id, ok: true, attachment: (await readAttachment(Buffer.from(raw), attachment)) ?? null });
    }
    catch (error) {
        parentPort.postMessage({ id, ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
});
// Loaded: from here on, the time taken is the email's.
parentPort.postMessage({ ready: true });
//# sourceMappingURL=parseWorker.js.map