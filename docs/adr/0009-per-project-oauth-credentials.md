# Per-Project OAuth credentials

## Context

kauth's Google/GitHub OAuth apps are configured once per instance, by env
var. As a multi-tenant platform that is wrong by default: every tenant's
end users would authenticate against the operator's OAuth client, and the
operator running Google for their own first-party app would force every
Project onto that same client. But the instance config is still the right
*default* for the single-first-party-app deployment and for the platform
Project's own developer logins. So both have to coexist.

## Decision

Each Project may register its own **Provider app** (`CONTEXT.md`) for a
built-in provider (google, github — the two kauth has an arctic client for;
custom providers stay an instance-level, code-deployed concern via
`registerOAuthProvider`).

- **Storage.** New `ProjectOAuthCredential` table, one row per
  `(project_id, provider_id)` (`@@unique`, `onDelete: Cascade` from
  `Project`). `client_id` plaintext (it is public — it rides in redirect
  URLs); `client_secret_enc` AES-256-GCM via `lib/cryptoBox.ts` under a new
  derivation namespace, `kauth:project-oauth`, so it shares key material with
  neither cookie signing nor the MFA secret (ADR 0006's blast-radius rule).
  A `mode` column (`enum OAuthCredentialMode`): `OVERRIDE` (creds present,
  used instead of the instance app) or `DISABLED` (`client_secret_enc` null,
  suppresses the inherited instance provider). Absent row = inherit.
- **Precedence.** Instance config is an inheritable default for every
  Project. A Project's own Provider app fully replaces it per-Project; a
  Project can also disable a provider entirely. `GET /oauth/providers`
  gains a required `projectId` and returns that Project's effective set.
- **Callback URL and project binding.** One instance-wide callback URL per
  provider, unchanged — every Project's Provider app registers that exact
  URI. The project id travels in a signed `state` (`lib/oauthState.ts`):
  `<random>.<projectId>.<hmacHex>`, `hmacHex = HMAC-SHA256(k, "random.projectId")`,
  `k` derived as `SHA-256(ENCRYPTION_KEY ‖ "kauth:oauth-state")`. At callback
  the full returned `state` string is still compared byte-for-byte against
  the `kauth_oauth_state` cookie (the unchanged CSRF binding), **and**
  `verifyState` must recompute the HMAC successfully; either failure is one
  indistinguishable `state_mismatch`. `projectId` is then read straight from
  the verified `state` and re-resolved (the Project can be deleted
  mid-flow). The separate `kauth_oauth_project` cookie is removed entirely —
  the constant, the `res.cookie`, and the `readAndClearCookie`.
- **Provider resolution.** A new `resolveProjectProvider(projectId,
  providerId)` in `lib/oauth/providers.ts`; `getOAuthProvider` /
  `enabledProviders` keep meaning "the instance default". Built-in provider
  builders move into a factory registry (`registerOAuthProviderFactory`,
  registered unconditionally at module load; the *instance* provider is
  still only registered when its env creds are present).
  `resolveProjectProvider` does per-request construction of the arctic
  client from decrypted creds (no cache — OAuth starts are rare): a usable
  `OVERRIDE` row → `factory(decrypted creds)`; a `DISABLED` row or an
  override with no buildable client → `undefined`; no row → the instance
  default. `enabledProvidersForProject` mirrors the same rule for the login
  page. `undefined` → `404 provider_not_found` at start,
  `fail("provider_not_found")` (redirect with `?error=`) at callback.
- **Management.** Owner-session only (`requireAuth, requireProjectOwnership`),
  under `/projects/:projectId/oauth/providers` — `GET` (effective config,
  never the secret), `PUT /:provider` (`{clientId, clientSecret}` →
  `OVERRIDE`; `{disabled: true}` → `DISABLED`; unknown `:provider` →
  `400 provider_not_found`), `DELETE /:provider` (drop the row → inherit;
  `404 provider_not_configured` when none). A secret key is rejected at
  `requireAuth` before ownership runs (project config is a developer
  concern, user stories 10/19). No credential validation on write.
  `PROJECT_OAUTH_CONFIG_CHANGED` (WARNING) is written in the same
  transaction as each credential change, `metadata { provider, action }`
  where `action` ∈ `configured | disabled | cleared`; the secret and the
  `client_id` never reach a response or audit metadata.

## Alternatives considered

- **A shared kauth-branded OAuth broker** that every tenant proxies
  through — rejected: it makes kauth the OAuth client of record for every
  tenant's users, which is precisely the "identity data lives on someone
  else's app" problem the self-hosted platform exists to avoid.
- **Per-Project callback paths** (`/oauth/google/callback/:projectId`) —
  rejected: multiplies redirect-URI registration friction for every tenant
  with no security gain over a signed `state`.
- **Caching decrypted provider clients** — rejected as a speculative
  mechanism; an OAuth start is rare enough that a decrypt plus
  `new Google()` per request is not worth an invalidation path.

## Consequences

- Disabling a provider for a Project removes it as a login path for users
  who already linked it; the `Account` row is kept and a later re-enable
  restores the path. Changing credentials does not orphan links — the
  provider subject id is stable across OAuth clients.
- Losing `ENCRYPTION_KEY` now also loses every Provider app secret
  (Projects re-enter them); consistent with ADR 0006's
  recoverable-failure direction.
- Contract version bumps to 0.7.0 (shared with the tenant-RBAC half of the
  same epic; the bump itself lands in the tenant-RBAC backend ticket, this
  half only verifies it).
- Two migrations: `20260830120000_add_project_oauth_credentials`
  (`OAuthCredentialMode` enum + `project_oauth_credentials` table) and
  `20260830120100_add_project_oauth_config_changed_event`
  (`SecurityEventType` enum value, its own transaction per PG's
  `ADD VALUE` rule).
