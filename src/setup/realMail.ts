import { resolveMx, resolveSrv } from 'node:dns/promises';
import type { ConnectionOptions } from 'node:tls';
import { detectProvider, type DetectionDeps, type Endpoint } from '../providers.js';
import type { MailCheck } from './flow.js';
import type { SetupLog } from './log.js';
import { checkAccount, sendTestEmail, type Endpoints } from './mailcheck.js';

// The MailCheck setup really uses (built-ins only, SET-25): finds each
// address's provider, checks its app password, and runs the sending test.

// Autoconfig answers are small; anything bigger isn't one.
const AUTOCONFIG_LIMIT = 64 * 1024;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

type Found = { imap: Endpoint; smtp: Endpoint };

// Thunderbird's autoconfig format: the first encrypted IMAP server and the
// first encrypted SMTP server. Unencrypted ones are never used.
export function parseAutoconfig(xml: string): Found | undefined {
  const first = (tag: string, type: string) => [...xml.matchAll(new RegExp(`<${tag}\\s+type="${type}"\\s*>([\\s\\S]*?)</${tag}>`, 'gi'))]
    .map(([, body]) => {
      const field = (name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(body!)?.[1];
      const socket = field('socketType')?.toUpperCase();
      const tls = socket === 'SSL' ? 'implicit' as const : socket === 'STARTTLS' ? 'starttls' as const : undefined;
      const host = field('hostname')?.toLowerCase();
      const port = Number(field('port'));
      return tls && host && HOSTNAME.test(host) && Number.isInteger(port) && port > 0 && port < 65_536 ? { host, port, tls } : undefined;
    })
    .find(Boolean);
  const imap = first('incomingServer', 'imap');
  const smtp = first('outgoingServer', 'smtp');
  return imap && smtp ? { imap, smtp } : undefined;
}

async function readLimited(response: Response): Promise<string | undefined> {
  if (Number(response.headers.get('content-length') ?? 0) > AUTOCONFIG_LIMIT || !response.body) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > AUTOCONFIG_LIMIT) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The domain's own autoconfig, then Thunderbird's public list. Over https
// only, with no redirects: a tampered answer could send the password elsewhere.
export async function fetchAutoconfig(domain: string, fetchImpl: typeof fetch = fetch, options: { timeoutMs?: number } = {}): Promise<Found | undefined> {
  if (!HOSTNAME.test(domain)) return undefined;
  for (const url of [`https://autoconfig.${domain}/mail/config-v1.1.xml`, `https://autoconfig.thunderbird.net/v1.1/${domain}`]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
      const text = response.ok ? await readLimited(response) : undefined;
      const found = text === undefined ? undefined : parseAutoconfig(text);
      if (found) return found;
    } catch { /* no answer from this one: try the next */ } finally { clearTimeout(timer); }
  }
  return undefined;
}

export function realLookups(): DetectionDeps {
  return {
    resolveMx: async domain => (await resolveMx(domain)).sort((a, b) => a.priority - b.priority).map(record => record.exchange),
    autoconfig: domain => fetchAutoconfig(domain),
    resolveSrv: name => resolveSrv(name)
  };
}

export function createMailCheck(options: { log: SetupLog; lookups?: DetectionDeps; tls?: ConnectionOptions; timeoutMs?: number; poll?: { tries: number; everyMs: number } }): MailCheck {
  const lookups = options.lookups ?? realLookups();
  const servers = new Map<string, Endpoints>();

  const detect: MailCheck['detect'] = async address => {
    const domain = (address.split('@')[1] ?? '').toLowerCase();
    const found = await detectProvider(address, lookups);
    if (found.kind === 'needs-input') {
      options.log.event({ type: 'mail', op: 'detect-detail', domain, via: 'none' });
      return undefined;
    }
    // A provider found only by its published servers is named after its domain.
    const provider = found.kind === 'profile' ? found.profile
      : { id: 'other', name: domain, imap: found.imap, smtp: found.smtp, appPassword: { page: domain, button: 'App passwords', prerequisites: [] } };
    servers.set(address, { imap: provider.imap, smtp: provider.smtp });
    options.log.event({ type: 'mail', op: 'detect-detail', domain, via: found.via, provider: provider.id, imapHost: provider.imap.host, smtpHost: provider.smtp.host });
    return { provider };
  };

  // The servers detection found; detected again if this run hasn't yet (a resumed setup).
  const serversFor = async (address: string) => {
    if (!servers.has(address)) await detect(address);
    const known = servers.get(address);
    if (!known) throw new Error('no mail servers are known for this address');
    return known;
  };

  return {
    detect,
    check: async (address, password) => checkAccount(address, password, await serversFor(address), options),
    sendTest: async (address, password) => sendTestEmail(address, password, await serversFor(address), options)
  };
}
