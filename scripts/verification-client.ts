import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Client } from '@modelcontextprotocol/client';

export const expectedTools = ['search_email','get_email','get_attachment','get_thread','create_draft','update_draft','send_email','reply_email','move_email','archive_email','mark_read','mark_unread','flag_email','trash_email','restore_email','list_folders','create_folder'].sort();
const readTools = new Set(['search_email', 'get_email', 'get_attachment', 'get_thread', 'list_folders']);

// Unlike fetch, native HTTP preserves an adversarial Host header. TLS still
// validates the actual service's certificate and uses its hostname for SNI.
export async function probeStatus(target: string, headers: Record<string, string> = {}, timeout = 90000): Promise<number> {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('INVALID_PROTOCOL');
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { servername: url.hostname, headers }, res => {
      res.resume(); clearTimeout(timer); resolve(res.statusCode ?? 0);
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('PROBE_TIMEOUT'), { code: 'ETIMEDOUT' })), timeout);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

export async function callReadTool(client: Client, name: string, args: Record<string, unknown>, timeout = 290000): Promise<any> {
  if (!readTools.has(name)) throw new Error('READ_ONLY_VERIFIER');
  // MCP v2 takes options SECOND, not third. TypeScript enforces this signature.
  const result = await client.callTool({ name, arguments: args }, { timeout });
  const text = result.content?.find(item => item.type === 'text');
  const value = result.structuredContent ?? (text?.type === 'text' ? JSON.parse(text.text) : undefined);
  if (result.isError || !value || value.ok !== true) {
    throw Object.assign(new Error('TOOL_CHECK_FAILED'), { code: value?.code });
  }
  return value;
}

export function safeFailure(error: unknown): { kind: string; code?: number | string } {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32001 || code === 'ETIMEDOUT') return { kind: 'timeout', code };
  if (code === 'ERR_ASSERTION') return { kind: 'assertion', code };
  const safeCodes = ['AUTH_FAILED', 'MESSAGE_NOT_FOUND', 'TRANSIENT_NETWORK', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'];
  return { kind: 'verification_failure', ...(typeof code === 'string' && safeCodes.includes(code) ? { code } : {}) };
}
