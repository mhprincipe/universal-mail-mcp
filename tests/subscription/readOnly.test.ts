import { afterEach, describe, expect, it, vi } from 'vitest';
import { success } from '../../src/errors.js';
import { createMailRouter } from '../../src/multiMail.js';
import { TOOL_CODES } from '../../src/toolCodes.js';
import { MailService } from '../../src/mail/mailService.js';

// SUB-03 (design §13.2): read-only is enforced in one place, the mail router.
afterEach(() => vi.restoreAllMocks());

const account = (name: string) => ({ name, config: {
  YAHOO_EMAIL: `${name}@example.invalid`, YAHOO_APP_PASSWORD: 'password-1', IMAP_HOST: '127.0.0.1', IMAP_PORT: 993, IMAP_TLS: 'implicit',
  SMTP_HOST: '127.0.0.1', SMTP_PORT: 587, SMTP_TLS: 'starttls', SENT_COPY_MODE: 'append'
} as never });
const SENTENCE = 'Your Universal Mail subscription has ended, so organizing and sending are paused. Reading still works. Renew on your Universal Mail page: https://mail.example/k';

describe('read-only', () => {
  it('SUB-03 read passes; organize and send are refused with the sentence and its code, whatever the app was granted', async () => {
    vi.spyOn(MailService.prototype, 'searchEmail').mockResolvedValue(success([]));
    const router = createMailRouter([account('personal'), account('work')], { readOnly: () => SENTENCE });
    const access = router.forGrant({ personal: ['read', 'organize', 'send'], work: ['read', 'organize', 'send'] });
    expect((await access.search({ limit: 1 } as never)).ok).toBe(true);
    expect(() => access.service('personal', 'read')).not.toThrow();
    for (const action of ['organize', 'send'] as const) {
      expect(() => access.service('work', action)).toThrow(expect.objectContaining({ code: 'SUBSCRIPTION-READ-ONLY', message: SENTENCE }));
    }
    // A caller without sign-in grants (bearer mode) is gated the same way.
    expect(() => router.service('personal', 'organize')).toThrow(expect.objectContaining({ code: 'SUBSCRIPTION-READ-ONLY' }));
    expect(TOOL_CODES['SUBSCRIPTION-READ-ONLY'].remedy).toMatch(/Universal Mail page/);
  });

  it('SUB-03 while the subscription is fine (or there is none), nothing changes, and the app\'s own permissions still apply', () => {
    const router = createMailRouter([account('personal')], { readOnly: () => undefined });
    expect(() => router.forGrant({ personal: ['read', 'organize', 'send'] }).service('personal', 'send')).not.toThrow();
    expect(() => router.forGrant({ personal: ['read'] }).service('personal', 'organize')).toThrow(expect.objectContaining({ code: 'MAIL-NOT-PERMITTED' }));
    expect(() => createMailRouter([account('personal')]).service('personal', 'send')).not.toThrow();
  });

  it('SUB-03 the gate is asked each time, so renewing takes effect at once', () => {
    let ended = true;
    const router = createMailRouter([account('personal')], { readOnly: () => ended ? SENTENCE : undefined });
    expect(() => router.service('personal', 'organize')).toThrow();
    ended = false;
    expect(() => router.service('personal', 'organize')).not.toThrow();
  });
});
