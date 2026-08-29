# 03 — Per-Project Provider apps: storage, resolution, effective list

Status: ready-for-agent

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

- [ ] `ProjectOAuthCredential` + `OAuthCredentialMode` exist with the documented shape; migrations apply cleanly and sort after `main`'s latest
- [ ] Project A with a `stub` `OVERRIDE` (`clientId "A"`) and Project B with its own (`clientId "B"`): `GET /oauth/stub?projectId=A` redirects with A's client id, `?projectId=B` with B's, neither leaks the other
- [ ] **Mutation check:** dropping the `project_id` filter in the `ProjectOAuthCredential` lookup makes the isolation test fail
- [ ] Full round trip under Project A's `stub` `OVERRIDE`: session created, and the stub factory's spy was called once with A's decrypted `clientSecret`
- [ ] A Project with no row runs the full round trip against the instance-default provider (existing `oauth.test.ts` flows still pass)
- [ ] A `DISABLED` row → `GET /oauth/<provider>?projectId=X` is `404`, a forced callback fails `provider_not_found`, and `GET /oauth/providers?projectId=X` omits it; a pre-existing linked `Account` row for that user+provider is still in the DB
- [ ] `GET /oauth/providers` with no `projectId` → `400`; malformed → `400`; unknown → `404`; the route is under `oauthLimiter`; a Project with an instance GitHub app + a `google` `OVERRIDE` lists both
- [ ] `decrypt(row.client_secret_enc, "kauth:project-oauth")` returns the plaintext; `decrypt` under `"kauth:mfa-totp"` throws
- [ ] `PROJECT_OAUTH_CONFIG_CHANGED` is in the enum with `WARNING` severity; the contract version is `0.7.0` and unchanged by this ticket
- [ ] `bun test`, `bun run typecheck`, `bun run lint` all green
