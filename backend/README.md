# kauth backend

An auth backend for first-party applications: email + password credentials,
social login, server-owned sessions with rotating refresh tokens, and an audit
log.

## Running it

```bash
bun install
docker compose up -d db          # Postgres on :5433
bunx --bun prisma migrate deploy
bun run dev
```

Copy `.env.example` to `.env` first. `JWT_SECRET` and `COOKIE_SECRET` must be at
least 32 characters in production; the app refuses to start otherwise.

```bash
bun run seed      # demo users
bun run studio    # Prisma Studio
```

## Tests

Integration tests run against a real Postgres. They create and migrate a
`kauth_test` database automatically, so the dev container is the only
prerequisite.

```bash
bun test
bun run typecheck
bun run lint
```

## API

All state-changing routes require a trusted `Origin` (or no origin at all, for
non-browser clients). Requests that carry cookies must also send a matching
`X-CSRF-Token`.

### Credentials

| Method | Path | Notes |
| ------ | ---- | ----- |
| POST | `/register` | Requires `X-Device-Id`. Sends a confirmation email. |
| POST | `/login` | Requires `X-Device-Id`. |
| POST | `/refresh` | Rotates the refresh token; replaying one revokes the family. |
| POST | `/logout` | Revokes the session for this device. |

### Account

| Method | Path | Notes |
| ------ | ---- | ----- |
| POST | `/send-verification-email` | Always 202, whether or not the address exists. |
| POST | `/verify-email` | Single-use token from the email. |
| POST | `/forgot-password` | Always 202. |
| POST | `/reset-password` | Revokes every session and marks the email verified. |
| POST | `/change-password` | Authenticated. Revokes every session. |

### Social login

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/oauth/providers` | Which providers are configured. |
| GET | `/oauth/:provider` | Redirects to the provider. |
| GET | `/oauth/:provider/callback` | Redirects to `<FRONTEND_URL>/oauth/callback?code=…` or `?error=…`. |
| POST | `/oauth/exchange` | Requires `X-Device-Id`. Trades the code for a token pair. |

The callback hands the browser a short-lived single-use code rather than the
tokens themselves: a redirect cannot carry the `X-Device-Id` header a session
needs, and session tokens in a URL would leak into history and referrers.

### Other

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/health` | Liveness. |
| GET | `/csrf-token` | Issues the CSRF cookie and returns its value. |
| GET | `/protected` | Demo endpoint behind `requireAuth`. |

### Errors

Every failure returns the same shape:

```json
{ "error": { "message": "Invalid credentials", "code": "auth_failed" } }
```

## Account linking

A provider identity links to an existing user only when the provider vouches
for a matching email address. An unverified provider email is refused, because
anyone able to set an address at a sloppy provider could otherwise take over the
matching kauth account.

## Adding a provider

Providers kauth does not ship a client for can be registered at startup:

```ts
import { registerOAuthProvider } from "./lib/oauth/providers";

registerOAuthProvider({
  id: "gitlab",
  scopes: ["read_user"],
  usesPkce: true,
  createAuthorizationURL: (state, codeVerifier) => new URL(/* … */),
  validateAuthorizationCode: (code, codeVerifier) => /* … */,
  fetchProfile: async (tokens) => ({
    accountId: "…",
    email: "…",
    emailVerified: true,
    name: null,
    image: null,
  }),
});
```

## Email

kauth does not pick a mail provider. The default transport prints to stdout so
local flows are complete and inspectable. Supply your own at startup:

```ts
import { setMailer } from "./lib/mail";

setMailer({ async send(mail) { /* … */ } });
```

## Documentation

- [Audit](../docs/audit-2026-07-27.md) — current state, gaps, and what is still missing.
- [Hardening roadmap](docs/README.md) — the original phased plan.
