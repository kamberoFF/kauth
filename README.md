# kauth

A self-hosted authentication backend for first-party applications — the kind of
service you run yourself instead of reaching for Auth0 or Clerk. Email and
password credentials, Google and GitHub sign-in, server-owned sessions with
rotating refresh tokens, and an audit log of everything security-relevant.

"OAuth" here means the **client** role: kauth signs users in *via* Google and
GitHub. Becoming an OIDC provider that other applications authenticate against
is explicitly out of scope.

## Status

The backend is real and tested; the frontend is a scaffold.

| | |
| --- | --- |
| **Works today** | Multi-tenant projects with per-project isolation, registration, login, logout, refresh rotation with reuse detection, social login, email verification, password reset and change, TOTP MFA with backup codes and two-phase login (plus an optional per-project mandate), server-issued device identity, sliding session expiry with an inactivity timeout, Argon2id password hashing with a per-project password policy, a platform-staff surface behind DB-fresh RBAC enforcement, CSRF, rate limiting backed by a shared Redis store for multi-replica deployments, audit log, structured logging, migrate-on-startup with graceful shutdown, liveness/readiness split, a non-root production container, and a coordinated session/audit cleanup job. Backend and client SDK packages ship alongside the service. 395 integration tests against real Postgres, gated by CI. |
| **Not built yet** | Passkeys and asymmetric access-token signing (`kid` + rotation) — the last two roadmap features. Per-project tenant-admin roles are deferred until a consuming app names its requirements. |
| **Known weaknesses** | Registration's 409 on a duplicate email discloses account existence — accepted residual risk, frozen behind the versioned contract. |

The full list, with reasoning, is in [docs/roadmap.md](docs/roadmap.md).

This is a portfolio-grade project being built to production standards, not a
service currently carrying production traffic. The documentation says what is
missing as plainly as what works — that honesty is part of the point.

## Layout

```
backend/     Bun + Express 4 + Prisma 7 + PostgreSQL 17 — the actual service
frontend/    Vite + React 19 + Tailwind 4 — scaffold only, no auth client yet
packages/    backend-sdk (secret-key, server-only) and client-sdk (publishable-key)
docs/        Audit, remediation history, roadmap
```

## Quickstart

Requires [Bun](https://bun.sh) 1.3+ and Docker.

```bash
cd backend
cp .env.example .env
bun install
docker compose up -d db          # Postgres on :5433
bunx --bun prisma migrate deploy
bun run dev                      # http://localhost:6767
```

`JWT_SECRET` and `COOKIE_SECRET` must be at least 32 characters in production;
the app refuses to start otherwise.

```bash
bun test          # integration tests; creates and migrates kauth_test itself
bun run typecheck
bun run lint
```

See [backend/README.md](backend/README.md) for the API surface, the token
transport contract, and the error codes.

## How authentication works

Worth understanding before reading the code, because a few of the choices are
deliberate and look odd otherwise.

**Sessions are the source of truth, not tokens.** A 15-minute access token
carries a `sid` claim naming its session row, and every authenticated request
checks that row's status. This costs one primary-key read per request and buys
revocation that is actually immediate: logout, a password change, or reuse
detection kills the token now rather than up to 15 minutes from now.

**Refresh tokens are opaque, one-time-use, and family-tracked.** Each is a
`selector.verifier` pair; only a hash of the verifier is stored. Every use
rotates it. Replaying a *consumed* token is treated as theft and revokes the
whole family — but a token the server itself revoked (logout, password change)
is not theft and does not escalate.

**Cookies by default, bearer on request.** Endpoints that issue a session set
`HttpOnly` cookies, and return tokens in the JSON body only when the client
sends `X-Token-Response: body`. A browser therefore has no reason to keep a
token anywhere JavaScript can read it; native and server-side clients opt out
deliberately.

**CSRF is stateless signed double-submit**, plus `Origin` and `Sec-Fetch-Site`
validation. The signature is what defeats a subdomain attacker planting a cookie
of their own choosing, which is the flaw in naive double-submit. It enforces
only on requests that carry cookies, since a cookie-less request has no ambient
authority to borrow.

**A social login links to an existing account only when the provider vouches
for a matching, verified email.** Otherwise anyone who can set an address at a
careless provider could take over the matching kauth account.

**The OAuth callback returns a short-lived code, not tokens.** A redirect cannot
carry the `X-Device-Id` header a session needs, and tokens in a URL leak into
history and referrers. The frontend trades the code at `/oauth/exchange`.

## Documentation

- [backend/README.md](backend/README.md) — API surface, transport, error codes,
  adding an OAuth provider.
- [docs/roadmap.md](docs/roadmap.md) — what is left, in priority order.
- [docs/README.md](docs/README.md) — index of the audit and remediation history.
