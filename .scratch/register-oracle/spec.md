Status: ready-for-agent

# kauth Register — drop auto-login, close the duplicate-email identity oracle

Collapsed from the deferred-closeout batch's session-1 grilling
(`/grill-with-docs`, frontier cleared over three rounds, 2026-08-28). The
settled design lives in `.scratch/deferred-closeout/plan.md` under "Session 1
grilling outcome → Register drops auto-login (contract → 0.6.0)"; this spec is
the buildable synthesis. This is the **second** epic-1 ticket set — it lands
after the mailer-posture work (already shipped, `bf6299d` / `5ec0b4b`) and it
is the **only** part of epic 1 with contract impact: the contract version
bumps to **0.6.0** here.

## Problem Statement

`POST /register` is an unauthenticated endpoint that tells any caller whether
an email address already has an account:

- A fresh email returns `201` with a token pair and a user object.
- An email that is already registered returns `409 { code: "duplicate_email" }`.

An attacker who wants to know "does alice@example.com have an account on this
instance" just calls register and reads the status code. This is the last of
the identity oracles the roadmap has been closing (login timing was closed
2026-08-24); it was **deferred** at the time because fully closing it means
register can no longer hand back a session — a duplicate-email caller must get
a response indistinguishable from a successful signup, and that is a breaking
change to the register contract that ADR 0003 froze behind
`X-Kauth-Contract-Version`. The re-decision has now been made (plan's locked
decision 2): register drops auto-login.

The `duplicate_username` `409` is **not** part of this problem. Usernames are
user-chosen public handles; a collision on one discloses nothing about anyone's
email address. It stays exactly as it is.

## Solution

`POST /register` becomes a fire-and-forget request that never reveals whether
the email was already taken:

- Every well-formed register call that clears the username check and the
  password floor returns the **same** response: `202` with a single generic
  message, no tokens, no session, no user object, no device id, no MFA grace
  field. The happy path and the duplicate-email path are **byte-identical** —
  same status, same JSON body, same header set — and both do exactly one email
  round-trip and pay exactly one Argon2id hash, so response timing cannot
  separate them either.
- On a genuinely new email, kauth creates the user and its credential account
  (no session), sends the email-confirmation link as it does today, and audits
  `USER_REGISTERED`.
- On an email that already exists, kauth creates nothing, audits a new
  server-side-only `REGISTER_DUPLICATE_EMAIL` event, and sends the existing
  account holder a plain "someone tried to sign up with your address — sign in,
  or reset your password" notification that carries no token, no username, and
  no project name.
- Clients call `login` after `register`. The SDKs learn the new flow:
  `client.signUp` resolves to `void` and no longer signs the user in.
- Username-taken still short-circuits to `409 duplicate_username` before any of
  the email handling, and stays an oracle-free disclosure by design.

A breaking contract change: contract version → `0.6.0`, both SDKs redeploy,
`backend/package.json` and both SDK `package.json` / `version.ts` bump in
lockstep. ADR 0008 records the re-decision and its consequences.

## User Stories

1. As a user of an app built on kauth, I want an attacker who submits my email
   to the register endpoint to be unable to tell from the response whether I
   already have an account, so that my membership on the instance is not
   enumerable.
2. As a user who already has an account, I want a second registration attempt
   on my email to get the same response as a brand-new signup, so that neither
   the status code nor the body nor the timing leaks my existence.
3. As a user who already has an account, I want to be emailed when someone
   tries to register my address, so that I know it happened and can act if it
   was not me.
4. As a user who already has an account, I want that notification email to
   contain no verification token, no reset token, no username, and no project
   name, so that the email itself cannot be used to confirm anything or to
   phish me with real-looking details.
5. As a user who already has an account, I want the notification to point me at
   signing in or resetting my password, so that the message is actionable
   without disclosing who triggered it.
6. As a new user, I want registration to still create my account and send my
   confirmation link, so that the flow is unchanged from my side apart from
   having to sign in afterward.
7. As a new user, I want registration to no longer log me in automatically, so
   that... (accepted DX cost — see story 20; stated here for completeness of
   the contract).
8. As a developer integrating the client SDK, I want `signUp` to resolve
   without a session and my code to call `signIn` next, so that the two-step
   flow is explicit and matches what the platform now does.
