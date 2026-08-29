# Deferred-closeout batch — routing plan

> **Status:** planning stored 2026-08-26, nothing built yet. This file records
> decisions taken in conversation plus the skill workflow chosen to build them.
> Each epic gets its own grilling pass before tickets are written; this file is
> the map between them, not a spec.

## Locked decisions

Decisions made 2026-08-26 (grilling frontier cleared; details per epic still
open):

1. **Tenant admins get full project management** inside their own Project:
   user listing, session view/revoke, audit (SecurityEvent) reads, and Project
   settings & API-key management. Extends ADR 0007's staff surface inward;
   requirements stated by the operator (the consuming-app trigger ADR 0007
   waited for).
2. **Register drops auto-login** to close the duplicate-email identity oracle.
   Register returns success without tokens/session; clients call login after.
   Breaking register-contract change — explicitly re-decides the question
   frozen behind ADR 0003; contract version bumps accordingly and both SDKs
   learn the new flow.
3. **Mailer is integration-supplied**: `consoleMailer` becomes development-only
   (mirroring the production secret-length enforcement in `config.ts`);
   production refuses to start without an explicitly configured transport via
   `setMailer`. No stock SMTP provider ships with kauth.
4. **OAuth credentials stay deployer-supplied AND go per-Project.** Env-var
   Google/GitHub configuration remains the instance-level default (documented,
   wizard-covered), and each Project gains its own bring-your-own provider
   apps — the parked clerk-clone-map item. Design teeth to settle in grilling:
   credential encryption at rest (ADR 0006's `ENCRYPTION_KEY` pattern),
   redirect-URI strategy (providers require pre-registered URIs; `state` must
   carry the Project id), precedence over env providers, owner/admin management
   surface.

## Workflow

Three main-flow runs (`/grill-with-docs` → `/to-spec` → `/to-tickets` each),
one `/wizard`, then `/implement` per ticket with `/clear` between:

| Order | Epic | Tracker dir | Decisions | Notes |
| --- | --- | --- | --- | --- |
| 0 | ~~Tracker hygiene~~ | `.scratch/tracker-hygiene/` | — | Done 2026-08-26: ops-hardening issue 01 acceptance boxes ticked post-hoc |
| 1 | Register oracle + mailer posture | `.scratch/register-oracle/`, `.scratch/mailer-posture/` | 2, 3 | **COMPLETE 2026-08-29.** Mailer-posture: tickets 01 (`bf6299d`) + 02 (`5ec0b4b`). Register-oracle: all 3 tickets implemented in one pass — generic `202`, username-first, unconditional hash, `REGISTER_DUPLICATE_EMAIL` event + migration, `existingAccountEmail`, `registerAccountLimiter`, `resolveDevice` dropped from the route; `client-sdk` `signUp` → `Promise<void>` (`SignUpResult` deleted); contract → `0.6.0` across backend + both SDKs; ADR 0008; roadmap + README docs-sync. Test-helper containment: `registerAndSignIn` in `tests/helpers/api.ts`. |
| — | Setup wizard | — | — | Generated after session 1 settles config story; walks through OAuth app creation, secrets generation, cleanup cron, staff promotion |
| 2 | Tenant RBAC + per-Project OAuth | `.scratch/tenant-rbac/`, `.scratch/project-oauth/` | 1, 4 | Management-surface pair; project-oauth needs its own ADR (encryption, redirect/state design, precedence) |
| 3 | Frontend auth flows | `.scratch/frontend-auth/` | — | Consumes sessions 1–2's final contracts via client-sdk; minimum scope: verify-email, reset-password, OAuth callback/exchange pages. Whether full login/register/MFA UI joins this epic is a session-3 grilling question |

Implementation order once tickets exist: mailer → register → tenant-rbac →
project-oauth → frontend-auth. Contract version lands as one 0.6.0 stroke or
sequential bumps — decided during session 1 under ADR 0003 discipline.

## Session 1 grilling outcome (2026-08-28)

Frontier cleared over three rounds. Settled design, both epics:

### Mailer posture (ships first — no contract impact)

- `MAILER_MODULE` — new optional env var (`z.string().optional()` in
  `config.ts`). `server.ts:main()` loads it as its *first* step, before
  `applyMigrations()`: `await import` resolved relative to **cwd**, accepts a
  `default` OR named `mailer` export satisfying `Mailer`, calls `setMailer`.
  Clear throws on unloadable path / wrong export shape.
- Production fail-fast — `lib/mail.ts` gains a module-level `mailerConfigured`
  flag flipped by `setMailer`. Right after the load step (still before
  migrations): throw when `node_env === "production" && !mailerConfigured`.
  `consoleMailer` stays the default only for development/test.
- Dev warning — one-time `warn` on first `sendMail` when console transport
  still active.
- Wizard — new stage before the email-verification stage prompting for
  `MAILER_MODULE`; stage 7 becomes conditional (transport set → "safe to
  enable"; blank → `REQUIRE_EMAIL_VERIFICATION` forced `false` without asking).
- Tests — `Bun.spawnSync` child-process pattern (per
  `tests/configEncryptionKey.test.ts`).
- No ADR (enforcement of an already-stated posture); roadmap note only.
- Tickets: (1) load + fail-fast + dev warning + config/README/wizard;
  (2) docs-sync.

### Register drops auto-login (contract → 0.6.0)

- `/register` always returns `202 { message: "If that address is valid, we've
  sent a confirmation email." }` — byte-identical on both branches, both do one
  email round-trip, both pay the password-hash cost (dummy Argon2id on the
  duplicate branch).
- Ordering: username checked **first** → `409 duplicate_username` if taken
  (not an oracle). `password_too_short` stays a synchronous `400` on input
  shape before any DB lookup. Email existence handled silently after.
- Happy-path txn: creates **user + credential account only** — no
  `createSession`, no `stampMfaGrace` (grace still stamped at `login`).
  `USER_REGISTERED` fires with `sessionId: null`. `EMAIL_CONFIRMATION_SENT`
  fires as today. Response drops `mfaGraceEndsAt`.
- Duplicate-email branch: new `REGISTER_DUPLICATE_EMAIL` SecurityEvent (Prisma
  enum value + `SEVERITY` entry `WARNING` — needs a migration), server-side
  only. Sends `existingAccountEmail(to)` — no token, no project name, no
  username, no "who": just "you already have an account — sign in, or reset
  your password." Never fires `EMAIL_CONFIRMATION_SENT`.
- Rate limiting: add a second limiter to `/register` keyed **by account**
  (`storePrefix: "register-account"`, ~60min/5), behind the existing by-IP
  `registerLimiter` — mailbomb parity with the recovery endpoints.
- Route: drop `resolveDevice` from `/register`; controller uses
  `requestContext(req)` for event IP/UA.
- SDKs: client-sdk `signUp(input: SignUpInput): Promise<void>` — no
  `setState`/`captureDeviceId`, delete `SignUpResult`, keep `SignUpInput`;
  README example becomes register-then-`signIn`; `useSession().user` stays
  `null` post-signUp (field kept for a future `/me`). Both SDKs bump
  `CONTRACT_VERSION` to `0.6.0`; backend-sdk gets version bump + changelog
  only. `backend/package.json` → `0.6.0`.
- No auto-chain: `signUp` does not internally call `signIn` (a different
  password on a duplicate email would throw `auth_failed` and reopen the
  oracle).
- OAuth exchange and `POST /send-verification-email` are **untouched**.
- ADR 0008 `register-drops-auto-login` — records the re-decision of the
  ADR-0003-frozen contract question, the consequences (breaking change, SDK
  redeploys, weaker DX), and that `duplicate_username` stays.
- Tests — oracle byte-identity + timing test, mutation-checked by reverting to
  `409 duplicate_email`; username still 409; existing register tests rewritten
  off the 201+tokens assumption.
- Tickets: (1) backend (generic response + username-first + dup event +
  notification mail + by-account limiter + txn + migration + route);
  (2) both SDKs + contract bump + ADR 0008; (3) docs-sync (roadmap + README
  status table).

Contract version: **per-epic bumps**, not one batch stroke. This epic →
0.6.0; epic 2 bumps again when it lands.

## Session 2 grilling outcome (2026-08-29)

Frontier cleared over four rounds. Both epics settled.
**Specs published 2026-08-29** (`ready-for-agent`):
`.scratch/tenant-rbac/spec.md` (the Project owner management surface — dir
name is historical, there is no role) and `.scratch/project-oauth/spec.md`
(per-Project Provider apps, ADR 0009). Test seams confirmed with the
operator: tenant-rbac reuses the existing `api()` + `backendSdk.test.ts`
seams; project-oauth adds one in-process hook `registerOAuthProviderFactory`
(sibling of `registerOAuthProvider`).

**tenant-rbac tickets published 2026-08-29** (`ready-for-agent`, linear
`01 → 02 → 03 → 04`): `01` project audit-log reads (owner + secret-key) +
carries the `0.7.0` bump + `lib/pagination.ts` + shared serialize prefactor;
`02` project sessions & users (owner surface + secret-key session list) +
`SESSION_REVOKED` actor normalization; `03` backend-sdk `listEvents()` /
`listSessions()` (blocked by 01+02); `04` docs-sync.

**project-oauth tickets published 2026-08-29** (`ready-for-agent`, chain
`{01, 02} → 03 → 04 → 05`): `01` cryptoBox context param (prefactor,
unblocked); `02` signed OAuth `state` + drop `kauth_oauth_project`
(unblocked); `03` per-Project Provider apps — `ProjectOAuthCredential` table
+ `OAuthCredentialMode`, factory registry, `resolveProjectProvider`,
`GET /oauth/providers?projectId=`, `PROJECT_OAUTH_CONFIG_CHANGED` enum,
`registerOAuthProviderFactory` test hook (blocked by 01+02, does NOT bump
contract); `04` owner management surface `/projects/:projectId/oauth/providers`
(blocked by 03); `05` closeout — ADR 0009 + client-sdk + docs-sync (blocked
by 04).

Implementation order across epic 2: tenant-rbac `01→04` first (01 carries
the `0.7.0` bump), then project-oauth `01→05`. `/implement` per ticket,
`/clear` between.
Contract version: **one `0.7.0` bump for the whole epic**, applied in the
first contract-touching ticket, no re-bump by later epic-2 tickets; both
SDKs redeploy once at epic close.

### Tenant RBAC — the owner gets a bigger surface, no new role

- **No tenant-admin role.** `Role.ADMIN` stays inert in tenant Projects;
  ADR 0007 and the `Role` glossary entry are unchanged. "Tenant admin" =
  the Project **owner** (a platform-Project developer on `Project.owner_id`)
  with more session-authenticated endpoints. **No ADR** for this half —
  roadmap + CONTEXT note only.
- **New owner-session endpoints**, under `/projects/:projectId/*` behind
  `requireAuth` + `requireProjectOwnership`, running *parallel* to (not
  replacing) the secret-key `/project/*` routes:
  - `GET /projects/:projectId/users`
  - `GET /projects/:projectId/sessions` (new — project-wide session list,
    doesn't exist today), `GET|DELETE /projects/:projectId/sessions/:id`
  - `GET /projects/:projectId/events` — reverse-chron, cursor-paginated,
    filterable by `event_type` and `user_id`; returns `id, event_type,
    severity, user_id, session_id, ip, user_agent, created_at, metadata`;
    `metadata` passed through as stored.
- **Secret-key parity.** The audit-read and project-wide session-list
  endpoints are *also* mirrored to the secret key (`GET /project/events`,
  `GET /project/sessions`). Backend-SDK grows `listEvents()` /
  `listSessions()`. Write routes (`/projects/:id/oauth/*`, settings, keys)
  stay owner-session only.
- `SESSION_REVOKED` metadata gains an `owner_id` actor marker alongside the
  existing `apiKeyId` / `actor_user_id` variants.
- `GET /oauth/providers` becomes `?projectId=`-scoped (contract change).

### Per-Project OAuth — ADR 0009

Full design in `docs/adr/0009-per-project-oauth-credentials.md`. Key points:

- **Built-in providers only** (google, github). Custom providers stay
  instance-level via `registerOAuthProvider`.
- **`ProjectOAuthCredential` table**, one row per `(project_id,
  provider_id)`. `client_id` plaintext; `client_secret` via `cryptoBox`
  under `kauth:project-oauth`. `mode`: `OVERRIDE` | `DISABLED`; absent row
  = inherit the instance app.
- **Precedence**: instance config is an inheritable default for every
  Project; a Provider app fully overrides per-Project; a Project can
  disable a provider outright.
- **Callback**: one instance-wide callback URL, unchanged. Project id
  travels in a signed `state` —
  `<random>.<projectId>.<HMAC-SHA256(k, random ‖ projectId)>`, `k` =
  `SHA-256(ENCRYPTION_KEY ‖ "kauth:oauth-state")`. HMAC verified at
  callback, `projectId` read from `state`, `random` compared to the
  `kauth_oauth_state` cookie. **`kauth_oauth_project` cookie removed.**
- **Resolution**: `getOAuthProvider` project-aware, per-request client
  construction (no cache), instance fallback; `DISABLED`/unknown → `404`
  at start and callback.
- **Management**: owner-session only, `/projects/:projectId/oauth/providers`
  — `GET` (effective config, never the secret), `PUT` (`{clientId,
  clientSecret}` → `OVERRIDE`; `{disabled:true}` → `DISABLED`), `DELETE`
  (→ inherit). Secret key rejected on writes. No credential validation on
  write. Public `GET /oauth/providers?projectId=` gets `oauthLimiter`,
  `404` on unknown project id.
- **Event**: `PROJECT_OAUTH_CONFIG_CHANGED` (WARNING), metadata
  `{ provider, action: "configured" | "disabled" | "cleared" }`, secret
  never logged. Migration adds enum value + `SEVERITY` entry.
- **Existing links**: disabling a provider removes it as a login path but
  keeps the `Account` row (re-enable restores it); changing creds doesn't
  orphan links (provider subject id is stable across OAuth clients).

### Vocabulary

New `CONTEXT.md` term **Provider app** (added this session). No change to
`Role`, `Platform staff`, `Account`.

### Abuse-path tests (mutation-checked, ship in the same tickets)

1. Cross-project credential isolation (drop the project filter → fails).
2. Signed-`state` tamper — `state` re-signed for another project id →
   `state_mismatch` (revert to cookie-only → fails).
3. Disabled provider → `404` at start and callback.
4. `client_secret` round-trips cryptoBox, in no response, in no audit
   metadata.
5. Owner-surface auth — secret key rejected on `/projects/:id/oauth/*`
   writes; non-owner session → `404`.
6. Audit-read scoping — owner of project A cannot read project B's events.

## Close-out duties

- Each epic ends with a docs-sync ticket updating `docs/roadmap.md` and
  README's status table (rbac-enforcement pattern).
- Roadmap intro points here until the batch ships.
