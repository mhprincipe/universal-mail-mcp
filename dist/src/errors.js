import { remedyFor } from './toolCodes.js';
export class MailError extends Error {
    code;
    status;
    retryable;
    details;
    constructor(code, message, status = 'FAILED', retryable = false, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.details = details;
        this.name = 'MailError';
    }
}
export function isTransient(error) {
    if (isAuthFailure(error))
        return false;
    const e = error;
    const code = String(e?.code ?? e?.errno ?? '').toUpperCase();
    const msg = String(e?.message ?? '').toLowerCase();
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)
        || msg.includes('timeout') || msg.includes('connection closed');
}
export function isAuthFailure(error) {
    const e = error;
    return e?.authenticationFailed === true || e?.code === 'EAUTH' || e?.responseCode === 535
        || /auth|authentication|invalid credentials/i.test(String(e?.message ?? ''));
}
export function mutationFailure(error) {
    if (error instanceof MailError)
        return error;
    if (isAuthFailure(error))
        return classify(error);
    return new MailError('OPERATION_STATUS_UNKNOWN', 'The mail operation was not confirmed. Check mailbox state before repeating it.', 'UNKNOWN');
}
export function classify(error) {
    if (error instanceof MailError)
        return error;
    const e = error;
    if (isAuthFailure(error)) {
        return new MailError('AUTH_FAILED', 'The mail provider rejected the saved app password.', 'FAILED', false);
    }
    if (isTransient(error))
        return new MailError('TRANSIENT_NETWORK', 'The mail server connection failed.', 'FAILED', true);
    return new MailError('MAIL_OPERATION_FAILED', 'The mail server operation failed.', 'FAILED', false);
}
export const success = (data, message = 'Success', code = 'OK', warnings) => ({
    ok: true, status: 'SUCCESS', code, message, data, ...(warnings?.length ? { warnings } : {})
});
export function failure(error) {
    const e = classify(error);
    return { ok: false, status: e.status, code: e.code, message: e.message, remedy: remedyFor(e.code), ...(e.details ? { data: e.details } : {}) };
}
//# sourceMappingURL=errors.js.map