9. As a developer integrating the client SDK, I want a duplicate-email `signUp`
   to resolve successfully rather than throw, so that my error handling does
   not depend on an oracle the platform deliberately removed.
10. As a developer integrating the client SDK, I want `signUp` to still throw
    on `duplicate_username` and `validation`, so that the genuinely
    caller-fixable input errors still surface.
11. As a developer, I want `useSession().user` to stay `null` after `signUp`
    (the field kept for a future `/me`), so that the hook's shape does not
    churn again when profile fetching lands.
12. As a developer integrating the backend SDK, I want its contract-version
    constant and package version bumped to `0.6.0` with a changelog entry, so
    that my coordinated redeploy (ADR 0003) has a single obvious version to
    align on, even though the backend SDK has no register method.
13. As an operator, I want a register attempt on an existing email to leave a
    `REGISTER_DUPLICATE_EMAIL` audit row attributed to the existing user, so
    that repeated attempts on one address are visible in the security log.
14. As an operator, I want that event to never carry a token or credential in
    its metadata, so that the audit log stays safe to expose to tenant admins
    (the tenant-RBAC epic).
15. As an operator, I want a register attempt on an existing email to **not**
    emit `EMAIL_CONFIRMATION_SENT`, so that the audit log does not itself
    become the oracle the response no longer is.
16. As an operator, I want `/register` rate-limited per account (project +
    email) as well as per IP, so that an attacker cannot mailbomb a known
    address — either the victim's confirmation-less notification or, on a
    typo'd fresh address, a confirmation link — from many source addresses, the
    same protection the recovery endpoints already have.
17. As an attacker, I want the per-account register limiter to give me the
    same `429 rate_limited` shape whether or not the email exists, so that the
    limiter does not reintroduce the oracle.
18. As a user, I want a register call with a too-short password to still fail
    fast with `400 password_too_short`, evaluated before the email is looked
    up, so that the password rule is enforced without the response depending
    on whether the account exists.
19. As a user, I want a register call whose username is taken to fail with
    `409 duplicate_username` before any email handling, so that the common
    "pick another handle" case still gets a specific, immediate answer.
20. As a maintainer, I want ADR 0008 to record that this re-opens and
    re-decides the ADR-0003-frozen register contract, the breaking-change
    consequence (coordinated redeploy, both SDKs), the weaker DX (no
    auto-login, `user` null until `/me`), that device identity is now
    established only at `login`, and that `duplicate_username` deliberately
    stays, so that a future session does not re-litigate it from scratch.
21. As a maintainer, I want the byte-identity of the two register branches
    covered by a test that fails if the duplicate-email branch is reverted to
    `409`, so that a refactor cannot quietly reopen the oracle.
22. As a maintainer, I want a timing test asserting the two branches spend
    comparable wall-clock time, modelled on the existing login timing test, so
    that the "both pay one hash, both send one email" property is guarded.
23. As a developer, I want the register endpoint to no longer run
    `resolveDevice`, so that a register call with no device header, or a
    malformed one, is no longer rejected or issued a `kauth_device` cookie —
    there is no session to bind a device to until `login`.
24. As a developer reading `docs/roadmap.md`, I want section 3 ("Close the
    identity oracles") updated to record the registration oracle as closed, so
    that the roadmap reflects reality.
25. As a maintainer, I want the existing register/session tests and helpers
    that assumed `201 + tokens` rewritten so the suite still builds a
    logged-in user where it needs one (register then login), so that the
    behavioural change is absorbed in one place rather than scattered.

## Implementation Decisions

### The register controller (`controllers/auth.ts` → `register`)

New control flow, in order:

1. `registerSchema.safeParse` — unchanged. `400 validation` on shape failure.
2. Resolve the Project's password floor (`projectPasswordFloor`, a
   project-row read — not an account lookup) and return
   `400 password_too_short` if the password is under it. Stays here, ahead of
   any uniqueness lookup, so the password rule never depends on account
   existence.
3. Look up existing email and existing username (the current parallel
   `Promise.all` is fine to keep).
4. If the **username** is taken → `409 duplicate_username`. This is checked and
   returned before anything email-related, tokens included, so the ordering is
   observable: a request that collides on *both* username and email gets
   `duplicate_username`.
