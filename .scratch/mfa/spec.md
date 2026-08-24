# MFA: TOTP second factor with backup codes, optional project mandate

Source: `docs/roadmap.md`, section "6. Features" (first bullet). Design settled
with the user over a grilling session on 2026-08-25. Passkeys are explicitly
**not** in this epic — they may reuse the second-factor vocabulary pinned here,
but nothing in these tickets anticipates them.

## Decisions

- **Scope**: TOTP enrollment + challenge + single-use backup codes +
  lost-authenticator escape hatch (password reset clears enrollment).
- **Two-phase login**: an enrolled user's `POST /login` answers
  **200 `{ mfaRequired: true, challengeToken, expiresInSeconds, deviceId }`**
  — deliberately *not* an error body, so the `{ error }`-only convention
  (`middlewares/error.ts`) stays intact. Phase two is a new
  `POST /mfa/challenge`. The challenge token is a `RecoveryToken` of new type
  `MFA_CHALLENGE`: ~5-min TTL, single-use, one live per user (reissue
  consumes the prior), bound to the device id that started login.
- **Social logins are challenged uniformly** at `POST /oauth/exchange` —
  same shape, same endpoint family. No OAuth bypass.
- **Contract 0.4.0**, coordinated: any shape change forces the version bump
  in `backend/package.json` *and* both SDK `version.ts` constants in the
  same epic (ADR 0003 hard-fail discipline). Even purely additive MFA routes
  count as breaking.
- **Step-up is narrow**: only `DELETE /mfa` demands current password **and**
  a valid code. The broader "verified recently" step-up framework was
  discussed and declined outright — parked nowhere, not on the roadmap.
- **Project mandate with grace** (sequenced last): `enforce_mfa` +
  `mfa_grace_days` (owner-settable, clamp 3–90, default 7) on Project.
  Sign-in is *never* blocked; unenrolled users get a per-user grace window
  stamped at credential verification, and `requireAuth` walls them with
  `403 mfa_enrollment_required` once it lapses — except `/mfa/*` routes and
  `POST /logout`, so self-service escape always exists.
- **Library**: `@oslojs/otp` + `@oslojs/encoding` (same ecosystem as arctic).
  RFC defaults: SHA-1, 6 digits, 30 s period, ±1 step window, 20-byte
  base32 secret. Server returns an `otpauth://` URI string; QR rendering is
  a client-side concern.
- **Secrets at rest**: the TOTP secret must be recoverable, so it is stored
  AES-256-GCM-encrypted under a new **required** `ENCRYPTION_KEY` env var
  (ADR 0006 records why a dedicated key rather than deriving from
  `JWT_SECRET`). Backup codes are 128-bit random, stored SHA-256-hashed —
  same justification as recovery tokens.
- **Replay guards**: a successful TOTP check records the matched time-step;
  codes at or below the last-used step are rejected. Backup codes burn on
  use via conditional update.
- **Rate limiting**: code-submitting endpoints reuse the existing
  `tokenSubmissionLimiter` (IP, 20/15min) rather than new limiter classes;
  failed attempts surface through `LOGIN_FAILED` metadata where applicable.

## Shared invariants across tickets

- New security-event types (severity via the static map in
  `lib/securityEvents.ts`, never per call site): `MFA_ENROLLMENT_STARTED`
  (INFO), `MFA_ENROLLED` (WARNING), `MFA_DISABLED` (WARNING),
  `BACKUP_CODE_USED` (WARNING), `PROJECT_MFA_POLICY_CHANGED` (WARNING).
  `LOGIN_SUCCESS` gains `metadata.method` (`totp` | `backup_code`);
  `LOGIN_FAILED` gains reason `mfa_code_invalid`.
- Errors stay `appError`-shaped; assert on codes in tests.
- Every security-property test carries a named mutation check.

Tickets: `issues/01-crypto-and-schema.md`,
`issues/02-enrollment-endpoints.md`,
`issues/03-two-phase-login-challenge.md`,
`issues/04-disable-and-reset-wipe.md`,
`issues/05-project-mandate-grace.md`,
`issues/06-sdk-packages-and-glossary.md`.
