import { simpleParser } from 'mailparser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { isSystemMessageId } from '../src/systemMail.js';
import { MailService } from '../src/yahoo/mailService.js';
import { startSmtpCapture, type SmtpCapture } from '../testkit/src/smtpCapture.js';

let capture: SmtpCapture | undefined;
afterEach(async () => { await capture?.stop(); capture = undefined; vi.restoreAllMocks(); });

describe('sending system emails', () => {
  it('SIG-54 a system email carries the system marker and Message-ID, and no Sent copy is kept (added)', async () => {
    capture = await startSmtpCapture();
    const service = new MailService(loadConfig({
      YAHOO_EMAIL: 'personal@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars',
      IMAP_HOST: '127.0.0.1', SMTP_HOST: capture.host, SMTP_PORT: String(capture.port), SMTP_TLS: 'none', SENT_COPY_MODE: 'append'
    }));
    const append = vi.spyOn(service.imap, 'append');
    const messageId = await service.sendSystemEmail('owner@example.invalid', 'Your Universal Mail code', 'Your code is K7Q2-F9XM');

    expect(isSystemMessageId(messageId)).toBe(true);
    expect(capture.messages.map(m => m.to)).toEqual([['owner@example.invalid']]);
    const parsed = await simpleParser(capture.messages[0]!.raw);
    expect(parsed.messageId).toBe(messageId);
    expect(parsed.headers.get('x-universal-mail')).toBe('system');
    expect(append).not.toHaveBeenCalled();
  });
});
