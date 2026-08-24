# 02 — Enrollment and status endpoints

Spec: `.scratch/mfa/spec.md`

**What to build:** Authenticated routes to bind a second factor: generate a
pending TOTP secret, confirm it with a first valid code, receive backup
codes exactly once, and inspect status.

**Blocked by:** 01
**Status:** done

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

- [x] Start → verify happy path yields enrolled state and a one-time
      backup-code list; `GET /mfa` reflects enrolled + remaining count.
- [x] Verifying an invalid code returns `401 mfa_code_invalid` and leaves
      state pending (retry with a fresh code still succeeds).
- [x] Enrollment while enrolled is refused `409 mfa_already_enrolled`
      (**mutation check**: delete the guard and confirm this test goes red).
- [x] Regenerating a pending enrollment invalidates the previous secret
      (old secret's codes now fail).
- [x] Backup codes are stored hashed only; DB inspection shows no
      plaintext material.
- [x] `MFA_ENROLLMENT_STARTED` (at generation) and `MFA_ENROLLED` (at
      verify) land with derived severities; no severity passed per call.
- [x] Unenrolled users' login/register/oauth flows are byte-identical to
      before this ticket (full suite green unchanged).
- [x] typecheck, lint, integration suite pass.

## Answer

Implemented on main in one commit. Full suite: 305 pass, 0 fail (28 files);
typecheck and lint clean. All three named mutation checks were run by hand and
each turned its test red before being restored:

- deleting the enrolled guard in `startMfaEnrollment` → the 409 test goes red;
- storing plaintext instead of `hashBackupCode` output → the hashed-only
  assertions in the happy-path test go red;
- making a restart keep the previous secret → the stale-secret-invalidation
  test goes red.

New pieces: `lib/backupCodes.ts` (generate/normalize/hash),
`controllers/mfa.ts`, `routes/mfa.ts` mounted in `app.ts`,
`tests/mfaEnrollment.test.ts` (12 tests), plus `mfaCodeSchema` in
`lib/validation.ts`.

Decisions worth rediscovering:

- **Backup-code entropy deviates from the spec on purpose.** The spec says
  "128-bit random"; this ticket pins `XXXX-XXXX` (8 base32 chars = 40 bits).
  The ticket's concrete format won: typeability is the point of a code read
  off paper mid-lockout, online guessing is bounded by the token submission
  limiter, each hit burns one code and raises a WARNING event. Rationale is a
  doc comment in `lib/backupCodes.ts`; revisit only under a real threat model.
- **Verify without a pending enrollment** (never started, or already done)
  answers `409` with distinct codes `mfa_not_pending` vs
  `mfa_already_enrolled`. The ticket didn't specify; conflict beats 404 so the
  endpoint doesn't become an enrollment-state oracle to unauthenticated eyes
  (it is auth-gated anyway).
- **Concurrency, both directions.** Both lifecycle writes are conditional
  updates against the row still being pending: the enrollment flip also pins
  `totp_secret` to the exact ciphertext that was matched, so a restart that
  slips in between verify's read and write voids that verification (`409
  mfa_not_pending`, re-read to name it) instead of enrolling the unconfirmed
  replacement — and a start landing after a confirm refuses with
  `mfa_already_enrolled` rather than overwriting an enrolled user's secret.
  Closed by construction; a black-box test cannot deterministically interleave
  mid-request without instrumenting the server, so no race test exists. Backup
  codes are wiped then reseeded inside the same transaction, so stale codes
  from an earlier life can never survive.
- **Backup-code matching is dash-, case-, and whitespace-insensitive**
  (`normalizeBackupCode`): users transcribe codes by hand and paste them with
  artifacts; one regex covers all three. Display always emits `XXXX-XXXX`.
- **Route order:** `requireAuth` before `tokenSubmissionLimiter` on the verify
  route — only authenticated submissions spend the shared IP budget;
  unauthenticated noise dies at the cheaper check (global limiter still caps
  raw floods).
- **Validation boundary:** `code` accepts any string 1–20 chars; shape-invalid
  bodies get `400 validation`, well-formed-but-wrong codes get
  `401 mfa_code_invalid` via `matchTotpStep`'s regex. Tests pin both sides.
- **Test-side hash expectation** recomputes plain sha256 over the canonical
  form independently of `lib/backupCodes`, so the hashed-only property isn't
  circularly trusted.
