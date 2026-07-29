# kauth — Remediation Log

**Date:** 2026-07-29
**Scope:** the access-token revocation gap and cookie transport
**Follows:** [remediation-2026-07-27.md](./remediation-2026-07-27.md), whose
closing recommendation was exactly this work.

---

## What landed

### 1. Access tokens are bound to their session (audit §4.2)

The previous pass built five revocation paths — logout, re-login on the same
device, password change, password reset, and refresh-token reuse detection — and
none of them did anything to a live access token. `requireAuth` verified the JWT
signature and stopped there, so a revoked credential kept working for the
remainder of its 15-minute life.

- Access tokens now carry a `sid` claim holding the session id.
  `createSession` allocates the session id up front rather than letting the
  database assign it, because the token is minted before the row is inserted.
- `requireAuth` loads the session on every authenticated request and rejects
  anything that is missing, not `ACTIVE`, past `expires_at`, or whose `user_id`
  disagrees with the token's subject. New codes: `session_revoked` and
  `session_expired`.
- A token with no `sid` is refused. Those predate this change and age out in
  fifteen minutes; accepting them would leave the hole open for that window.

This costs one primary-key read per authenticated request. That is the honest
price of revocation actually being revocation, and no cache was added to hide
it — a cache would reintroduce exactly the staleness window being closed here.

**Incidental:** `verifyAccessToken` now pins `algorithms: ["HS256"]`. It
previously trusted the algorithm named in the token header.

### 2. Cookie transport (audit §4.2)

Tokens were returned in the JSON body only, which left a browser client no
storage but `localStorage`, where any XSS reads them.

- `/register`, `/login`, `/refresh`, and `/oauth/exchange` always set two
  `HttpOnly` cookies: `kauth_session` (path `/`, 15 min) and `kauth_refresh`
  (path `/refresh`, 30 days). The refresh cookie is path-scoped so it is not
  attached to every request that only needs the access token.
- The JSON body carries the tokens **only** when the client sends
  `X-Token-Response: body`. Browsers get the safe default and cannot fall into
  `localStorage` by accident; native and server-side clients opt out on purpose.
- `requireAuth` reads the bearer header first and the cookie second. A client
  that sends both has stated its transport, and silently preferring the ambient
  credential would make the effective identity depend on cookie state the caller
  may not know about.
- `/refresh` accepts the token from the body or the cookie.
- Logout clears both cookies. `maxAge` is stripped when clearing, because
  Express turns it back into a future `expires` and the cookie would survive —
  the same trap the OAuth controller already documents.

**CSRF needed no changes.** `requireCsrfToken` was written to enforce on any
request carrying cookies, so it activated on its own the moment sessions started
setting them. The consequence is documented in the backend README: a browser
client must `GET /csrf-token` before its first unsafe request.

**Same-site constraint.** `SameSite=Lax` covers `localhost:5173` →
`localhost:6767` and `app.example.com` → `api.example.com`. A frontend on a
different registrable domain would need `SameSite=None; Secure`. That deployment
does not exist yet, so it is documented rather than made configurable.

### 3. Tests

96 passing, up from 77.

- `tests/sessionRevocation.test.ts` — one test per revocation path asserting the
  access token stops working, plus session-binding cases: a deleted session row,
  a token minted against another user's session, and an expired session. Also
  asserts a second device's session is *not* collaterally revoked.
- `tests/cookieTransport.test.ts` — a small cookie-jar client in
  `tests/helpers/api.ts` stands in for a browser, honouring path scoping and
  dropping cookies the server expires. Covers the full round trip, refresh-cookie
  scoping, bearer precedence, logout clearing, and CSRF activating.
- The existing suites drive the bearer contract, so `api()` sends
  `X-Token-Response: body` by default. That was the only change they needed.

**Mutation-checked.** Disabling the session-status check in `requireAuth` fails
six of the new tests, including all five revocation paths. They are not passing
vacuously.

---

## Still open

The 2026-07-27 list, minus the two rows closed here.

| Gap | Audit ref | Why it matters |
| --- | --- | --- |
| bcrypt cost 10, not Argon2id | §4.3 | Benchmark to 250–400 ms; migrate with rehash-on-login. |
| No breach check, 8-char minimum | §4.3 | NIST-4 wants 15 for single-factor plus an HIBP blocklist check. |
| Registration enumeration, login timing oracle | §4.3 | 409 on duplicate email is still an oracle; login still short-circuits before hashing. |
| `device_id` still client-supplied | §4.2 | Should be server-issued and treated as a risk signal, not an auth decision. |
| No sliding expiry or inactivity timeout | §4.2 | `last_used_at` is written but never read for policy. |
| No MFA, no passkeys | §4.5 | |
| No multi-tenancy, RBAC unenforced | §4.5 | `Role` exists on the user and appears in no token. |
| No token cleanup job | §4.5 | Revoked sessions and consumed tokens accumulate by design. |
| Dockerfile runs as root, no `migrate deploy` | §4.6 | |
| No graceful shutdown, no structured logging | §4.6 | |
| Rate limit store is per-process | §4.3 | Becomes per-instance the moment kauth runs more than one replica. |
| 5 high-severity advisories from `bun audit` | §4.7 | All in dev/build tooling, none in the runtime request path. |
| `csrf_tokens` table is dead schema | §4.5 | CSRF went stateless; the table has never been written to. |

## Suggested next step

Ops, because it is now the only category with nothing done in it: run the
container as non-root, apply `prisma migrate deploy` on start, and add graceful
shutdown. None of it touches the auth contract, so it will not conflict with the
password-hashing work whenever that happens.
