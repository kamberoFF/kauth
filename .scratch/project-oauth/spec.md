Status: done — all five tickets merged to main 2026-08-30

# Per-Project OAuth credentials — bring-your-own provider apps

Collapsed from the deferred-closeout batch's **session-2 grilling**
(`/grill-with-docs` — grilling + domain-modeling, frontier cleared over four
rounds, 2026-08-29). The settled design lives in
`.scratch/deferred-closeout/plan.md` under "Session 2 grilling outcome →
Per-Project OAuth"; this spec is the buildable synthesis of the **second half
of batch epic 2**. The first half is `.scratch/tenant-rbac/spec.md` (the
Project owner management surface). The design decision record for this half
is **ADR 0009** (`docs/adr/0009-per-project-oauth-credentials.md`), drafted
during the grilling session — its ticket finalises and commits it.

**Contract.** Epic 2 bumps the contract version to **`0.7.0`** — one bump for
the whole epic, landing in `tenant-rbac`'s backend ticket (batch order:
`… → tenant-rbac → project-oauth → …`). **This spec's tickets check that
`0.7.0` is already in place and must not bump again.** If `project-oauth`
somehow lands first, its backend ticket does the bump and `tenant-rbac`
checks instead — the tickets cross-reference.

## Problem Statement

kauth's Google and GitHub OAuth apps are configured once per instance, by env
var (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET`, surfaced as `config.oauth` and turned into a
process-wide provider registry in `lib/oauth/providers.ts`).

For a multi-tenant platform that is the wrong default:

- Every tenant Project's social logins run through the **operator's** OAuth
  client. End users see the operator's consent screen and app name; the
  provider issues tokens to the operator's app, not the tenant's.
- A tenant that wants its own branded Google app, its own GitHub org
  restrictions, or its own provider-side quota cannot have one.
- An operator who runs Google for their *own* first-party app forces every
  tenant onto that same client, with no way to offer a given tenant no Google
  login at all.

The clerk-clone map parked "OAuth credentials per project (bring-your-own
Google/GitHub app vs. a shared kauth-branded broker)" while the foundation
landed. The grilling settled it: **bring-your-own, built-in providers only,
instance config stays as an inheritable default.**

## Solution

Each Project may register its own **Provider app** (`CONTEXT.md` — added
during the grilling session): its own `client_id` and `client_secret` for a
built-in provider (google, github — the two kauth has an `arctic` client
for).

Precedence:

- **Inherit** — a Project with no Provider app for a provider uses the
  instance env config, exactly as today.
- **Override** — a Project's own Provider app fully replaces the instance app
  *for that Project*. Its `client_secret` is stored AES-256-GCM-encrypted at
  rest (ADR 0006's `cryptoBox` pattern, a new derivation namespace).
- **Disable** — a Project may suppress a provider entirely, so its login page
  offers neither the instance app nor an override.

The redirect flow keeps a **single instance-wide callback URL** per provider
(every Project's Provider app registers that exact URI at Google/GitHub). The
Project id travels in a **signed `state`** value instead of a separate
cookie; `kauth_oauth_project` is removed. Provider resolution becomes
Project-aware, constructed per request from decrypted credentials with the
instance registry as the fallback.

Provider apps are managed through **owner-session-only** endpoints under
`/projects/:projectId/oauth/providers`; a secret key is rejected on the
writes (Project config is a developer concern — foundation user stories
10/19). Every credential change writes a `PROJECT_OAUTH_CONFIG_CHANGED`
security event; the secret never appears in a response, in audit metadata, or
in a log line.

## User Stories

1. As a developer, I want to register my Project's own Google OAuth app, so
   that my users see my brand on the consent screen and tokens are issued to
   my client, not the operator's.
2. As a developer, I want to register my Project's own GitHub OAuth app, so
   that I can apply my org's restrictions and quotas.
3. As a developer, I want my Project to keep working with the instance's
   Google/GitHub app if I do not configure my own, so that inheritance is a
   zero-config default.
4. As a developer, I want to disable a provider for my Project entirely, so
   that my login page does not offer a social option I do not want, even one
   the operator configured.
5. As a developer, I want my `client_secret` stored so that it can never be
   read back — not through the API, not in a listing, not in logs — so that a
   database or backup leak does not hand an attacker my provider credentials.
6. As a developer, I want to see which providers my Project has configured and
   the `client_id` for each, so that I can confirm my setup without the
   secret being re-exposed.
7. As a developer, I want to update a Provider app's credentials by PUTting
   new values, so that rotating a secret at the provider is a one-call change
   on my side.
8. As a developer, I want to clear a Provider app (delete the row) to fall
   back to inheritance, so that undoing an override is explicit.
9. As a developer, I want to register a Provider app for a provider the
   instance has **not** configured at all, so that I can offer Google even if
   the operator only set up GitHub.
10. As an end user of a tenant app, I want the social login I click to behave
    identically whether the Project uses its own Provider app or the
    instance's, so that the flow is transparent to me.
11. As an end user who already linked Google, I want my link to keep working
    if the Project switches to its own Google app, so that a credential change
    on the developer's side does not sign me out of my linked identity.
12. As an end user, I want a provider the Project disabled to simply not
    appear as an option, rather than erroring after I click it — and if it
    does get hit directly, I want a clean "unknown provider" response.
13. As an operator, I want a Project's Provider-app changes recorded as
    `PROJECT_OAUTH_CONFIG_CHANGED` audit events, so that reconfiguration is
    visible in the log.
14. As an operator, I want that event to carry the provider and the action
    but never the secret or even the `client_id`, so that the audit log stays
    safe to expose to a Project owner (the other epic-2 spec's events
    endpoint).
15. As an operator, I want per-Project OAuth secrets encrypted under a
    derivation namespace separate from the MFA secret and from cookie
    signing, so that the blast radius of one key compromise does not widen
    (ADR 0006).
16. As an operator, I want the redirect flow to keep a single callback URL per
    provider, so that onboarding a Project is "paste these two values and add
    one redirect URI" rather than registering a distinct URI per Project.
17. As an operator, I want the Project id in the OAuth `state` to be
    tamper-evident (HMAC-signed), so that a stripped or swapped state/cookie
    cannot misroute a callback onto another Project's credentials.
18. As an operator, I want the `GET /oauth/providers` endpoint to report the
    effective provider set for a named Project, so that a Project's login page
    renders exactly the options that Project has.
19. As a developer, I want the management writes to require my logged-in
    developer session and reject my secret key, so that a leaked SDK key
    cannot reconfigure my Project's auth.
20. As a maintainer, I want ADR 0009 to record the encryption namespace, the
    signed-`state` design, the inherit/override/disable precedence, and the
    two rejected alternatives (a shared branded broker; per-Project callback
    paths), so that a future session does not re-litigate them.
21. As a maintainer, I want the cross-Project credential isolation and the
    signed-`state` cross-Project rejection covered by tests that fail if the
    Project filter or the HMAC check is removed, so that a refactor cannot
    reopen the boundary.
22. As a maintainer, I want a test seam that proves a Project's *decrypted*
    credentials actually reach the provider construction, not just that a
    redirect URL looks right, so that "the right secret is used" is directly
    verified.

## Implementation Decisions

### Schema

New model in `prisma/schema.prisma`:

- **`ProjectOAuthCredential`** — `id` (uuid), `project` / `project_id` (FK,
  `onDelete: Cascade` — a deleted Project takes its Provider apps with it),
  `provider_id` (String — `"google"` | `"github"`; not an enum, to match the
  string-keyed provider registry and leave room for a test stub id),
  `client_id` (String — plaintext; it is public, it rides in the redirect
  URL), `client_secret_enc` (String? — `cryptoBox` ciphertext; `null` iff
  `mode = DISABLED`), `mode` (new enum `OAuthCredentialMode { OVERRIDE,
  DISABLED }`), `created_at`, `updated_at`.
  `@@unique([project_id, provider_id])`, `@@index([project_id])`,
  `@@map("project_oauth_credentials")`. snake_case columns per conventions.
- Add the relation array `oauthCredentials ProjectOAuthCredential[]` to
  `Project`.

Migration: `CREATE TYPE "OAuthCredentialMode"` + `CREATE TABLE`. **Check the
migration folder timestamp sorts after `main`'s latest** before merging —
Prisma stamps wall-clock time, which has bitten this repo before (ticket-02
note in the wayfinder memory).

### Encryption — `lib/cryptoBox.ts` gains a context parameter

`cryptoBox.ts` currently hard-codes `KEY_CONTEXT = "kauth:mfa-totp"`. ADR
0006's own comment anticipates this exact second consumer ("a future consumer
derives its own subkey from the same `ENCRYPTION_KEY` under a different
context label"). Parameterise it:

- `encrypt(plaintext, context)` / `decrypt(payload, context)` — or a
  `cryptoBox(context) => { encrypt, decrypt }` factory. Implementer's call on
  the shape; the requirement is that the context label is an argument.
- MFA call sites pass `"kauth:mfa-totp"` (unchanged behaviour, unchanged
  ciphertext).
- Per-Project OAuth passes `"kauth:project-oauth"`.
- A ciphertext sealed under one context must fail to decrypt under another
  (GCM tag + distinct derived key already guarantee this — add the test).

The plaintext `client_secret` is held only transiently, in the request that
writes it and in `resolveProjectProvider` when it builds a client. It is
**never** returned by any endpoint, put in any `security_events.metadata`, or
logged.

### Signed `state` — new `lib/oauthState.ts`

- `signState(projectId: string): string` → `"<random>.<projectId>.<hmacHex>"`
  where `random` is `arctic`'s `generateState()` (or equivalent CSPRNG) and
  `hmacHex = HMAC-SHA256(k, "<random>.<projectId>")`,
  `k = SHA-256(config.encryption_key ‖ "kauth:oauth-state")`.
- `verifyState(value: string): { random: string; projectId: string } | null`
  — parse, recompute the HMAC, `crypto.timingSafeEqual` compare; `null` on
  any failure.

`config.encryption_key` is already a required, entropy-checked secret (ADR
0006), so no new env var.

### `controllers/oauth.ts` — flow changes

- **`startOAuth`**: resolve the Project id from `?projectId=` as today
  (`resolveProjectIdOrThrow`). Resolve the provider via
  `resolveProjectProvider(projectId, providerId)` (below) — `undefined` →
  `404 provider_not_found` (covers unknown provider **and** a `DISABLED`
  Project row). Replace `generateState()` + the `PROJECT_COOKIE` write with
  `state = signState(projectId)`; set the `kauth_oauth_state` cookie to that
  full signed string (still the CSRF binding); set the PKCE verifier cookie
  as today when `provider.usesPkce`.
- **`oauthCallback`**: read and clear `kauth_oauth_state` and the verifier
  cookie as today. **Remove all handling of `kauth_oauth_project`.** Validate:
  `returnedState === stateCookie` (byte-for-byte, the existing CSRF check)
  **and** `verifyState(returnedState)` returns non-null; either failure →
  `fail("state_mismatch")`. Take `projectId` from the verified state's
  `projectId` field. Re-run `resolveProjectIdOrThrow(projectId, "signed
  state")` for the "Project deleted mid-flow" case (same as today's
  re-validation of the cookie), attributing `OAUTH_LOGIN_FAILED` to the
  resolved id or `null`. Resolve the provider via
  `resolveProjectProvider` again (the callback needs the same client the
  start used); `undefined` → `fail("provider_not_found")`.
- **Delete `PROJECT_COOKIE` / `kauth_oauth_project`** entirely — the
  constant, the `res.cookie` in `startOAuth`, and the `readAndClearCookie` in
  `oauthCallback`.
- `/oauth/exchange` and `exchangeOAuthCode` — **unchanged**. The Project is
  already derived from the `OAUTH_EXCHANGE` recovery-token row.

### `lib/oauth/providers.ts` — Project-aware resolution

- **Factory registry.** Extract `googleProvider` / `githubProvider` into a
  registry: `registerOAuthProviderFactory(id, (creds: { clientId: string;
  clientSecret: string }) => OAuthProvider)`. Instance startup: for each
  present `config.oauth.<id>`, build via its factory and register the result
  as the instance default through the **existing** `registerOAuthProvider`
  (unchanged) — so `getOAuthProvider(id)` / `enabledProviders()` keep meaning
  "instance default". Google and GitHub factories are registered
  unconditionally at module load; the *instance provider* is only registered
  when its env creds are present.
- **`resolveProjectProvider(projectId, providerId): Promise<OAuthProvider |
  undefined>`**:
  1. Look up `ProjectOAuthCredential` for `(projectId, providerId)`:
     - `OVERRIDE` → `factory(providerId)?.({ clientId, clientSecret:
       decrypt(client_secret_enc, "kauth:project-oauth") })`. No factory for
       that id → treat as unknown (`undefined`); the write path prevents this
       for real providers.
     - `DISABLED` → `undefined`.
  2. No row → `getOAuthProvider(providerId)` (instance default).
  3. Still nothing → `undefined`.
  - **Per-request construction, no cache.** An OAuth start is rare; a
    `decrypt` + `new Google(...)` per call is negligible, and a cache would
    need invalidation on every credential write. Explicitly rejected in the
    grilling.
- **`enabledProvidersForProject(projectId): Promise<string[]>`** — the
  instance `enabledProviders()` set, minus this Project's `DISABLED` rows,
  plus this Project's `OVERRIDE` rows for providers the instance lacks.
- `callbackUrl(providerId)` — **unchanged**. One instance-wide URL per
  provider.

### `GET /oauth/providers` — now Project-scoped

- Requires `?projectId=` — resolved via `resolveProjectIdOrThrow` (`400
  project_id_missing` / `project_id_invalid`, `404 project_not_found`).
- Wrapped in `oauthLimiter` (it now does a DB lookup on an unauthenticated
  endpoint).
- Returns `{ providers: await enabledProvidersForProject(projectId) }`.
- This is a response-contract change (the param became required, the result
  is now Project-specific) → folds into the epic's `0.7.0`. If `client-sdk`
  calls this endpoint, it passes its publishable key's Project id; check and
  update. If it does not, no SDK change here.

### Management surface — owner session only

Mounted with the other owner routes, behind `requireAuth,
requireProjectOwnership`, under `/projects/:projectId/oauth/providers`:

- **`GET /projects/:projectId/oauth/providers`** → an array over the built-in
  providers: `{ provider, source: "instance" | "project", enabled: boolean,
  clientId: string | null }`. `clientId` is non-null only when `source ===
  "project"`. `enabled` is `false` for a `DISABLED` row. **Never** the
  secret. (A Project with no row for `github` and an instance GitHub app →
  `{ provider: "github", source: "instance", enabled: true, clientId: null }`.)
- **`PUT /projects/:projectId/oauth/providers/:provider`** — `:provider` must
  be a known built-in id or `400 provider_not_found`. Body, zod-validated
  (`projectOAuthCredentialSchema`), is exactly one of:
  - `{ clientId: string, clientSecret: string }` → upsert `mode = OVERRIDE`,
    `client_secret_enc = encrypt(clientSecret, "kauth:project-oauth")`.
  - `{ disabled: true }` → upsert `mode = DISABLED`, `client_secret_enc =
    null`, `client_id = ""` (or keep any prior value — unused while
    disabled).
  - No live credential check (a `client_secret` cannot be verified without a
    full user flow).
  - `200` with the same shape as one element of the `GET` list.
- **`DELETE /projects/:projectId/oauth/providers/:provider`** — drop the row
  → back to inherit. `404` if there is no row.
- Every successful `PUT` / `DELETE` records `PROJECT_OAUTH_CONFIG_CHANGED`
  **in the same transaction** as the row write.
- A secret-key-only request to any of these is `401` at `requireAuth`, before
  `requireProjectOwnership` runs — same as the existing
  `/projects/:projectId/keys` routes.

### `PROJECT_OAUTH_CONFIG_CHANGED` security event

- Add to `SecurityEventType` in `prisma/schema.prisma`; migration
  `ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS
  'PROJECT_OAUTH_CONFIG_CHANGED';` (the `20260826100000_add_role_changed_event`
  pattern; check timestamp ordering).
- `SEVERITY` map entry → `WARNING` (matching `PROJECT_MFA_POLICY_CHANGED` /
  `PROJECT_PASSWORD_POLICY_CHANGED`). Derived from the type, never per call
  site.
- Metadata: `{ provider, action: "configured" | "disabled" | "cleared" }`.
  **No `client_secret`, no `client_id`.** `userId` is the acting owner;
  `projectId` is the target Project.

### Existing linked accounts

- **Disable** a provider: linked `Account` rows are left intact;
  `resolveProjectProvider` returns `undefined` so that provider is no longer
  a login path. A later re-enable restores it. No cascade, no unlink.
- **Change** credentials (`OVERRIDE` → new `client_id`/`secret`): the provider
  subject id (`sub` for Google, numeric id for GitHub) is stable for a given
  end user across OAuth clients, so `Account.account_id` still matches and
  existing links keep working. No migration on credential change.

### ADR 0009

`docs/adr/0009-per-project-oauth-credentials.md` was drafted during the
grilling session. Its ticket finalises the wording against what actually
shipped and commits it. It records: the `kauth:project-oauth` encryption
namespace; the single callback URL + signed-`state` project binding + removal
of `kauth_oauth_project`; the inherit/override/disable precedence; and the
rejected alternatives — a shared kauth-branded OAuth broker (makes kauth the
OAuth client of record for every tenant's users, the exact problem the
platform exists to avoid) and per-Project callback paths (registration
friction for no gain over signed `state`) — plus the rejection of a decrypted
provider-client cache.

### Explicitly unchanged

- Instance env vars (`GOOGLE_CLIENT_ID` etc.), `config.oauth`,
  `credentialPair` — still the inheritable default.
- `Account.access_token` / `refresh_token` / `id_token` (the provider's
  *user* tokens) — storage untouched; out of scope.
- `registerOAuthProvider` / `unregisterOAuthProvider` — kept as the
  instance-level extension point for an operator coding in a new `arctic`
  client.
- `resolveUser` linking policy (verified-email requirement), the OAuth MFA
  challenge, `/oauth/exchange`.
- The `kauth_oauth_state` cookie and the PKCE verifier cookie — unchanged
  (only the project cookie goes away).

## Testing Decisions

A good test asserts **observable external behaviour**: the redirect
`Location` and its query params, HTTP status and body of the management
endpoints, `project_oauth_credentials` / `security_events` row contents, the
in-memory result of a full OAuth round trip, and that no response or event
carries the secret. Not: which internal function decrypted what.

### Seams

- **Primary, existing:** `api()` HTTP against a real test server + real
  Postgres — the `oauth.test.ts` idiom (stub provider, full redirect round
  trip, state/cookie handling) plus the `projects.test.ts` owner-route idiom.
- **One new in-process hook — `registerOAuthProviderFactory`** — a sibling of
  the existing `registerOAuthProvider`, at the same provider-construction
  boundary. A test registers a `stub` factory whose returned `OAuthProvider`
  closes over a test-controlled spy; stores a `stub` `ProjectOAuthCredential`
  (`OVERRIDE`) for a Project via the management API or a direct insert; drives
  a full start → callback → exchange round trip; and asserts the spy received
  the Project's **decrypted** `clientSecret`. This is the highest point at
  which "the right secret reached the provider" is directly checkable without
  network access — the project's real-Postgres testing rules out mocking the
  provider's HTTP.
- **Encryption-at-rest, direct:** after a management write, read the
  `project_oauth_credentials` row and assert `client_secret_enc` is neither
  the plaintext nor decodable without `cryptoBox`, and that
  `decrypt(row.client_secret_enc, "kauth:project-oauth")` returns the
  plaintext — the `configEncryptionKey.test.ts` / `cryptoBox.test.ts`
  pattern.

### Prior art

- `backend/tests/oauth.test.ts` — the stub provider via `registerOAuthProvider`,
  the full redirect round trip, `state` / cookie assertions, `createTestProject`.
- `backend/tests/cryptoBox.test.ts`, `backend/tests/configEncryptionKey.test.ts`
  — encryption-at-rest and key-derivation assertions.
- `backend/tests/projects.test.ts` — owner routes and the
  `requireProjectOwnership` 404 idiom.
- `backend/tests/mfaEnrollment.test.ts` / `backend/tests/mfaSecurityEvents.test.ts`
  — encrypted-column round trips and policy-change-event assertions.
- `backend/tests/apiKeyAuth.test.ts` — key-tier gating and key-only → `401`
  on a session route.

### Cases

- **Isolation — two Projects, two Provider apps (mutation-checked).** Project
  A configures a `stub` `OVERRIDE` with `clientId` `"A"`; Project B with
  `"B"`. `GET /oauth/stub?projectId=A` → redirect whose `Location` carries
  A's client id; `?projectId=B` → B's; neither carries the other's. Mutation:
  drop the `project_id` filter in the `ProjectOAuthCredential` lookup → this
  test must fail.
- **Full round trip under per-Project creds.** Project A `stub` `OVERRIDE`;
  start → callback (valid signed `state`, matching cookie) → `/oauth/exchange`
  → session created; the stub factory's spy was called once with A's
  decrypted `clientSecret`.
- **Signed `state` (mutation-checked).** (a) A callback whose `state` has a
  valid HMAC but is re-signed for a **different** Project id, and therefore
  does not equal the `kauth_oauth_state` cookie → `state_mismatch`, no
  session, `OAUTH_LOGIN_FAILED` attributed to the state's Project (or `null`).
  (b) A callback whose `state` HMAC is garbage → `state_mismatch`. Mutation:
  make `verifyState` skip the HMAC comparison **or** re-introduce a project
  cookie read → case (a) must fail.
- **Inherit path unchanged.** A Project with no `ProjectOAuthCredential` row
  runs the full round trip against the instance-default stub (registered via
  `registerOAuthProvider`), i.e. the existing `oauth.test.ts` suite keeps
  passing after the `state` change and the `kauth_oauth_project` removal.
- **Disable.** Project sets `{ disabled: true }` for `stub`:
  `GET /oauth/stub?projectId=X` → `404 provider_not_found`; a forced callback
  → `fail("provider_not_found")` / `404`; `GET /oauth/providers?projectId=X`
  omits `stub`. A pre-existing linked `Account` row for that user+provider is
  still present in the DB (no cascade).
- **Encryption at rest.** After `PUT { clientId, clientSecret }`: the row's
  `client_secret_enc` ≠ plaintext; `decrypt(_, "kauth:project-oauth")` ==
  plaintext; `decrypt(_, "kauth:mfa-totp")` throws (cross-context).
  `GET /projects/:id/oauth/providers` response body contains no substring of
  the secret. The `PROJECT_OAUTH_CONFIG_CHANGED` event's `metadata` contains
  neither the secret nor the `client_id`.
- **Management auth (mutation-checked).** Owner can `GET` / `PUT` / `DELETE`.
  A non-owner developer session → `404` on all three. A secret-key-only
  request → `401`. A publishable-key-only request → `401`. `PUT` with an
  unknown `:provider` → `400`. `PUT` with a body that is neither
  `{clientId,clientSecret}` nor `{disabled:true}` → `400 validation`.
  Mutation: drop the `owner_id` filter in `requireProjectOwnership` → the
  non-owner test must fail.
- **`GET /oauth/providers` param.** Missing `projectId` → `400
  project_id_missing`; malformed → `400 project_id_invalid`; unknown → `404
  project_not_found`; the endpoint is under `oauthLimiter`. A Project with an
  instance GitHub app and a `google` `OVERRIDE` → result contains both;
  after disabling `github` → result contains only `google`.
- **Config-change events.** `configure`, then `disable`, then `clear` each
  write exactly one `PROJECT_OAUTH_CONFIG_CHANGED` with the matching
  `action`; severity `WARNING`; attributed to the owner and the Project.

### Mutation-checked

The cross-Project credential isolation, the signed-`state` cross-Project
rejection, and the owner-write-rejects-non-owner gate. Two Projects seeded
for the isolation checks (not a single Project with a `user_id`-scoped query,
which the wayfinder ticket-02 note flags as a no-op mutation check).

## Out of Scope

- **Arbitrary / extension-point providers per Project.** Built-in google and
  github only (grilling round-1 Q3). A provider kauth ships no `arctic`
  client for stays an instance-level, code-deployed concern via
  `registerOAuthProvider`.
- **Caching decrypted provider clients** — rejected in the grilling (ADR
  0009).
- **A shared kauth-branded OAuth broker** — rejected alternative (ADR 0009).
- **Per-Project callback paths** — rejected alternative (ADR 0009).
- **Rotating `ENCRYPTION_KEY`** or bulk re-encryption of existing secrets.
- **Provider *user* token storage** (`Account.access_token` etc.) — unchanged.
- **Tenant-admin roles** — not built at all (see
  `.scratch/tenant-rbac/spec.md`); Provider-app management is owner-session
  only.
- **The frontend OAuth callback / exchange pages** — batch epic 3
  (`frontend-auth`).
- **Live validation of submitted credentials** against the provider.
- The contract-version bump itself — done in `tenant-rbac`'s backend ticket;
  this half only verifies it.
- Docs-sync — its own ticket.

## Further Notes

- **`CONTEXT.md` already has the term.** **Provider app** was added during the
  grilling session; the docs-sync ticket only verifies it, it does not
  re-add it.
- The instance env config remaining an inheritable default (not
  platform-Project-only) is deliberate — it keeps the single-first-party-app
  deployment and the platform Project's own developer logins zero-config.
- `client_id` is stored plaintext on purpose: it is not a secret (it appears
  in every authorization redirect URL) and the `GET` listing needs to show
  it.
- The signed `state` shares no key material with cookie signing
  (`COOKIE_SECRET`) or the MFA secret — it derives from `ENCRYPTION_KEY`
  under `kauth:oauth-state`, per ADR 0006's blast-radius rule.
- Migration timestamps (the table + enum migration, and the
  `PROJECT_OAUTH_CONFIG_CHANGED` enum migration): **verify each sorts after
  `main`'s latest** before merging.

## Tickets

Per the plan (`.scratch/deferred-closeout/plan.md`):

1. **Backend — flow.** Schema (`ProjectOAuthCredential` + `OAuthCredentialMode`
   + migration), `cryptoBox` context parameter (+ MFA call-site update, +
   cross-context test), `lib/oauthState.ts`, `providers.ts` factory registry +
   `resolveProjectProvider` + `enabledProvidersForProject`,
   `controllers/oauth.ts` (signed `state`, drop `kauth_oauth_project`,
   Project-aware resolution), `GET /oauth/providers?projectId=` +
   `oauthLimiter`, `PROJECT_OAUTH_CONFIG_CHANGED` enum + migration + severity,
   the `registerOAuthProviderFactory` test hook, and all backend tests
   including the full round-trip and signed-`state` cases. **Checks that the
   contract is already `0.7.0`** (landed by `tenant-rbac`); does not bump.
2. **Backend — management surface.** `/projects/:projectId/oauth/providers`
   `GET` / `PUT` / `DELETE`, `projectOAuthCredentialSchema`, the
   `PROJECT_OAUTH_CONFIG_CHANGED` write wiring, owner-auth + encryption-at-rest
   + config-event tests. Blocked by 1. (May merge with 1 — the flow half is
   usable with seeded rows, so the split is clean but not mandatory;
   implementer's call.)
3. **ADR 0009 + `client-sdk` check.** Finalise and commit
   `docs/adr/0009-per-project-oauth-credentials.md` against what shipped;
   update `client-sdk` if it calls `/oauth/providers` (add the `projectId`
   param). Blocked by 2.
4. **Docs-sync.** `docs/roadmap.md` (record per-Project OAuth as shipped, ADR
   0009 in the list), `backend/README.md` / `.env.example` (note the instance
   config is now an inheritable default and per-Project apps exist), the ADR
   index, and a verify pass that `CONTEXT.md`'s **Provider app** entry matches
   what shipped. May fold into ticket 3's merge. Blocked by 3.
