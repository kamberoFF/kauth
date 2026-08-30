# 03 — Per-Project Provider apps: storage, resolution, effective list

Status: done

**What to build:** a Project can bring its own OAuth **Provider app**
(`CONTEXT.md`) for a built-in provider (google, github). Its credentials are
stored with the secret encrypted at rest, and the OAuth flow resolves the
right provider per Project — the Project's own app when it has one, the
instance env app otherwise, and nothing at all when the Project has disabled
that provider.

- **Schema:** `ProjectOAuthCredential` — `project_id` (FK,
  `onDelete: Cascade`), `provider_id` (string), `client_id` (plaintext),
  `client_secret_enc` (`cryptoBox` ciphertext, null iff disabled), `mode`
  (new enum `OAuthCredentialMode { OVERRIDE, DISABLED }`), timestamps,
  `@@unique([project_id, provider_id])`. Migration for the table + enum.
- **Factory registry** in `lib/oauth/providers.ts`:
  `registerOAuthProviderFactory(id, creds => OAuthProvider)`. Google and
  GitHub factories registered unconditionally; the *instance* provider is
  registered (via the existing `registerOAuthProvider`) only when its env
  creds are present, so `getOAuthProvider(id)` keeps meaning "instance
  default".
- **`resolveProjectProvider(projectId, providerId)`**: `OVERRIDE` row → build
  via `factory(providerId)` with the decrypted secret
  (`decrypt(_, "kauth:project-oauth")`); `DISABLED` row → `undefined`; no row
  → `getOAuthProvider(providerId)`; nothing → `undefined`. Constructed per
  request, no cache.
- **`enabledProvidersForProject(projectId)`**: the instance set, minus this
  Project's `DISABLED` rows, plus its `OVERRIDE` rows for providers the
  instance lacks.
- `startOAuth` / `oauthCallback` resolve via `resolveProjectProvider`;
  `undefined` → `404 provider_not_found` (start) / `fail("provider_not_found")`
  (callback).
- **`GET /oauth/providers`** now requires `?projectId=` (resolved, `404` on
  unknown), wrapped in `oauthLimiter`, returns
  `enabledProvidersForProject(projectId)`.
- **`PROJECT_OAUTH_CONFIG_CHANGED`** added to `SecurityEventType` (+
  migration) with a `WARNING` severity-map entry. (Written by ticket 04's
  endpoints; the enum lands here so resolution and tests can reference it.)
- Contract is verified to already be `0.7.0` (landed by
  `tenant-rbac` ticket 01) — **this ticket does not bump it**. If for any
  reason `project-oauth` is landing first, do the bump here and note it.

**Implementation notes (from `.scratch/project-oauth/spec.md`):**

- **Test seam:** add `registerOAuthProviderFactory` as a sibling of the
  existing `registerOAuthProvider`. A test registers a `stub` factory whose
  returned provider closes over a test-controlled spy, stores a `stub`
  `OVERRIDE` row for a Project, and drives a full round trip asserting the
  spy received that Project's **decrypted** `clientSecret`.
- `provider_id` is a string, not an enum, to match the string-keyed registry
  and leave room for the `stub` test id.
- Existing linked `Account` rows are untouched by a disable (provider just
  stops resolving) or a credential change (provider subject id is stable
  across OAuth clients).
- `callbackUrl(providerId)` is unchanged — one instance-wide URL per
  provider.
- **Check both migration folder timestamps sort after `main`'s latest**
  before merging (Prisma stamps wall-clock).
- Prior art: `backend/tests/oauth.test.ts`, `backend/tests/cryptoBox.test.ts`,
  `backend/tests/mfaSecurityEvents.test.ts`.

**Blocked by:** 01 (cryptoBox context parameter), 02 (signed `state` —
`oauthCallback` reads the Project id from verified `state`, and both tickets
edit `controllers/oauth.ts`)

