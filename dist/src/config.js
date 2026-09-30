import { z } from 'zod/v4';
const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    // The account's address and app password (ENG-28: no provider's name; the
    // first version's YAHOO_EMAIL and YAHOO_APP_PASSWORD are still read).
    MAIL_ADDRESS: z.string().email(),
    MAIL_APP_PASSWORD: z.string().min(8),
    // builtin: v2's own sign-in server (design §6.5), what setup installs.
    // bearer: direct mode, one shared secret, for the test kit and local development.
    AUTH_MODE: z.enum(['bearer', 'builtin']).default('bearer'),
    MCP_ACCESS_SECRET: z.string().min(24).optional(),
    SENT_COPY_MODE: z.enum(['unverified', 'yahoo', 'append']).default('unverified'),
    IMAP_HOST: z.string().default('imap.mail.yahoo.com'),
    IMAP_PORT: z.coerce.number().int().default(993),
    // 'none' exists for the local test mail server and is refused for any other host.
    IMAP_TLS: z.enum(['implicit', 'starttls', 'none']).default('implicit'),
    SMTP_HOST: z.string().default('smtp.mail.yahoo.com'),
    SMTP_PORT: z.coerce.number().int().default(587),
    // Unset: implicit TLS on 465, required STARTTLS on any other port.
    // 'none' exists for the local test mail server and is refused for any other host.
    SMTP_TLS: z.enum(['implicit', 'starttls', 'none']).optional(),
    MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
    // Caps what a tool result returns, which MAX_MESSAGE_BYTES does not: that
    // limits the fetch. get_thread can return up to 100 bodies in one response.
    MAX_BODY_CHARS: z.coerce.number().int().positive().default(100_000),
    // Attachments sent with one message, together (OUT-03): under the 25 MB
    // most providers take once encoded.
    MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(18 * 1024 * 1024),
    // A search the server hasn't answered by then is stopped (SEARCH_TOO_SLOW).
    SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
    // Send limits per account (LIM-01): changed on your page.
    SEND_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),
    SEND_LIMIT_PER_DAY: z.coerce.number().int().min(1).max(10_000).default(200),
    ALLOWED_HOSTS: z.string().optional(),
    ALLOWED_ORIGINS: z.string().optional()
}).superRefine((config, ctx) => {
    if (config.AUTH_MODE === 'bearer' && !config.MCP_ACCESS_SECRET)
        ctx.addIssue({ code: 'custom', path: ['MCP_ACCESS_SECRET'], message: 'Bearer mode requires a secret' });
    for (const [setting, host] of [['IMAP_TLS', config.IMAP_HOST], ['SMTP_TLS', config.SMTP_HOST]]) {
        if (config[setting] === 'none' && !LOOPBACK.has(host.toLowerCase())) {
            ctx.addIssue({ code: 'custom', path: [setting], message: 'An unencrypted mail connection is allowed only to this machine (localhost).' });
        }
    }
});
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
export function loadConfig(env = process.env) {
    const { YAHOO_EMAIL, YAHOO_APP_PASSWORD, ...rest } = env;
    return schema.parse({ ...rest, MAIL_ADDRESS: env.MAIL_ADDRESS ?? YAHOO_EMAIL, MAIL_APP_PASSWORD: env.MAIL_APP_PASSWORD ?? YAHOO_APP_PASSWORD });
}
export function imapTransport(config) {
    if (config.IMAP_TLS === 'implicit')
        return { secure: true, doSTARTTLS: undefined };
    return { secure: false, doSTARTTLS: config.IMAP_TLS === 'starttls' };
}
// Encryption is required, never merely accepted if the server happens to offer it.
export function smtpTransport(config) {
    const mode = config.SMTP_TLS ?? (config.SMTP_PORT === 465 ? 'implicit' : 'starttls');
    if (mode === 'implicit')
        return { secure: true, requireTLS: false, ignoreTLS: false };
    if (mode === 'starttls')
        return { secure: false, requireTLS: true, ignoreTLS: false };
    return { secure: false, requireTLS: false, ignoreTLS: true };
}
export function csv(value) {
    return value?.split(',').map(v => v.trim()).filter(Boolean) ?? [];
}
//# sourceMappingURL=config.js.map