5. Hash the password (`hashPassword`) unconditionally from this point — both
   downstream branches pay it, which is what makes their timing match. (The
   `duplicate_username` branch above deliberately short-circuits before the
   hash; username existence is not a protected fact.)
6. Branch on whether the **email** exists:
   - **New email (happy path).** One transaction: create the `user`, create the
     `credential` `account` with the password hash. **No `createSession`, no
     `stampMfaGrace`.** Record `USER_REGISTERED` inside the transaction with
     `sessionId: null` (metadata keeps `{ provider: "credential" }`). After
     the transaction: `issueRecoveryToken(user.id, "EMAIL_CONFIRMATION",
     projectId)`, `sendMail(verificationEmail(...))`, and
     `tryRecordSecurityEvent({ type: "EMAIL_CONFIRMATION_SENT", ... })` —
     all exactly as today.
   - **Existing email.** Create nothing. `tryRecordSecurityEvent({ type:
     "REGISTER_DUPLICATE_EMAIL", userId: <existing user id>, projectId, ip,
     userAgent })` — server-side only, never surfaced. `sendMail(
     existingAccountEmail(email))`. **Never** issue a recovery token, **never**
     emit `EMAIL_CONFIRMATION_SENT`.
7. Both branches end with the identical response:
   `res.status(202).json({ message: "If that address is valid, we've sent a confirmation email." })`.
   No `sendAuthResponse`, no cookies, no tokens, no `user`, no `deviceId`, no
   `mfaGraceEndsAt`.

Event IP / user-agent come from `requestContext(req)` (`lib/securityEvents.ts`)
now that there is no `clientContext` / device resolution in this handler.

The password-hash cost on the duplicate branch: hashing unconditionally at
step 5 and discarding the result on the duplicate branch is the intended
mechanism — it guarantees identical CPU and ordering without a second code
path. Do not "optimise" the discard away.

### Route (`routes/auth.ts`)

`POST /register` middleware chain becomes:

```
resolveProjectFromKeyOrHeader, registerLimiter, registerAccountLimiter, register
```

- **`resolveDevice` is removed.** Register no longer establishes a device.
- **`registerAccountLimiter` is new** (see below), sitting behind the existing
  by-IP `registerLimiter`.

### Rate limiting (`middlewares/rateLimit.ts`)

New limiter, mirroring `recoveryLimiter` (the existing per-account
mailbomb guard):

```ts
export const registerAccountLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 5,
  storePrefix: "register-account",
  keyGenerator: byAccount,
});
```

No `skipSuccessfulRequests` — every attempt counts, because a successful
attempt is exactly the one that sends mail. `byAccount` already falls back to
an IP key when `req.body.email` / `req.projectId` is absent, and already
namespaces by project id, so identical emails in two projects never share a
bucket. The `429 rate_limited` shape is identical regardless of whether the
email exists (the limiter runs before the controller), so it is not an oracle.

### New `REGISTER_DUPLICATE_EMAIL` security event

- **Prisma enum** — add `REGISTER_DUPLICATE_EMAIL` to `SecurityEventType` in
  `prisma/schema.prisma`.
- **Migration** — a new migration doing
  `ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'REGISTER_DUPLICATE_EMAIL';`
  (the pattern of `20260826100000_add_role_changed_event`). **Check its
  timestamp sorts after `main`'s latest migration** before merging — Prisma
  stamps wall-clock time, which has bitten this repo before (see the
  ticket-02 note in the wayfinder memory).
- **Severity** — add `REGISTER_DUPLICATE_EMAIL: SecurityEventSeverity.WARNING`
  to the `SEVERITY` map in `lib/securityEvents.ts`. It is derived from the
  type, never passed per call site.
- Metadata carries no token, hash, or credential — identifiers only (the
  `userId` column already attributes it to the existing account).

### New mail template (`lib/mail.ts`)

```ts
export function existingAccountEmail(to: string): Mail
```

- Subject: something like "Someone tried to sign up with your email".
- Body: plain prose — an account already exists for this address; if it was
  you, sign in, or reset your password if you have forgotten it; if it was not
  you, you can ignore this message. A bare `${config.frontend_url}/login` link
  is acceptable (it carries nothing sensitive); **no token, no username, no
  project name, no "who tried"**.
- Goes through the same best-effort `sendMail`. Delivery failure must not
  change the `202`.

