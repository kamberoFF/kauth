# 04 — Disable with step-up; reset clears enrollment

Spec: `.scratch/mfa/spec.md`

**What to build:** The two lifecycle edges of enrollment: turning it off
(the only step-up'd route in the codebase), and the lost-authenticator
escape hatch via password reset.

**Blocked by:** 02, 03
**Status:** ready-for-agent

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

- [ ] Correct password + correct code disables MFA fully; `GET /mfa`
      reports unenrolled; sessions survive.
- [ ] Wrong password → `401 auth_failed`; wrong code → `401 mfa_code_invalid`;
      neither partially mutates state (**mutation check**: remove the
      password verification and confirm its test goes red).
- [ ] Backup code works as the `code` leg and burns.
- [ ] Timing defense holds on the password leg (dummy-hash path exercised
      for accounts without credentials).
- [ ] Resetting a password on an enrolled user clears enrollment and emits
      `MFA_DISABLED` with reason `password_reset`; reset responses are
      otherwise unchanged from today's shapes.
- [ ] Reset on a social-only account still behaves exactly as today
      (`no_credential_account` path untouched).
- [ ] typecheck, lint, integration suite pass.
