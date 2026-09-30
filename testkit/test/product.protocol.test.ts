import { describe, expect, it } from 'vitest';
import { startProduct } from '../src/product.js';

// TK-13: the whole product, exactly as an AI app reaches it (HTTP, bearer
// token, MCP), running against a real mail server and a capturing SMTP server.
describe('TK-13 product harness', () => {
  it('serves the real server\'s folders over MCP, and sends through the capture', async () => {
    const product = await startProduct('yahoo-like');
    try {
      const folders = await product.ok('list_folders') as Array<{ path: string }>;
      expect(folders.map(f => f.path).sort()).toEqual(['Archive', 'Bulk', 'Draft', 'INBOX', 'Sent', 'Trash']);

      await product.ok('send_email', { newRecipientsConfirmed: true, to: ['friend@example.invalid'], subject: 'harness', text: 'hello' });
      expect(product.smtp.messages.map(m => m.to)).toEqual([['friend@example.invalid']]);

      // A failed tool call comes back as data, not an exception.
      const typo = await product.call('move_email', { mailbox: 'INBOX', uid: 1, destination: 'Nowhere' });
      expect(typo.isError).toBe(true);
    } finally {
      await product.stop();
    }
  });
});