### SDKs

**`packages/client-sdk`** (`src/index.ts`, `src/version.ts`, `package.json`,
`README.md`):

- `signUp(input: SignUpInput): Promise<void>`. It calls `POST /register`, and
  on success simply resolves — **no `setState`, no `captureDeviceId`, no state
  transition.** The store stays `signedOut`.
- Delete the `SignUpResult` interface. Keep `SignUpInput`.
- The `KauthClient.signUp` doc comment: registers the user under the
  publishable key's project; the caller must call `signIn` next; throws
  `duplicate_username` / `validation`; **a duplicate email resolves
  successfully without creating a second account — indistinguishable by
  design (ADR 0008)**.
- `useSession().user` stays `null` after `signUp`. The `user` field on
  `UseSessionResult` / `SessionState` is kept (a future `/me` fills it).
- `CONTRACT_VERSION` → `"0.6.0"`; `package.json` version → `0.6.0`.
- README example becomes register-then-`signIn`.

**`packages/backend-sdk`** (`src/version.ts`, `package.json`, changelog):

- `CONTRACT_VERSION` → `"0.6.0"`; `package.json` version → `0.6.0`; changelog
  entry noting the coordinated bump. No API change — it has no register method.

**`backend/package.json`** version → `0.6.0`. `config.contract_version` reads
it, so the `X-Kauth-Contract-Version` response header follows automatically.
`contractVersion.test.ts` already asserts all three stay in lockstep.

### ADR 0008 — `register-drops-auto-login`

`docs/adr/0008-register-drops-auto-login.md`. Records:

- The decision: `/register` returns a generic `202` with no session; clients
  call `login` after.
- That this **re-opens and re-decides** the register contract ADR 0003 froze,
  and why (the roadmap's "accepted residual risk" on the registration oracle
  is now paid down).
- Consequences: breaking change → coordinated-redeploy event (ADR 0003);
  both SDKs redeploy; weaker DX (no auto-login; `useSession().user` is `null`
  until a `/me` endpoint exists); `signUp` can no longer surface
  `duplicate_email` because the server no longer returns it.
- That **device identity is now established only at `login`** — `/register`
  runs no `resolveDevice` and issues no `kauth_device` cookie.
- That `duplicate_username` deliberately stays a `409`: usernames are public
  handles, not a membership oracle.
- Non-goal: `signUp` does not internally chain to `signIn` — a duplicate email
  with a *different* password would throw `auth_failed` on the chained call and
  reopen the very oracle this closes.

### Explicitly unchanged

- OAuth code exchange, `POST /send-verification-email`, `POST /login`
  (grace is still stamped there), refresh, logout.
- `registerSchema` — still shape-only; `first_name` / `last_name` still
  accepted and stored on the happy path.
- `stampMfaGrace` itself and its use at `login` / OAuth exchange / MFA
  challenge completion.

## Testing Decisions

A good test here asserts **observable external behaviour**: HTTP status, the
exact response body, the response header set, rows in `users` / `sessions` /
`security_events`, the contents of the in-memory mailer, and wall-clock
timing. Not: private controller structure, or which internal function hashed
what.

### Seams

1. **`POST /register` over HTTP**, driven through the existing `api()` and
   `cookieClient()` helpers in `backend/tests/`. This is the highest seam and
   no new one is added on the backend.
2. **`client.signUp()`** in `packages/client-sdk`, exercised by the existing
   real-HTTP `clientSdk.test.ts` against the test server.

### Test-helper containment (decided with the user)

The helpers absorb the change so the ~250 call sites that just want "a
logged-in user in a project" do not each change:

- `tests/helpers/api.ts` — `createOwnedProject` performs `register` **then**
  `login` internally and keeps returning `{ project, developer: { userId,
  accessToken } }`. Add a shared helper (e.g. `registerAndSignIn`) for the
  same register→login sequence where other files need it.
- `auth.test.ts` — `registerUser()` becomes register→login and keeps
  returning the login response shape (`body.accessToken` / `body.refreshToken`
  / a user id obtained from the register step or a DB read).
- `cookieTransport.test.ts` / `csrf.test.ts` — these are specifically about
  the browser contract, so the two-call sequence (`register`, then `login`
  through `cookieClient`) is written inline rather than hidden.

