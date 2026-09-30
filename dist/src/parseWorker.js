import { parentPort } from 'node:worker_threads';
import { readAttachment } from "./attachmentCore.js";
import { parseMessage } from "./parseCore.js";
// One job at a time: { id, raw } (an email) or { id, raw, attachment } (one of
// its attachments, by position) in; { id, ok, message | attachment | reason } out.
parentPort.on('message', async ({ id, raw, attachment }) => {
    try {
        if (attachment === undefined)
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