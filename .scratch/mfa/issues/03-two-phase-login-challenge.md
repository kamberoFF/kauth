# 03 — Two-phase login: challenge issue, verify, and contract 0.4.0

Spec: `.scratch/mfa/spec.md`

**What to build:** The heart of the epic. Enrolled sign-ins become
two-phase at both password login and OAuth exchange; a device-bound
single-use challenge token bridges the phases; the contract version bumps
to 0.4.0 across backend and both SDKs.

**Blocked by:** 01
**Status:** done

## Behavior

- **Interposition point**: in `login` (`controllers/auth.ts`) and
  `exchangeOAuthCode` (`controllers/oauth.ts`), after all existing gates
  pass (credentials verified; email-verified gate where applicable) and
  immediately before session creation: if `user.mfa_enrolled_at` is set,
  do **not** create a session. Respond **200**
  `{ mfaRequired: true, challengeToken, expiresInSeconds: 300, deviceId }`.
  No cookies are set; no `Session`/`RefreshToken` rows exist yet;
  `replaced_by_new_login` revocation does **not** fire until phase two.
  Unenrolled users' flows stay byte-identical to today.
- **Challenge token**: a `RecoveryToken` row of type `MFA_CHALLENGE` —
  32-byte base64url value stored SHA-256-hashed (recovery-token idiom),
  TTL 5 minutes, `device_id` set to the resolved device of phase one.
  Issuing consumes any prior unconsumed `MFA_CHALLENGE` rows for the user
  (one live token per user, matching the recovery-token pattern).
  Record `MFA_ENROLLMENT_STARTED`? No — no event on issuance; the audit
  story is `LOGIN_FAILED`/`LOGIN_SUCCESS` at verify time.
- **`POST /mfa/challenge`** body `{ challengeToken, code }`
  (`resolveDevice` → `tokenSubmissionLimiter`):
  - Any bad token state — unknown, expired, already consumed, or bound to
    a different resolved device id — answers the same uniform
    `400 token_invalid` (no oracle between failure kinds).
  - `code` accepts a TOTP (±1 step) or a backup code. TOTP path enforces
    the step replay guard against `last_totp_step`; backup path burns via
    conditional update and records `BACKUP_CODE_USED` (WARNING).
  - Success runs the exact existing completion sequence inside one
    transaction: `revokeSessions(replaced_by_new_login)` → `createSession`
    → `LOGIN_SUCCESS` with `metadata.method: "totp" | "backup_code"` —
    then responds through `sendAuthResponse` (cookies + body-token opt-in,
    deviceId), status 200.
  - Wrong code → `401 mfa_code_invalid`, plus `LOGIN_FAILED` with
    `metadata.reason: "mfa_code_invalid"` (token stays live until TTL).
- **Contract bump**: backend `package.json` → `0.4.0`;
  `packages/client-sdk/src/version.ts` and
  `packages/backend-sdk/src/version.ts` → `"0.4.0"` so
  `tests/contractVersion.test.ts` stays green. (SDK *behavior* updates are
  ticket 06's scope.)

## Acceptance criteria

- [x] Enrolled password login returns the 200 challenge shape with no
      cookies set and no session rows created.
- [x] Phase two completes with body tokens for opt-in clients and cookies
      for `cookieClient()` browsers; prior same-device session is revoked
      `replaced_by_new_login` exactly as a normal login would.
- [x] Challenge token single-use: second presentation → `400 token_invalid`
      (**mutation check**: drop the consumed-at guard and confirm this test
      goes red).
- [x] Device binding: phase two from a different device id → uniform
      `400 token_invalid` (**mutation check**: remove the comparison and
      confirm this test goes red).
- [x] Expired (>5 min) and never-issued tokens → `400 token_invalid`.
- [x] Reissuing a challenge invalidates the previous token.
- [x] TOTP ±1 step accepted, ±2 rejected; reusing the exact matched step
      later fails via the replay guard (**mutation check**: bypass
      `last_totp_step` and confirm this test goes red).
- [x] Backup code completes a challenge exactly once; reuse fails.
- [x] Wrong code → `401 mfa_code_invalid` + `LOGIN_FAILED`
      `mfa_code_invalid`; token still usable within TTL.
- [x] Enrolled OAuth exchange returns the same challenge shape; phase two
      yields a normal session with provider-derived context preserved.
- [x] Server advertises `x-kauth-contract-version: 0.4.0`; lockstep test
      across backend + both SDKs green.
- [x] typecheck, lint, full integration suite pass.

## Comments

**2026-08-25 (implement agent).** Shipped as one commit. Implementation notes:

- The consumed-at control lives in two layers — the peek gate and the
  conditional claim inside the transaction (the latter closes the
  concurrent-race window). The replay guard is likewise two-layer: a fast-path
  pre-check and an atomic compare-and-set in the transaction. Both layers are
  required (the peek gate alone would answer a consumed token's *wrong code*
  with 401 instead of the uniform 400; the pre-check alone has a read-check
  race), so the mutation checks above pass only when **both** layers of a
  control are killed at once — verified red in that configuration.
- Tests must present a step strictly newer than the enrollment's recorded
  `last_totp_step` (`freshCode` helper): completing within the same 30s window
  as enrollment is *correctly* rejected as replay, which the tests otherwise
  trip over.
- A challenge whose enrollment vanished between phases answers the uniform
  `400 token_invalid` (no session can be completed against a user with no
  second factor). Ticket 04 may want to revisit this when defining what
  disabling does to outstanding challenges.
- `issueRecoveryToken` grew an optional `deviceId` argument (MFA_CHALLENGE
  only); all existing call sites are unaffected.
