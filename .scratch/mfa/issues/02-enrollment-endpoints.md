# 02 — Enrollment and status endpoints

Spec: `.scratch/mfa/spec.md`

**What to build:** Authenticated routes to bind a second factor: generate a
pending TOTP secret, confirm it with a first valid code, receive backup
codes exactly once, and inspect status.

**Blocked by:** 01
**Status:** ready-for-agent

## Behavior

Routes mount beside the other account routes (`routes/account.ts` idiom,
`requireAuth` + CSRF as usual; reuse `tokenSubmissionLimiter` on the
verify route).

- **`POST /mfa/enrollment`** — refuses when already enrolled with
  `409 mfa_already_enrolled`; otherwise generates a fresh secret, stores
  AES-256-GCM ciphertext in `user.totp_secret` (leaving
  `mfa_enrolled_at` null = *pending*), and responds
  `{ otpauthUri, secret }` (plaintext secret shown once for manual
  entry; QR rendering is client-side). Calling again while pending
  replaces the pending secret — the old one dies.
- **`POST /mfa/enrollment/verify`** body `{ code }` — verifies against the
  pending secret (±1 step). Wrong/expired code → `401 mfa_code_invalid`
  (throttled by the limiter; deliberately **no** security event — the
  limiter is the control, and noise-free audit beats noisy audit here).
  Correct code → sets `mfa_enrolled_at`, seeds `last_totp_step` from the
  matched step, clears `mfa_grace_ends_at`, deletes any stale backup
  codes, generates **10** backup codes (8-char base32 pairs, `XXXX-XXXX`),
  persists SHA-256 hashes, and records `MFA_ENROLLED` (WARNING) — the
  `MFA_ENROLLMENT_STARTED` event belongs to generation, not verify.
  Responds `{ backupCodes }` **exactly once**; plaintext is never
  recoverable afterwards.
- **`GET /mfa`** — `{ enrolled, graceEndsAt?, backupCodesRemaining? }`;
  counts only unused codes; `graceEndsAt` surfaces when set.
- Pending enrollment challenges nothing at sign-in — that wiring lands in
  ticket 03; this ticket only must not disturb existing flows.

## Acceptance criteria

- [ ] Start → verify happy path yields enrolled state and a one-time
      backup-code list; `GET /mfa` reflects enrolled + remaining count.
- [ ] Verifying an invalid code returns `401 mfa_code_invalid` and leaves
      state pending (retry with a fresh code still succeeds).
- [ ] Enrollment while enrolled is refused `409 mfa_already_enrolled`
      (**mutation check**: delete the guard and confirm this test goes red).
- [ ] Regenerating a pending enrollment invalidates the previous secret
      (old secret's codes now fail).
- [ ] Backup codes are stored hashed only; DB inspection shows no
      plaintext material.
- [ ] `MFA_ENROLLMENT_STARTED` (at generation) and `MFA_ENROLLED` (at
      verify) land with derived severities; no severity passed per call.
- [ ] Unenrolled users' login/register/oauth flows are byte-identical to
      before this ticket (full suite green unchanged).
- [ ] typecheck, lint, integration suite pass.
