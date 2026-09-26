import { describe, expect, it } from 'vitest';
import { classify, isTransient, MailError, success } from '../src/errors.js';

describe('error safety', () => {
  it('recognizes transient network failures', () => {
    expect(isTransient(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
  });

  it('does not mark auth failures retryable', () => {
    const e = classify(Object.assign(new Error('authentication failed'), { responseCode: 535 }));
    expect(e.code).toBe('AUTH_FAILED');
    expect(e.retryable).toBe(false);
  });

  it('preserves UNKNOWN state', () => {
    const e = new MailError('SEND_STATUS_UNKNOWN', 'ambiguous', 'UNKNOWN');
    expect(e.status).toBe('UNKNOWN');
  });

  it('success envelope is explicit', () => {
    expect(success({ a: 1 })).toMatchObject({ ok: true, status: 'SUCCESS', code: 'OK' });
  });
});
