# 02 — Signed OAuth state, drop the project cookie

Status: done

**What to build:** the OAuth redirect flow carries the Project id inside a
tamper-evident, HMAC-signed `state` value instead of a separate
`kauth_oauth_project` cookie. A stripped or swapped state/cookie can no
longer misroute a callback onto another Project.

- New `lib/oauthState.ts`:
  - `signState(projectId)` → `"<random>.<projectId>.<hmacHex>"` where
    `random` is a CSPRNG value (arctic's `generateState()` or equivalent) and
    `hmacHex = HMAC-SHA256(k, "<random>.<projectId>")`,
    `k = SHA-256(config.encryption_key ‖ "kauth:oauth-state")`.
  - `verifyState(value)` → `{ random, projectId } | null`, constant-time HMAC
    compare.
- `startOAuth`: sets `state = signState(projectId)` and stores that full
  string in the `kauth_oauth_state` cookie (still the CSRF binding). The
  `kauth_oauth_project` cookie is no longer set.
- `oauthCallback`: rejects (`fail("state_mismatch")`) unless the returned
  `state` **both** equals the `kauth_oauth_state` cookie byte-for-byte **and**
  passes `verifyState`. The Project id is read from the verified `state`, then
  re-resolved (`resolveProjectIdOrThrow(..., "signed state")`) for the
  "Project deleted mid-flow" case, attributing `OAUTH_LOGIN_FAILED` to the
  resolved id or `null`.
- `kauth_oauth_project` / `PROJECT_COOKIE` is removed entirely — the
  constant, the `res.cookie`, and the `readAndClearCookie`.
- OAuth login still works end to end (start → callback → exchange → session).

This does **not** change provider resolution yet (still
`getOAuthProvider(providerId)`) — that is ticket 03. No contract change:
`state` is opaque to clients and the project cookie is internal.

**Implementation notes (from `.scratch/project-oauth/spec.md`):**

- `config.encryption_key` is already required and entropy-checked (ADR
  0006) — no new env var.
- `/oauth/exchange` / `exchangeOAuthCode` are unchanged (Project already
  derived from the `OAUTH_EXCHANGE` recovery-token row).
- Prior art: `backend/tests/oauth.test.ts` — the stub provider, the full
  redirect round trip, the existing `state` / cookie assertions.

**Blocked by:** None — can start immediately

- [x] `signState` / `verifyState` round-trip; `verifyState` returns `null` on a bad HMAC, a malformed value, or a wrong-key signature
- [x] Full OAuth round trip (start → callback → exchange → session) still succeeds with no `kauth_oauth_project` cookie anywhere in the exchange
- [x] A callback whose `state` has a valid HMAC but is re-signed for a different Project id (and so mismatches the `kauth_oauth_state` cookie) → `state_mismatch`, no session, `OAUTH_LOGIN_FAILED` recorded
- [x] A callback whose `state` HMAC is garbage → `state_mismatch`
- [x] **Mutation check:** making `verifyState` skip the HMAC comparison, or re-introducing a project-cookie read, makes the wrong-Project test fail
- [x] `PROJECT_COOKIE` / `kauth_oauth_project` no longer appears in the codebase
- [x] `bun test`, `bun run typecheck`, `bun run lint` all green

---

Implemented. New `lib/oauthState.ts` — `signState(projectId)` →
`<arctic generateState()>.<projectId>.<hmacHex>`,
`hmac = HMAC-SHA256(SHA-256(encryption_key ‖ "kauth:oauth-state"), "<random>.<projectId>")`;
`verifyState` splits on `.` (exactly 3 parts), recomputes the HMAC, constant-time
compares via `crypto.timingSafeEqual`, returns `{ random, projectId } | null`.

`controllers/oauth.ts`: `startOAuth` sets `state = signState(projectId)` into the
existing `kauth_oauth_state` cookie and no longer writes `kauth_oauth_project`;
`PROJECT_COOKIE` constant and its `readAndClearCookie` are gone. `oauthCallback`
resolves the attributed project id up front from `verifyState(returnedState)` (not
from a cookie), and the state gate now requires **both** `returnedState ===
stateCookie` byte-for-byte **and** `verifyState` non-null.

Note for ticket 05 / ADR 0009: the cookie holds the **full** signed string and the
check is full-string byte equality (per this ticket), not the "compare only the
random part" phrasing in the ADR draft — align the ADR wording to what shipped.

Tests: `tests/oauthState.test.ts` (6 new unit cases). `tests/oauth.test.ts` —
removed the two `kauth_oauth_project`-tamper tests (cookie no longer exists),
added: garbage-HMAC-that-echoes-the-cookie → `state_mismatch`; validly-signed
state re-minted for another project → `state_mismatch`; project taken from the
signed state not a stray `kauth_oauth_project` cookie (mutation check for a
re-introduced cookie read); redirect asserts no project cookie + 3-part state.
