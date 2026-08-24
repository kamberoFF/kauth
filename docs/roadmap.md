# Roadmap

**Living document.** Unlike the dated audit and remediation logs, this file is
kept current — if it disagrees with the code, the file is wrong.

Last reviewed: 2026-08-24.

**Multi-tenancy pivot in progress.** As of 2026-08-22 kauth is being extended
into a self-hosted, multi-tenant auth platform — see
`.scratch/clerk-clone/map.md` and its `clerk-clone-foundation` tickets.
Tickets 01–04 (the `Project` entity, project-scoping across the full auth
surface, developer-facing auth bootstrap, and per-project API key issuance)
are done and merged, plus a same-day gap-closing ticket on audit-log
project scoping and OAuth validation hygiene; the item below still applies
to everything built *before* this pivot started, and multi-tenancy itself is
no longer "deliberately last" — see the map's reconciliation note for why
schema work went ahead of the rest of this backlog. Tickets 05/06 (the SDK
packages) are next in the tracker's dependency graph; the "Before starting
the SDK" gate below was satisfied on 2026-08-24 by the ops-hardening tickets
(structured logging, migrate-on-startup/graceful shutdown, liveness-readiness
split, non-root container, cleanup job).

It replaces the five-phase hardening plan that used to live in `backend/docs/`.
That plan was written in June 2026, before any of it was built; the parts that
have since been implemented are recorded in the remediation logs, and what
remained useful has been folded in below.

## Done

Enough context to read the rest of this file.

- **Sessions** — server-owned, revocable, with device and IP metadata. Access
  tokens carry a `sid` claim and are checked against the session row on every
  request, so revocation is immediate.
- **Refresh** — opaque `selector.verifier` credentials, verifier stored only as
  a hash, one-time-use with rotation, family tracking, and reuse detection that
  revokes the family. A server-initiated revocation is correctly distinguished
  from theft.
- **Transport** — `HttpOnly` cookies by default, body tokens on explicit
  opt-in, bearer taking precedence over cookie.
- **Social login** — Google and GitHub via arctic, an `accounts` table in the
  better-auth shape, email-verified linking policy, code-based callback
  exchange, and a registration hook for further providers.
- **Recovery** — email verification and password reset on single-use hashed
  tokens; a completed reset revokes every session.
- **Abuse controls** — per-IP and per-account rate limits, stateless signed
  double-submit CSRF, trusted-origin validation.
- **Audit log** — `security_events` written for every auth-relevant transition,
  with severity derived from the event type rather than the call site.
- **Verification** — 96 integration tests against real Postgres covering abuse
  cases (reuse, revoked-session access, throttling, device mismatch, CSRF), run
  in CI alongside typecheck, lint, and `bun audit`.

## Next

Ordered by what unblocks or protects the most.

### 1. Operations — done 2026-08-24

Shipped as the `ops-hardening` tickets: non-root container with a liveness
healthcheck, migrate-on-startup with bounded graceful shutdown, structured
logging with request/user/session correlation, liveness/readiness split, and
the coordinated session/audit cleanup job (ADR 0004).

### 2. Password hashing

- Move to Argon2id, benchmarked to 250–400 ms on the deployment target.
- Migrate transparently by rehashing on successful login.
- Raise the minimum length toward NIST-4's 15 characters for single-factor, and
  add an HIBP breach check. The 72-byte cap can go once bcrypt does.

### 3. Close the identity oracles — login timing closed 2026-08-24

- ~~Login short-circuits before hashing when the user is unknown, so response
  timing distinguishes the two cases.~~ **Done 2026-08-24** — every login now
  runs exactly one comparison against a dummy hash when no stored credential
  exists (`backend/lib/passwords.ts`).
- Registration returns 409 on a duplicate email, which tells an
  unauthenticated caller whether an account exists. **Deferred as accepted
  residual risk** — fully closing it requires register to stop auto-logging-in
  (a duplicate-email caller cannot receive tokens indistinguishable from the
  happy path), a register-contract change frozen behind ADR 0003's
  `X-Kauth-Contract-Version`. Revisit only by explicitly re-deciding that
  contract question. The `duplicate_username` 409 is not an oracle: usernames
  are user-chosen public handles. See `.scratch/identity-oracles/`.

### 4. Session policy

- Make `device_id` server-issued. Today the client supplies it, so it is a risk
  signal being used as an auth decision.
- Add sliding expiry and an inactivity timeout. `last_used_at` is written on
  every refresh and never read for policy.

### 5. Multi-instance readiness

- The rate limiter's default store is per-process, so every limit becomes
  per-replica the moment kauth runs more than once. Needs a shared store.

### 6. Features

Deliberately last: none of them are worth building on a foundation that still
has the items above open.

- MFA (TOTP) and passkeys.
- RBAC enforcement. `Role` exists on the user, appears in no token, and gates
  nothing.
- Multi-tenancy.
- Asymmetric access-token signing with `kid` and a key-rotation policy, if other
  services ever need to verify tokens without sharing the secret.

## Before starting the SDK

The SDK is the reason the contract has to settle first — a public wrapper turns
today's mistakes into permanent ones. Start it when all of these hold:

- Session rotation and revocation rules are stable. **Done.**
- Token transport is final for the supported client types. **Done.**
- Core auth events are observable. **Done** — structured request logging with
  request/user/session correlation landed 2026-08-24 alongside the existing
  audit log.
- Integration tests protect the main flows. **Done.**
- The response and error contract is versioned and consistent. Decision done
  2026-08-23 (ADR 0003: `X-Kauth-Contract-Version`, exact-match SDK
  enforcement, no multi-version hosting). The header itself and the SDK-side
  check are built with tickets 05/06, since the SDKs are what enforce it.

So: the gate is met as of the ops-hardening work (2026-08-24). Tickets 05/06
are unblocked.

~~Operations hardening (section "1. Operations" above) still hasn't happened,
so it remains a real, deliberate blocker on 05 and 06 beyond what the ticket
tracker shows, not a stale leftover from before the pivot.~~ Resolved
2026-08-24 — see section "1. Operations".
Revisit only by explicitly re-deciding this, not by treating "04 is done" as
sufficient.

## Deliberately not doing

- **Becoming an OIDC provider.** kauth authenticates users for first-party
  apps; it is not an identity provider other applications integrate against.
  This is a product decision, not a backlog item.
- **A DB-backed CSRF token.** The `csrf_tokens` table is dead schema — the
  stateless signed approach is no weaker and costs no query. The table should be
  dropped.
- **Caching the session lookup in `requireAuth`.** A cache reintroduces exactly
  the staleness window that binding tokens to sessions closed. Revisit only if
  profiling shows a real problem.
