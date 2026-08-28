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

Copy `.env.example` to `.env` first — or run the interactive setup wizard,
which generates the secrets and walks through Postgres/Redis, the OAuth
provider consoles, the cleanup schedule, and the first staff member:

```bash
bash scripts/setup.sh             # from backend/
```

`JWT_SECRET` and `COOKIE_SECRET` must be at
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

### Token transport

Every endpoint that issues a session sets two `HttpOnly` cookies —
`kauth_session` (the access token, path `/`) and `kauth_refresh` (path
`/refresh`). The tokens appear in the JSON body **only** when the request sends
`X-Token-Response: body`.

Cookies are the default so a browser has no reason to hold a token in
JavaScript, where any XSS can read it. Native and server-to-server clients opt
into body tokens and send `Authorization: Bearer …` as before; when both a
bearer header and a session cookie are present, the header wins.

A browser client must therefore `GET /csrf-token` before its first unsafe
request, because once cookies are set the double-submit check is live.

`SameSite=Lax` assumes the frontend and the API are same-site — `localhost:5173`
→ `localhost:6767`, or `app.example.com` → `api.example.com`. A frontend on a
different registrable domain would need `SameSite=None; Secure`.

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

### Platform staff

Session-authenticated kauth operators (`Role.ADMIN` inside the reserved
platform Project — see `docs/adr/0007-role-claim-rides-database-decides.md`).
Never reachable by API key: a key authenticates as a Project, and the Project
inventory is exactly what a key must never see. The access token carries a
`role` claim, but authorization re-reads the row on every request, so role
changes take effect immediately.

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/admin/projects` | All Projects across tenants. |
| GET | `/admin/projects/:projectId/users` | Any Project's users. |
| GET | `/admin/sessions/:sessionId` | View any Session. |
| DELETE | `/admin/sessions/:sessionId` | Revoke any ACTIVE Session (`staff_revoked`). |
| POST | `/admin/users/:userId/role` | Set `USER`/`ADMIN` on platform users; self-change refused. |

The first staff member is bootstrapped outside HTTP:
`bun scripts/promoteStaff.ts --email dev@example.com`.

### Errors

Every failure returns the same shape:

```json
{ "error": { "message": "Invalid credentials", "code": "auth_failed" } }
```

An access token is checked against its session on every request, so `requireAuth`
distinguishes a token problem from a session problem:

| Code | Meaning |
| ---- | ------- |
| `token_missing` | No bearer header and no session cookie. |
| `token_invalid` | Bad signature, expired JWT, no `sid` claim, or a session that no longer exists. |
| `session_revoked` | The session was revoked — logout, re-login, password change or reset, or reuse detection. |
| `session_expired` | The session outlived its 30-day window. |

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

- [Roadmap](../docs/roadmap.md) — what is done, what is next. Living document.
- [Docs index](../docs/README.md) — the audit and remediation history.
- [Project README](../README.md) — what kauth is and how the auth model works.
