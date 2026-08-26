# kauth

Self-hosted auth backend for first-party apps. Bun + Express 4 + Prisma 7 +
PostgreSQL 17. See [README.md](README.md) for what it is and
[docs/roadmap.md](docs/roadmap.md) for current state — that roadmap is the
living document, the dated files in `docs/` are history.

## Commands

Run from `backend/`.

```bash
bun run dev                      # watch mode on :6767
bun test                         # integration tests, real Postgres
bun run typecheck                # tsc --noEmit
bun run lint                     # eslint
docker compose up -d db redis    # Postgres on :5433, Redis on :6379 — required for tests
bunx --bun prisma migrate deploy
```

Tests create and migrate `kauth_test` themselves; the dev container is the only
prerequisite. There is no unit-test tier — every test is an integration test
against a real database, by design for this kind of service.

Prettier reports most files as unformatted on a Windows checkout. That is CRLF,
not real drift — the same files check clean through git, and CI does not run a
format check. Do not reformat the repo to "fix" it.

## Layout

```
backend/
  app.ts             middleware chain and route mounting
  config.ts          zod-validated env; fails fast on unsafe production values
  controllers/       auth, account, oauth — request handling and transactions
  routes/            thin; middleware composition per endpoint
  middlewares/       auth, csrf, device, origin, rateLimit, error
  lib/               sessions, jwt, tokenTransport, securityEvents,
                     recoveryTokens, passwords, mail, logger,
                     platformProject, validation, oauth/providers
  prisma/            schema + migrations
  tests/             integration suites; helpers/api.ts has the request helpers
frontend/            Vite + React scaffold, no auth client yet
packages/            SDK packages, one distribution artifact each
  backend-sdk/       server-only, secret-key-scoped; enforces the contract
                     version header (ADR 0003)
docs/                roadmap (living) + audit and remediation logs (historical)
```

## Conventions

- **Snake_case in the database, camelCase in TypeScript.** Prisma models map
  explicitly (`@@map("sessions")`); do not "fix" the mismatch.
- **The Prisma client is generated to `backend/generated/prisma`**, not
  `node_modules`. Import types from `../generated/prisma/client`.
- **Errors** go through `appError(status, message, code)` and surface as
  `{ error: { message, code } }`. Never respond with a different shape;
  `middlewares/error.ts` is the only place that writes an error body.
- **Every auth-relevant transition writes a `SecurityEvent`** via
  `recordSecurityEvent` (joins your transaction) or `tryRecordSecurityEvent`
  (swallows failures). Severity is derived from the event type — do not pass it
  per call site. Never put tokens, hashes, or credentials in `metadata`.
- **Sessions are revoked, never deleted** — with one deliberate exception:
  the cleanup job (`scripts/cleanup.ts`, ADR 0004) deletes long-past-retention
  sessions only after no audit event still references them. The audit log
  references those rows.
- **Express 4, not 5.** A rejected promise from a middleware is *not* forwarded
  to the error handler — async middleware needs `try/catch` with `next(error)`.
- **`res.clearCookie` needs the same `path` and no `maxAge`.** Express turns
  `maxAge` back into a future `expires`, so the cookie survives. See
  `lib/tokenTransport.ts` and `readAndClearCookie` in `controllers/oauth.ts`.
- **Rate-limit key generators that touch `req.ip` must call `ipKeyGenerator` in
  their own body** — express-rate-limit inspects the function source to detect
  IPv6 bypasses.

## Things that look wrong but are deliberate

Check here before "fixing" one of these.

- **`requireAuth` hits the database on every request.** That is the point:
  access tokens carry a `sid` claim and the session row decides whether they
  still count. Caching it would reintroduce the revocation window this closed.
- **A revoked refresh token is not treated as reuse.** Only replaying a
  *consumed* token is theft and revokes the family. A token the server revoked
  (logout, password change) must not escalate.
- **CSRF enforces only on requests carrying cookies.** A cookie-less request has
  no ambient authority to borrow, and this makes the check self-activating.
- **P2002 maps to 409 without naming the column.** On an unauthenticated
  endpoint that would be an account-existence oracle.
- **The OAuth callback returns a code, not tokens.** A redirect cannot carry
  `X-Device-Id`, and tokens in a URL leak into history and referrers.
- **OAuth state cookies are `SameSite=Lax`, not `Strict`.** The user returns via
  a top-level cross-site navigation; a strict cookie would not be sent.

## Writing tests

Follow the existing idiom in `backend/tests/`: `beforeAll(startTestServer)`,
`beforeEach(resetDatabase)`, and the `api()` helper, which sends the device
header and opts into body tokens. Use `cookieClient()` when testing the browser
contract — it is a small cookie jar with path scoping, since `fetch` has none.

Assert on the error *code*, not the message. Test abuse paths, not just the
happy path: reuse, revoked-session access, device mismatch, throttling.

**Mutation-check any test guarding a security property** — break the control
deliberately and confirm the test fails. A revocation test that passes without
the fix is worse than no test.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Decision profiles

Per-person decision profiles live in the gitignored `.profiles/<os-username>.md`.
Before making discretionary decisions autonomously (unattended or full-auto
runs), read `.profiles/$USERNAME.md` if it exists and apply its precedence
rules. The shared decision record (`CONTEXT.md`, `docs/adr/`) always
outranks a personal profile; conflicts go to a human, never get resolved by
the profile.
