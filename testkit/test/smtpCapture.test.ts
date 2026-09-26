import { describe, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { startSmtpCapture } from '../src/smtpCapture.js';

const subjectOf = (raw: Buffer) => /^Subject: ([^\r\n]*)/m.exec(raw.toString())?.[1];

// TK-08: a local SMTP server that keeps exactly what was delivered, envelope
// and bytes, so send tests can count deliveries instead of trusting a mock.
describe('TK-08 SMTP capture', () => {
  it('records exactly the messages delivered, with their envelopes', async () => {
    const capture = await startSmtpCapture();
    try {
      const transport = nodemailer.createTransport({ host: capture.host, port: capture.port, secure: false, ignoreTLS: true, auth: { user: 'tester', pass: 'anything' } });
      await transport.sendMail({ from: 'me@example.invalid', to: 'a@example.invalid', subject: 'one', text: 'first' });
      await transport.sendMail({ from: 'me@example.invalid', to: ['b@example.invalid', 'c@example.invalid'], bcc: 'hidden@example.invalid', subject: 'two', text: 'second' });
      transport.close();
      expect(capture.messages.map(m => ({ from: m.from, to: m.to, subject: subjectOf(m.raw) }))).toEqual([
        { from: 'me@example.invalid', to: ['a@example.invalid'], subject: 'one' },
        { from: 'me@example.invalid', to: ['b@example.invalid', 'c@example.invalid', 'hidden@example.invalid'], subject: 'two' }
      ]);
      // The envelope carries the Bcc recipient; the delivered bytes must not.
      expect(capture.messages[1]!.raw.toString()).not.toMatch(/^Bcc:/im);
    } finally {
      await capture.stop();
    }
  });
});
