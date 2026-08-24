# 03 — Two-phase login: challenge issue, verify, and contract 0.4.0

Spec: `.scratch/mfa/spec.md`

**What to build:** The heart of the epic. Enrolled sign-ins become
two-phase at both password login and OAuth exchange; a device-bound
single-use challenge token bridges the phases; the contract version bumps
to 0.4.0 across backend and both SDKs.

**Blocked by:** 01
**Status:** ready-for-agent

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

- [ ] Enrolled password login returns the 200 challenge shape with no
      cookies set and no session rows created.
- [ ] Phase two completes with body tokens for opt-in clients and cookies
      for `cookieClient()` browsers; prior same-device session is revoked
      `replaced_by_new_login` exactly as a normal login would.
- [ ] Challenge token single-use: second presentation → `400 token_invalid`
      (**mutation check**: drop the consumed-at guard and confirm this test
      goes red).
- [ ] Device binding: phase two from a different device id → uniform
      `400 token_invalid` (**mutation check**: remove the comparison and
      confirm this test goes red).
- [ ] Expired (>5 min) and never-issued tokens → `400 token_invalid`.
- [ ] Reissuing a challenge invalidates the previous token.
- [ ] TOTP ±1 step accepted, ±2 rejected; reusing the exact matched step
      later fails via the replay guard (**mutation check**: bypass
      `last_totp_step` and confirm this test goes red).
- [ ] Backup code completes a challenge exactly once; reuse fails.
- [ ] Wrong code → `401 mfa_code_invalid` + `LOGIN_FAILED`
      `mfa_code_invalid`; token still usable within TTL.
- [ ] Enrolled OAuth exchange returns the same challenge shape; phase two
      yields a normal session with provider-derived context preserved.
- [ ] Server advertises `x-kauth-contract-version: 0.4.0`; lockstep test
      across backend + both SDKs green.
- [ ] typecheck, lint, full integration suite pass.
