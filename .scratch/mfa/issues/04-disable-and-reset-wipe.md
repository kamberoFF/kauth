# 04 — Disable with step-up; reset clears enrollment

Spec: `.scratch/mfa/spec.md`

**What to build:** The two lifecycle edges of enrollment: turning it off
(the only step-up'd route in the codebase), and the lost-authenticator
escape hatch via password reset.

**Blocked by:** 02, 03
**Status:** done

## Behavior

- **`DELETE /mfa`** body `{ password, code }` (`requireAuth`,
  `tokenSubmissionLimiter`). Both proofs required:
  - password must verify against the credential Account's argon2id hash —
    unknown/no-credential account follows the existing dummy-hash timing
    posture (`lib/passwords.ts`);
  - `code` must pass TOTP (±1 step, replay-guarded) **or** backup-code
    check.
  - Either proof failing → `401 auth_failed` for the password leg,
    `401 mfa_code_invalid` for the code leg (assert codes separately).
  - Success wipes `totp_secret`, `mfa_enrolled_at`, `last_totp_step`,
    `mfa_grace_ends_at`, deletes backup-code rows, keeps all sessions
    alive (no credential changed), records `MFA_DISABLED` (WARNING) with
    `metadata.reason: "user_initiated"`. Responds `{}` per house style.
- **Password reset clears enrollment**: inside `resetPassword`'s existing
  transaction, when the user is enrolled, wipe the same state (plus codes)
  and record `MFA_DISABLED` with `metadata.reason: "password_reset"`. The
  route's outward responses stay byte-identical to today — no new fields,
  no oracle change. This is the deliberate lockout escape hatch: email
  compromise already equals total takeover via reset, so clearing
  enrollment grants the channel nothing it lacked.
- Disabling under an active project mandate drops the user back to
  unenrolled; the wall behavior that follows is ticket 05's concern — this
  ticket only guarantees the wipe is complete and evented.

## Acceptance criteria

- [x] Correct password + correct code disables MFA fully; `GET /mfa`
      reports unenrolled; sessions survive.
- [x] Wrong password → `401 auth_failed`; wrong code → `401 mfa_code_invalid`;
      neither partially mutates state (**mutation check**: remove the
      password verification and confirm its test goes red).
- [x] Backup code works as the `code` leg and burns.
- [x] Timing defense holds on the password leg (dummy-hash path exercised
      for accounts without credentials).
- [x] Resetting a password on an enrolled user clears enrollment and emits
      `MFA_DISABLED` with reason `password_reset`; reset responses are
      otherwise unchanged from today's shapes.
- [x] Reset on a social-only account still behaves exactly as today
      (`no_credential_account` path untouched).
- [x] typecheck, lint, integration suite pass.

## Comments

**2026-08-26 (implement agent).** Shipped as one commit. Implementation notes:

- The disable route claims the wipe with `updateMany` conditioned on
  `mfa_enrolled_at: { not: null }`: a concurrent password reset that lands
  first wins the race, and the losing disable answers `409 mfa_not_enrolled`
  instead of double-wiping or double-eventing. Same conditional shape the
  reset side uses, so whichever proof completes second is a no-op.
- Backup-code burn semantics carry over from sign-in: only an *unused* code
  satisfies the `code` leg (mutation-checked via a code burned through an
  actual challenge completion). On success all rows are deleted per spec,
  so no `BACKUP_CODE_USED` event is written — the audit story is
  `MFA_DISABLED` alone, and a used event would reference a row that no
  longer exists.
- Outstanding `MFA_CHALLENGE` tokens need no cleanup on disable: phase two
  already re-checks `mfa_enrolled_at` before completing (ticket 03's
  "enrollment vanished" branch), so a live challenge simply dies unused.
- Disabling when nothing is enrolled answers the new symmetric
  `409 mfa_not_enrolled`, both for never-enrolled users and after a
  successful disable.
- The credential-less timing test strips the caller's credential Account
 *after* enrollment (prisma delete) — the cheapest honest way to reach the
  dummy-hash path without dragging the OAuth stub machinery in. It carries
  an explicit 30s timeout: ten Argon2id comparisons plus setup can exceed
  bun's default 5s under load.
- All six named mutation checks were run red against the shipped tests:
  password-leg removal, code-leg removal, replay-guard bypass, `used_at`
  filter drop, reset-wipe removal, and credential-less verification skip.
- Failed proofs on `DELETE /mfa` deliberately write **no** security event
  (no `LOGIN_FAILED`, nothing else): the ticket asks for events only on
  success, and the enrollment-verify precedent ("the token submission
  limiter is the control for code guessing; noise-free audit beats noisy
  audit") covers the same guessing shape here. Recorded so the reading is
  a decision, not an omission.
