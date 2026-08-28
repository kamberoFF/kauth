# 01 — Backend: generic 202, close the registration duplicate-email oracle

Status: done

**What to build:** `POST /register` stops disclosing whether an email address
already has an account. Every well-formed call that clears the username check
and the password floor returns the **same** response — `202` with a single
generic message, no tokens, no session, no user object, no device id, no MFA
grace field — and the happy path and the duplicate-email path are
byte-identical (same status, same JSON body, same header set) and spend
comparable wall-clock time (both pay exactly one Argon2id hash, both do one
email round-trip).

- **New email:** create the user and its `credential` account (no session),
  issue the `EMAIL_CONFIRMATION` recovery token and send the verification
  link exactly as today, audit `USER_REGISTERED` with `sessionId: null`, and
  emit `EMAIL_CONFIRMATION_SENT`.
- **Existing email:** create nothing; audit a new server-side-only
  `REGISTER_DUPLICATE_EMAIL` event attributed to the existing user; send that
  user a plain "someone tried to sign up with your address — sign in, or reset
  your password" notification carrying no token, no username, no project name;
  never issue a recovery token; never emit `EMAIL_CONFIRMATION_SENT`.
- **Username taken:** still `409 duplicate_username`, checked and returned
  before any email handling, so a request colliding on both gets
  `duplicate_username`. Unchanged by design — usernames are public handles.
- **Password floor:** still `400 password_too_short`, evaluated before the
  email lookup, and identical whether or not the email exists.
- `POST /register` is rate-limited per account (project + email) as well as
  per IP — parity with the recovery endpoints' mailbomb protection — and the
  `429 rate_limited` shape is identical regardless of email existence.
- `POST /register` no longer establishes a device: a call with no device
  header, or a malformed one, succeeds with `202` and sets no `kauth_device`
  cookie. Device identity is established only at `login`.
- MFA grace is no longer stamped at register (it is still stamped at `login`).

Contract-shape changes (the `202`, the dropped fields, the new flow) are what
make this a `0.6.0` change — but the version bump, SDK changes, and ADR are
ticket 02. This ticket ships the server behaviour and its tests.

**Implementation notes (from the spec — `.scratch/register-oracle/spec.md`):**

- Hash the password **unconditionally** after the username check and before
  branching on the email; the duplicate branch discards the result. This is
  the mechanism that guarantees identical CPU and ordering across the two
  branches — do not optimise the discard away.
- `REGISTER_DUPLICATE_EMAIL`: add to the `SecurityEventType` Prisma enum, a
  migration doing `ALTER TYPE ... ADD VALUE IF NOT EXISTS` (the
  `add_role_changed_event` pattern), and a `WARNING` entry in the severity
  map (severity is derived from the type, never passed per call site).
  **Verify the migration folder timestamp sorts after `main`'s latest
  migration before merging** — Prisma stamps wall-clock, not merge order.
- Event IP / user-agent come from `requestContext(req)` now that the handler
  does no device resolution.
- New per-account limiter mirrors the existing recovery limiter (by-account
  key, ~5 per 60 min, its own store namespace, no
  `skipSuccessfulRequests`), sitting behind the existing by-IP register
  limiter in the route.
- New `existingAccountEmail(to)` mail template alongside the existing ones; a
  bare frontend sign-in link is acceptable, nothing token-bearing.
- Test-helper containment (decided with the user): `createOwnedProject` and
  `registerUser` perform register→login internally and keep returning the
  same `{ ..., accessToken, refreshToken }` shape; add a shared
  `registerAndSignIn`-style helper where other files need the sequence.
  `cookieClient`-based browser-contract tests write the two calls inline.
  Only the tests that assert on `/register`'s own contract get rewritten:
  the `POST /register` block, and the "grace stamping at sign-in" block in
  the MFA-mandate suite (move its `mfaGraceEndsAt` assertions to `login`).

**Blocked by:** None — can start immediately

- [x] A fresh-email register returns `202` with body exactly `{ message: <generic string> }` and none of `accessToken` / `refreshToken` / `user` / `deviceId` / `mfaGraceEndsAt`
- [x] Fresh-email register creates a `user` row and one `credential` `account` row, and **no** `sessions` row; `USER_REGISTERED` is recorded with a null session id; `EMAIL_CONFIRMATION_SENT` is recorded; the mailer received a verification email at that address
- [x] A second register on an existing email returns a response with the same status, same JSON body, and same header names as a fresh-email register captured in the same test (transient headers like `Date` / rate-limit counters excepted)
- [x] The duplicate-email branch creates no second `user` row, no `EMAIL_CONFIRMATION` recovery-token row, and emits no `EMAIL_CONFIRMATION_SENT`
- [x] The duplicate-email branch records a `REGISTER_DUPLICATE_EMAIL` event (severity `WARNING`) attributed to the existing user id, and sends `existingAccountEmail` to that address with no token substring and no username substring
- [x] Mutation check: reverting the duplicate-email branch to `409 duplicate_email` makes the byte-identity test fail
- [x] A timing test (relative threshold, warm-up, several samples per side — modelled on the existing login timing test) shows the duplicate-email and fresh-email register paths take comparable wall-clock time
- [x] A request colliding on both username and email returns `409 duplicate_username`; a request with a new username and an existing email returns the generic `202`
- [x] A too-short password returns `400 password_too_short` against both a fresh and an already-registered email
- [x] Six register attempts for one project + email inside the window end with `429 rate_limited` (shared error contract body); a different email in the same project, and the same email in a different project, are unaffected
- [x] Mutation check: removing the per-account limiter from the route makes the rate-limit test fail
- [x] Register with no `x-device-id`, and register with a malformed `x-device-id`, both return `202`; no `kauth_device` cookie is set; the old register device tests asserting the opposite are removed
- [x] `createOwnedProject` / `registerUser` and any dependent suites are updated so `bun test`, `bun run typecheck`, and `bun run lint` are all green
- [x] The MFA-mandate "grace stamping at sign-in" assertions are moved to the `login` response and pass