Only the tests that assert on `/register`'s **own** contract get deliberately
rewritten: the `POST /register` describe block in `auth.test.ts`, the `signUp`
describe block in `clientSdk.test.ts`, and the "grace stamping at sign-in"
block in `mfaMandate.test.ts` (which currently reads `mfaGraceEndsAt` off the
register response — move those assertions to `login`).

### Backend cases (new / rewritten in `auth.test.ts`, plus a focused file if cleaner)

- **Generic success shape.** A fresh-email register → `202`, body is exactly
  `{ message: <the generic string> }`, no `accessToken` / `refreshToken` /
  `user` / `deviceId` / `mfaGraceEndsAt` keys. A `user` row and one
  `credential` `account` row exist; **no `sessions` row**. A `USER_REGISTERED`
  event exists with `session_id` null. An `EMAIL_CONFIRMATION_SENT` event
  exists. The in-memory mailer received a verification email at that address.
- **Duplicate-email branch — byte identity.** Register `alice@…`; then
  register `alice@…` again with a different username. Assert the second
  response has the **same status, same JSON body, and same header names** as a
  fresh-email register captured in the same test (allow `Date` /
  rate-limit-counter headers to differ). No second `user` row. **No**
  `EMAIL_CONFIRMATION_SENT` event. A `REGISTER_DUPLICATE_EMAIL` event exists
  (severity `WARNING`, attributed to the existing user id). The mailer
  received the `existingAccountEmail` (assert on its subject/body — no token
  substring, no username substring). No `EMAIL_CONFIRMATION` recovery-token
  row created.
  - **Mutation check:** revert the duplicate-email branch to
    `409 duplicate_email`; this test must fail.
- **Timing parity.** Modelled on `auth.test.ts`'s "spends comparable time on
  an unknown account as on a bad password" (relative threshold, warm-up call,
  a few samples each side): a duplicate-email register and a fresh-email
  register take comparable wall-clock time.
- **Username checked first.** Register `alice` / `alice@…`; then register
  `alice` (same username) / `bob@…` (new email) → `409 duplicate_username`.
  Then register `carol` (new username) / `alice@…` (existing email) → `202`
  generic. Proves the ordering and that only username collision is a `409`.
- **Password floor still fast-fails.** Too-short password → `400
  password_too_short`, and it fires whether or not the email exists (run it
  once against a fresh email and once against a registered one — same
  response).
- **Per-account rate limit.** In `rateLimit.test.ts` (which flips
  `setRateLimitingEnabled(true)`): 6 register attempts for the same project +
  email inside the window → the last is `429 rate_limited`; the shared error
  contract body. A different email in the same project is unaffected; the same
  email in a different project is unaffected (parity with the existing
  login-limiter tests). **Mutation check:** remove `registerAccountLimiter`
  from the route — this test must fail.
- **No device coupling.** Register with **no** `x-device-id` header → `202`
  (no longer rejected); no `kauth_device` cookie in the response. Register
  with a **malformed** `x-device-id` → `202` (no longer `400
  device_id_invalid`). Delete the old register device tests that asserted the
  opposite.
- **Contract header.** A `/register` response carries
  `x-kauth-contract-version: 0.6.0` (via the existing lockstep assertions in
  `contractVersion.test.ts` once the versions bump — no new assertion needed
  unless convenient).

### SDK cases (`clientSdk.test.ts`)

- `signUp` resolves to `undefined`; `client.getSnapshot().status` stays
  `"signedOut"`; a subsequent `signIn` with the same credentials transitions
  to `"signedIn"` with a working access token (the `/protected` check).
- A duplicate-email `signUp` **resolves** (does not throw); the store stays
  `signedOut`; still only one `user` row for that email.
- `signUp` with a taken username still throws `KauthError` with code
  `duplicate_username`.
- `useSession` reports `out:-` after `signUp` and only flips to `in:-` after
  `signIn` (the hook probe already renders `in:<email>` vs `in:-` vs `out:-` —
  post-`signUp` `user` is null now, so it is `out:-` until `signIn`).
- The reactive-subscriber and device-identity tests that currently rely on
  `signUp` creating a session get a `signIn` inserted after the `signUp`.
- The contract-mismatch test keeps working (a stale client's `signUp` still
  rejects on the response header before anything else).

