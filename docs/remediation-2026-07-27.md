# kauth — Remediation Log

**Date:** 2026-07-27
**Scope:** audit findings 1, 2, 4, 5, 6
**Product decision:** kauth is a better-auth style auth backend for first-party
applications. "OAuth" means the client role — social login. Becoming an OIDC
provider (audit §5.2) is out of scope.

---

## What landed

### 1. Error contract (audit §4.1)

`errorHandler` was written but never mounted, so every deliberate error fell
through to Express's default handler — HTML responses, and stack traces at
`NODE_ENV=development`.

- Mounted `errorHandler` and a `notFoundHandler` in `app.ts`.
- The handler now normalises `AppError`, `ZodError`, and Prisma errors. P2002
  maps to 409 **without naming the conflicting column**, because on an
  unauthenticated endpoint that is an account-existence oracle.
- `requireAuth` and `requireDevice` were writing a different response shape
  (`{ error: "string" }`) than the controllers. Both now route through the same
  middleware, so every failure is `{ error: { message, code } }`.
- `register` pre-checks username availability; the P2002 mapping is now only the
  race backstop rather than the primary path to a 500.

### 2. Rate limiting (audit §4.3)

`express-rate-limit` was a dependency that nothing imported.

- `middlewares/rateLimit.ts` with per-IP and per-account limiters.
- Login is limited **per account** (8 per 15 min, successful attempts excluded)
  as well as per IP, so a distributed attacker cannot spread a guessing run for
  one account across many source addresses.
- Registration, refresh, recovery, OAuth, and a global limiter are all wired.
- Limiter rejections use the shared error contract.
- `TRUST_PROXY` is now configurable. IP-keyed limits are meaningless behind a
  proxy without it.

> The default store is per-process. These become per-instance limits the moment
> kauth runs more than one replica, and will need a shared store.

### 4. Social login (audit §5.1)

- New `accounts` table, better-auth's canonical shape: one row per way a user
  can authenticate. The credential provider holds the password hash; each OAuth
  provider holds its own subject id and tokens.
- `users.password` is gone. The migration **backfills every existing hash into a
  credential account before dropping the column**.
- `username` is now nullable — social signups have no username until the user
  picks one. Added `email_verified` and `image`.
- Google and GitHub clients via Arctic. Google uses PKCE; GitHub's OAuth app
  flow does not support it, which the provider registry models explicitly.
- `registerOAuthProvider()` is a supported extension point for other providers.
- State and PKCE verifier live in `HttpOnly`, `SameSite=Lax` cookies scoped to
  `/oauth`. Lax rather than Strict is required: the user returns via a top-level
  cross-site navigation, and a Strict cookie would not be sent.

**Account linking policy.** A provider identity links to an existing user only
when the provider vouches for a matching email. An unverified provider email is
refused — otherwise anyone who can set an address at a sloppy provider takes
over the matching kauth account.

**Why the callback hands back a code instead of tokens.** A redirect cannot
carry the `X-Device-Id` header a session needs, and putting session tokens in a
URL leaks them into browser history and referrers. The callback issues a
single-use two-minute code; the frontend `POST`s it to `/oauth/exchange` with
its device id and gets a real token pair.

### 5. The unused half of the schema (audit §4.5)

`csrf_tokens`, `recovery_tokens`, and `security_events` had zero writes.

**Audit log.** `lib/securityEvents.ts` writes `SecurityEvent` rows for
registration, login success and failure (with the reason), logout, refresh,
reuse detection, CSRF failures, untrusted origins, and every email and password
event. Severity is derived from the event type rather than the call site, so a
reuse detection cannot accidentally be logged as INFO. Events can join the
caller's transaction, so a revocation and its audit record commit together.

**Email verification and password reset.** `recovery_tokens` now backs both.
Tokens are 256-bit, stored only as a SHA-256 hash, single-use via a conditional
update, and issuing a new one retires the previous. Recovery endpoints answer
identically whether or not the address exists. A completed reset revokes every
session and marks the email verified — completing it proves mailbox control.

