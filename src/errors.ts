import { remedyFor } from './toolCodes.js';

export type ResultStatus = 'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'UNKNOWN';

export class MailError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: ResultStatus = 'FAILED',
    public retryable = false,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'MailError';
  }
}

export function isTransient(error: unknown): boolean {
  if (isAuthFailure(error)) return false;
  const e = error as { code?: string; errno?: string; message?: string };
  const code = String(e?.code ?? e?.errno ?? '').toUpperCase();
  const msg = String(e?.message ?? '').toLowerCase();
  return ['ECONNRESET','ETIMEDOUT','ECONNREFUSED','EPIPE','EAI_AGAIN','ENETUNREACH'].includes(code)
    || msg.includes('timeout') || msg.includes('connection closed');
}

export function isAuthFailure(error: unknown): boolean {
  const e = error as { code?: string; responseCode?: number; message?: string; authenticationFailed?: boolean };
  return e?.authenticationFailed === true || e?.code === 'EAUTH' || e?.responseCode === 535
    || /auth|authentication|invalid credentials/i.test(String(e?.message ?? ''));
}

export function mutationFailure(error: unknown): MailError {
  if (error instanceof MailError) return error;
  if (isAuthFailure(error)) return classify(error);
  return new MailError('OPERATION_STATUS_UNKNOWN', 'The mail operation was not confirmed. Check mailbox state before repeating it.', 'UNKNOWN');
}

export function classify(error: unknown): MailError {
  if (error instanceof MailError) return error;
  const e = error as { code?: string; responseCode?: number; command?: string; message?: string };
  if (isAuthFailure(error)) {
    return new MailError('AUTH_FAILED', 'The mail provider rejected the saved app password.', 'FAILED', false);
  }
  if (isTransient(error)) return new MailError('TRANSIENT_NETWORK', 'The mail server connection failed.', 'FAILED', true);
  return new MailError('MAIL_OPERATION_FAILED', 'The mail server operation failed.', 'FAILED', false);
}

export type ToolEnvelope<T> = {
  ok: boolean;
  status: ResultStatus;
  code: string;
  message: string;
  // On a failure: what to do next (toolCodes.ts).
  remedy?: string;
  data?: T;
  warnings?: string[];
  // A response cut to size: how many items were left out, and how to reach them.
  more?: { count: number; hint: string };
  // search_email: pass this back as cursor for the next page.
  cursor?: string;
};

export const success = <T>(data: T, message = 'Success', code = 'OK', warnings?: string[]): ToolEnvelope<T> => ({
  ok: true, status: 'SUCCESS', code, message, data, ...(warnings?.length ? { warnings } : {})
});

export function failure(error: unknown): ToolEnvelope<never> {
  const e = classify(error);
  return { ok: false, status: e.status, code: e.code, message: e.message, remedy: remedyFor(e.code), ...(e.details ? { data: e.details as never } : {}) };
}