### Prior art

- `backend/tests/auth.test.ts` — the `POST /register` block and the login
  timing test ("spends comparable time…").
- `backend/tests/rateLimit.test.ts` — per-account / per-project limiter tests
  and the `setRateLimitingEnabled` lifecycle.
- `backend/tests/auditLog.test.ts` — asserting on `security_events` rows by
  type/severity.
- `backend/tests/mfaMandate.test.ts` — the grace-stamping assertions being
  moved from register to login.
- `backend/tests/clientSdk.test.ts` — the real-HTTP SDK seam and the hook
  probe.
- `.scratch/identity-oracles/` — the login-timing-oracle ticket, the same
  shape of problem.

### Not mutation-checked

Cross-project isolation on the new limiter is covered but, per the ticket-02
note in the wayfinder memory, a `project_id`-scoped assertion that is already
`user_id`-scoped is a no-op mutation-check — the same-project-different-email
case is the one that actually catches a dropped scope.

## Out of Scope

- The mailer-posture work (already shipped: `MAILER_MODULE`, `bootMailer`,
  production fail-fast — `bf6299d` / `5ec0b4b`).
- A `/me` / profile endpoint to repopulate `useSession().user` after the
  auto-login removal. Noted as the reason the `user` field is kept; building
  it is later work.
- `signUp` auto-chaining to `signIn` inside the SDK — explicitly rejected
  (would reopen the oracle for a mismatched-password duplicate email).
- Any change to `duplicate_username` (`409`, stays) or to `POST /login`,
  refresh, logout, OAuth exchange, `POST /send-verification-email`.
- The `duplicate_username` timing (username existence is not a protected
  fact; that branch short-circuits before the hash on purpose).
- Rate-limiting the notification email beyond the per-account limiter (no
  digesting / cooldown-per-address beyond the 5/hour bucket).
- The tenant-RBAC and per-Project-OAuth epics (batch epic 2).
- Docs-sync itself is its own ticket (below), not this spec's body.

## Further Notes

- **Contract version bumps per epic, not per batch** — this epic is `0.6.0`;
  batch epic 2 bumps again when it lands. Don't pre-bump for epic 2.
- The generic message deliberately says "if that address is valid" — it is a
  small nudge that the endpoint does not confirm anything, and it reads
  correctly on both branches.
- `USER_REGISTERED` staying `INFO` while `REGISTER_DUPLICATE_EMAIL` is
  `WARNING` is intentional: a repeat attempt on a known address is mildly
  interesting, a first registration is not.
- Keep `bootMailer` / mailer-posture untouched; the duplicate-email
  notification goes through the same `sendMail` best-effort path as every
  other kauth email.
- Migration timestamp: **verify it sorts after `main`'s latest migration
  folder** before merging (Prisma stamps wall-clock, not merge-order).

## Tickets

Per the plan (`.scratch/deferred-closeout/plan.md`), three:

1. **Backend.** Controller rewrite (generic `202`, username-first,
   unconditional hash, happy/duplicate branches, `USER_REGISTERED` with
   `sessionId: null`, drop `stampMfaGrace`), `REGISTER_DUPLICATE_EMAIL` enum +
   migration + `SEVERITY` entry, `existingAccountEmail` template,
   `registerAccountLimiter` + route change (add limiter, drop `resolveDevice`),
   and all the backend test work including the helper containment and the
   rewrites of the register / mfaMandate-grace / device blocks.
2. **SDKs + contract bump + ADR.** `client-sdk` `signUp` → `Promise<void>`
   (delete `SignUpResult`, keep `SignUpInput`, doc-comment, README example),
   `client-sdk` + `backend-sdk` `version.ts` and `package.json` → `0.6.0`,
   `backend/package.json` → `0.6.0`, backend-sdk changelog, `clientSdk.test.ts`
   rewrites, and `docs/adr/0008-register-drops-auto-login.md`. Blocked by 1.
3. **Docs-sync.** `docs/roadmap.md` — section 3 ("Close the identity oracles")
   marks the registration oracle closed, the intro's "Next up" list drops it,
   `Last reviewed:` date; `backend/README.md` / SDK READMEs status tables if
   they name the contract version or the register flow. May be folded into
   ticket 2's merge if they land together — implementer's call. Blocked by 2.