- [x] `ProjectOAuthCredential` + `OAuthCredentialMode` exist with the documented shape; migrations apply cleanly and sort after `main`'s latest
- [x] Project A with a `stub` `OVERRIDE` (`clientId "A"`) and Project B with its own (`clientId "B"`): `GET /oauth/stub?projectId=A` redirects with A's client id, `?projectId=B` with B's, neither leaks the other
- [x] **Mutation check:** dropping the `project_id` filter in the `ProjectOAuthCredential` lookup makes the isolation test fail
- [x] Full round trip under Project A's `stub` `OVERRIDE`: session created, and the stub factory's spy was called once with A's decrypted `clientSecret`
- [x] A Project with no row runs the full round trip against the instance-default provider (existing `oauth.test.ts` flows still pass)
- [x] A `DISABLED` row → `GET /oauth/<provider>?projectId=X` is `404`, a forced callback fails `provider_not_found`, and `GET /oauth/providers?projectId=X` omits it; a pre-existing linked `Account` row for that user+provider is still in the DB
- [x] `GET /oauth/providers` with no `projectId` → `400`; malformed → `400`; unknown → `404`; the route is under `oauthLimiter`; a Project with an instance GitHub app + a `google` `OVERRIDE` lists both
- [x] `decrypt(row.client_secret_enc, "kauth:project-oauth")` returns the plaintext; `decrypt` under `"kauth:mfa-totp"` throws
- [x] `PROJECT_OAUTH_CONFIG_CHANGED` is in the enum with `WARNING` severity; the contract version is `0.7.0` and unchanged by this ticket
- [x] `bun test`, `bun run typecheck`, `bun run lint` all green

---

Implemented (`/implement`; `/tdd` seam = the `registerOAuthProviderFactory` hook).

**Schema.** `ProjectOAuthCredential` (`@@unique([project_id, provider_id])`,
`onDelete: Cascade`, `client_secret_enc String?` null iff `DISABLED`) +
`enum OAuthCredentialMode { OVERRIDE, DISABLED }` + `Project.oauthCredentials`.
`PROJECT_OAUTH_CONFIG_CHANGED` added to `SecurityEventType`, `WARNING` in the
`SEVERITY` map. Two migrations — `20260830120000_add_project_oauth_credentials`
(enum + table), `20260830120100_add_project_oauth_config_changed_event`
(`ADD VALUE` alone, its own tx) — both sort after `main`'s `20260829120000`.

**`lib/oauth/providers.ts`.** Factory registry: `factories` map, seeded
unconditionally with `google`/`github`; the *instance* provider still only
registers when its env creds are present, so `getOAuthProvider` /
`enabledProviders` keep meaning "instance default". New
`registerOAuthProviderFactory` / `unregisterOAuthProviderFactory`,
`resolveProjectProvider(projectId, providerId)` (OVERRIDE → `factory(...)` with
`decrypt(enc, "kauth:project-oauth")`; DISABLED / null-secret → `undefined`;
no row → instance default), `enabledProvidersForProject(projectId)` (instance
set − DISABLED + OVERRIDE-for-providers-the-instance-lacks). No cache. Exported
`PROJECT_OAUTH_CONTEXT`.

**`controllers/oauth.ts`.** `listProviders` now async, requires `?projectId=`
(resolved), returns `enabledProvidersForProject`. `startOAuth` resolves the
project id first, then `resolveProjectProvider` → `404 provider_not_found`.
`oauthCallback` resolves the provider *after* the state gate (needs the
verified project id) → `fail("provider_not_found")` on `undefined`; unused
`next` param dropped. `routes/oauth.ts`: `/oauth/providers` gains `oauthLimiter`.

**Tests.** New `tests/projectOAuthCredentials.test.ts` (8) — isolation
(mutation-checked: `findFirst` without the project filter fails it), full
round trip asserting the decrypted `secret-A` reached `validateAuthorizationCode`,
inherit path, disable (start 404 / forced-callback fail / discovery omit /
linked `Account` intact), OVERRIDE-for-uninstanced-provider in the effective
list, secret-at-rest (ciphertext ≠ plaintext, opens only under
`kauth:project-oauth`), enum presence. `tests/oauth.test.ts` updated for the
`?projectId=` requirement on `/oauth/providers` and `/oauth/:provider`.
Full suite 471 pass / 0 fail; typecheck + lint green. Contract stays `0.7.0`.

Note for ticket 04: `resolveProjectProvider` treats a null `client_secret_enc`
on an `OVERRIDE` row as `undefined` (defensive) — the write path must always
pair `OVERRIDE` with a non-null encrypted secret.

Note for ticket 05: `CONTEXT.md`'s **Provider app** term shipped with this
ticket (the model it names now exists); ADR 0009 draft still says "compare the
random part" of `state` while the code compares the full string (ticket 02
note) — reconcile in 05.
