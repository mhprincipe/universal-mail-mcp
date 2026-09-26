# Architecture

## What this is

A stateless MCP server that gives one AI client access to exactly one Yahoo Mail
account over IMAP and SMTP. No database, no queue, no background worker, no
browser automation. Yahoo remains the system of record; this server holds no
mail state of its own.

## Shape

```
AI client ──HTTPS──▶ Cloud Run ──▶ Express
                                    ├── /health         public, no auth
                                    ├── /.well-known/…  public, no auth
                                    └── protectedApp    Host/Origin validated
                                         ├── /ready     bearer()
                                         └── /mcp       bearer() ──▶ MCP handler
                                                                      └── 16 tools
                                                                           └── MailService
                                                                                ├── ImapGateway ──▶ Yahoo IMAP
                                                                                └── nodemailer  ──▶ Yahoo SMTP
       │                                                    ▲
       └──────────── OAuth ──▶ Auth0 ──── JWKS ─────────────┘
```

## Files

| File | Responsibility |
|---|---|
| `src/index.ts` | process entry; binds the port |
| `src/app.ts` | Express wiring, auth middleware, discovery, error handler |
| `src/oauth.ts` | token verification, scope-per-tool mapping |
| `src/config.ts` | environment schema (Zod) |
| `src/tools.ts` | the 16 MCP tool definitions |
| `src/errors.ts` | error classification and the response envelope |
| `src/types.ts` | shared shapes |
| `src/yahoo/imap.ts` | all IMAP I/O and recovery logic |
| `src/yahoo/mailService.ts` | orchestration across IMAP and SMTP |
| `src/yahoo/mime.ts` | message composition |

## Request path

1. **Host/Origin validation.** `/mcp` and `/ready` sit behind the MCP adapter's
   DNS-rebinding protection. `/health` and the discovery document deliberately
   do not — discovery carries no credentials and must be readable by a
   browser-based client.
2. **`bearer()`** verifies the token and maps the requested tool to its required
   scopes *before* any mail connection opens. JSON-RPC batches are rejected so a
   write cannot ride along inside a read.
3. **MCP handler** dispatches to a tool.
4. **`MailService`** performs the operation, classifies any failure, and wraps
   the result in the envelope.

## Trust boundaries

| Boundary | Control |
|---|---|
| Client → server | RS256 JWT: issuer, audience, `sub`, `azp`, lifetime ≤900s |
| Server → Auth0 | JWKS from a pinned HTTPS URL. Request headers never choose an issuer |
| Server → Yahoo | app password from Secret Manager, never exposed to the client |
| Email content → model | every body carries `untrustedContent: true` |

The Yahoo app password never leaves the server. The AI client authenticates to
*this service*; this service authenticates to Yahoo separately.

## Authentication

Two modes, selected by `AUTH_MODE`:

- **`bearer`** — a single shared secret, compared in constant time. Local
  development only.
- **`oauth`** — RS256 JWTs from Auth0, with a third mode `oauth-setup` that
  publishes discovery while denying every request. Setup mode exists to solve an
  ordering problem: a client cannot discover the issuer until discovery is
  public, but you do not want mailbox access open while you configure it.

In OAuth mode a token must satisfy **all** of: valid RS256 signature from the
pinned JWKS, exact issuer, audience equal to the resource URL, `sub` equal to
the one configured owner, `azp` in the allowlist, a `scope` claim, lifetime
≤900 seconds, and age ≤900 seconds.

Any failure returns an identical 401. The server logs a structured
`{"event":"token_rejected","reason":"..."}` naming the failed check — reason
only, never a token or claim value.

### Scopes

| Scope | Tools |
|---|---|
| `mail.read` | `search_email`, `get_email`, `get_thread`, `list_folders` |
| `+ mail.write` | drafts, moves, flags, folders, trash, restore |
| `+ mail.send` | `send_email`, `reply_email` |

Every authenticated request needs `mail.read`, including tool discovery.

## The safety model

This is the part worth understanding before changing anything.

**Never retry a mutation unless the first attempt can be proven not to have
completed.** Reads may retry once after a clearly transient network error.
Mutations may not.

**Return `UNKNOWN` rather than risk a duplicate external action.** When the
outcome cannot be established, the server says so instead of guessing.

**Verify before retrying when verification is possible.** An ambiguous move
searches both source and destination by `Message-ID` and only retries when the
message is provably still in the source and provably absent from the
destination. Five distinct inconclusive cases each return `UNKNOWN` instead.

**Refuse unsafe primitives.** Moving requires MOVE or UIDPLUS; draft cleanup
requires UIDPLUS. Without them the server refuses rather than risk expunging
unrelated messages.

**Never invent a destination.** Special folders resolve through SPECIAL-USE.
Ordinary folders match exactly. A typo fails.

**Reading never mutates.** Read-only mailbox locks and `BODY.PEEK` throughout.

## Bounds

| Bound | Default | Limits |
|---|---|---|
| `MAX_MESSAGE_BYTES` | 20 MiB | what is fetched from Yahoo |
| `MAX_BODY_CHARS` | 100,000 | what a tool result returns, per body part |
| thread fetch | 100 messages | members retrieved per `get_thread` |
| thread scan | 200 per folder | header fallback window |
| search | 100 | `limit` maximum; no pagination |
| folder cache | 30 seconds | cleared by `create_folder`; a folder made in Yahoo's UI may take that long to appear |

## Known limits

- **Single owner.** `OAUTH_OWNER_SUB` pins one subject. Not multi-tenant, and
  cannot be made so without a credential store, which CODEX forbids.
- **Connection churn.** Each operation opens its own IMAP connection, and there
  is no pooling. With the folder listing cached for 30 seconds, a warm
  `archive_email` costs two and `move_email` one; cold, add one for the LIST.
  Relocation accepts a batch (`uids`, up to 100) in one IMAP command; flags,
  drafts and sends remain one message per call.
- **No attachments**, no folder rename or delete, no permanent delete.
- **No request logging**, no metrics, no graceful shutdown on SIGTERM.
- **Thread completeness** is bounded by the 200-per-folder scan.