**CSRF.** Implemented as **stateless signed double-submit** plus Origin and
`Sec-Fetch-Site` validation, not via the `csrf_tokens` table. The signature is
what stops an attacker on a sibling subdomain from planting a cookie value of
their own choosing, which is the weakness of naive double-submit. A DB-backed
token would add a query per request for no security gain.

> **Recommendation: drop the `csrf_tokens` table.** It is now dead schema. Left
> in place rather than dropped unilaterally.

The CSRF check is enforced only for requests that carry cookies. A request with
no cookies has no ambient authority to borrow, and bearer tokens cannot be
attached by a cross-site page. This makes the check self-activating when session
cookies are introduced, without breaking today's header-based clients.

### 6. Tests and CI (audit §4.7)

- **77 integration tests** across 6 files, running against real Postgres. The
  suite creates and migrates a `kauth_test` database automatically.
- Coverage: registration, login, refresh rotation, reuse detection, device
  mismatch, logout, rate limiting, the audit log, email verification, password
  reset and change, CSRF, origin validation, and the full OAuth round trip
  against a stub provider.
- The suite was mutation-checked: disabling family revocation on reuse detection
  makes it fail, so it is not passing vacuously.
- GitHub Actions runs typecheck, lint, tests against a Postgres service
  container, and `bun audit`.

---

## Incidental fixes made along the way

These were necessary to make the requested work correct, not separate features.

- **Sessions are revoked, not deleted.** Logout and re-login used
  `deleteMany`, which destroys the rows the audit log references. Both now set
  `status = REVOKED` with a reason.
- **Revoked is no longer confused with reused.** The refresh handler treated any
  non-ACTIVE token as theft. A token *we* revoked (logout, password change) is
  not evidence of theft and must not escalate to family revocation. Only a
  **consumed** token being replayed does.
- **Refresh tokens no longer outlive their session.** A rotation used to mint a
  fresh 30-day token regardless of the session's remaining life.
- **`config.ts` validates with zod** (the file's own TODO). `DATABASE_URL` is
  required rather than falling back to a hardcoded credentialed URL, and
  secrets must be ≥32 characters in production.
- **Password length is capped at 72 bytes** on set/reset/change. bcrypt silently
  truncates past that, so a longer passphrase only appeared stronger.
- **Added `/health`**, a password change endpoint, and `GET /csrf-token`.

---

## Still open

Deliberately not addressed. Finding 3 was excluded from this pass; the rest come
from the audit's other sections.

| Gap | Audit ref | Why it matters |
| --- | --- | --- |
| **Access tokens survive logout** for up to 15 min | §4.2 | `requireAuth` still never loads the session. Revocation is a no-op against a live access token. The single largest remaining hole. |
| bcrypt cost 10, not Argon2id | §4.3 | Benchmark to 250–400 ms; migrate with rehash-on-login. |
| No breach check, 8-char minimum | §4.3 | NIST-4 wants 15 for single-factor plus an HIBP blocklist check. |
| Registration enumeration, login timing oracle | §4.3 | 409 on duplicate email is still an oracle; login still short-circuits before hashing. |
| `device_id` still client-supplied | §4.2 | Should be server-issued and treated as a risk signal, not an auth decision. |
| No cookie transport for sessions | §4.2 | Tokens are still JSON-body only, so browser clients will reach for `localStorage`. |
| No sliding expiry or inactivity timeout | §4.2 | `last_used_at` is written but never read for policy. |
| No MFA, no passkeys | §4.5 | |
| No multi-tenancy, RBAC unenforced | §4.5 | `Role` exists on the user and appears in no token. |
| No token cleanup job | §4.5 | Revoked sessions and consumed tokens now accumulate by design. |
| Dockerfile runs as root, no `migrate deploy` | §4.6 | |
| No graceful shutdown, no structured logging | §4.6 | |
| 5 high-severity advisories from `bun audit` | §4.7 | All in dev/build tooling (eslint, the Prisma CLI's bundled `@prisma/dev`), none in the runtime request path. |

## Suggested next step

Close the access-token revocation gap (§4.2). Embed `sessionId` in the access
token and check session status in `requireAuth`. Every revocation path built in
this pass — logout, password change, password reset, reuse detection — is
currently undermined by that 15-minute window.
