import type { GcloudRunner } from './gcloud.js';

// DIA-11: the server's own log, for `node setup.js report`, so a problem is
// one command and one paste (found live: diagnosing step 8 needed a second
// command whose output showed the server's JSON lines as blanks). The server
// writes no passwords, keys or mail to its log (design §7), and its request
// lines name the key only as {key}.
export const SERVER_LOG_FILTER = 'resource.type="cloud_run_revision" AND resource.labels.service_name="universal-mail"';

type Entry = { timestamp?: string; jsonPayload?: unknown; textPayload?: string };

export async function serverLog(run: GcloudRunner, project: string): Promise<string> {
  const r = await run(['logging', 'read', SERVER_LOG_FILTER, `--project=${project}`, '--freshness=1h', '--limit=80', '--format=json']);
  if (r.status !== 0) {
    // Google's reason code (PERMISSION_DENIED…), never its whole message.
    const code = /\b(?!ERROR\b)([A-Z][A-Z_]{3,})\b/.exec(r.stderr)?.[1] ?? `exit ${r.status}`;
    return `Server log: couldn't be read (gcloud: ${code}).`;
  }
  let entries: Entry[];
  try { entries = JSON.parse(r.stdout || '[]') as Entry[]; } catch { return 'Server log: couldn\'t be read (gcloud: not JSON).'; }
  // Google gives the newest first; a story reads oldest first.
  const lines = [...entries].reverse().flatMap(e => {
    const body = e.jsonPayload !== undefined ? JSON.stringify(e.jsonPayload) : e.textPayload?.trim();
    return body ? [`${e.timestamp ?? ''}  ${body}`] : [];
  });
  return ['Server log (last hour, oldest first):', ...(lines.length ? lines : ['(nothing in the last hour)'])].join('\n');
}
