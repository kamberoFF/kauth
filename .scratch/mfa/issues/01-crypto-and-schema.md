# 01 — Crypto foundation, schema, and ADR 0006

Spec: `.scratch/mfa/spec.md`

**What to build:** The dependencies, encryption helper, env knob, one
Prisma migration, pure TOTP helpers, and the ADR every later ticket stands
on.

**Blocked by:** None
**Status:** done

## Behavior

- **Dependencies**: add `@oslojs/otp` and `@oslojs/encoding` (runtime).
  Nothing else — QR stays client-side.
- **Config**: `ENCRYPTION_KEY` becomes a required zod env var (base64 or
  hex, ≥32 bytes of entropy; fail fast at startup like
  `JWT_SECRET`/`COOKIE_SECRET`, prod strictness per existing rules). This
  is a breaking change for operators: greenfield, no deployments exist,
  so it rides the same 0.4.0 wave as everything else.
- **`backend/lib/cryptoBox.ts`**: AES-256-GCM. `encrypt(plaintext)` →
  base64(`iv ‖ tag ‖ ciphertext`) with a fresh random 12-byte IV per call;
  `decrypt` verifies the auth tag and throws on tamper. Derive the actual
  key via SHA-256 over (`ENCRYPTION_KEY` ‖ `"kauth:mfa-totp"`) so a future
  consumer can namespace its own subkey without sharing ours.
- **Pure helpers** (same lib or `lib/totp.ts`): generate a 20-byte secret
  as RFC 4648 base32 (via `@oslojs/encoding`), build the
  `otpauth://totp/{label}?secret=…&issuer=kauth&algorithm=SHA1&digits=6&period=30`
  URI (label = project-scoped user email or username — pick the least
  leaky available at the call site).
- **Migration** (single):
  - `users`: `totp_secret TEXT NULL`, `mfa_enrolled_at TIMESTAMPTZ NULL`,
    `mfa_grace_ends_at TIMESTAMPTZ NULL`, `last_totp_step INTEGER NULL`
    (snake_case, Prisma-camelCase mapping per repo convention).
  - New table `mfa_backup_codes` (`MfaBackupCode`): uuid pk, `user_id` FK
    cascade, `code_hash TEXT UNIQUE` (sha256 hex), `used_at TIMESTAMPTZ
    NULL`, `created_at`; index `[user_id]`.
  - `recovery_tokens`: new enum value `MFA_CHALLENGE` on `TokenType`; new
    nullable column `device_id UUID`.
  - `projects`: `enforce_mfa BOOLEAN NOT NULL DEFAULT false`,
    `mfa_grace_days INTEGER NULL`.
  - `SecurityEventType` gains `MFA_ENROLLMENT_STARTED`, `MFA_ENROLLED`,
    `MFA_DISABLED`, `BACKUP_CODE_USED`, `PROJECT_MFA_POLICY_CHANGED`;
    extend the static severity map in `lib/securityEvents.ts`:
    INFO / WARNING / WARNING / WARNING / WARNING respectively. No call
    sites yet.
- **ADR 0006** — `docs/adr/0006-mfa-secret-encryption-at-rest.md`: record
  the decision (dedicated required `ENCRYPTION_KEY`, AES-256-GCM, namespaced
  derivation) against the alternatives — plaintext column (rejected),
  deriving from `JWT_SECRET` (rejected: couples rotation of unrelated
  secrets, and JWT compromise would then also decrypt MFA secrets),
  external KMS (out of scope for self-hosted). Meets all three bars:
  hard to reverse (ciphertext lands in schema), surprising later (new
  operator-required env var), real trade-off.

## Acceptance criteria

- [x] `bunx --bun prisma migrate deploy` applies cleanly against a fresh
      test DB; generated client exposes the new fields.
- [x] Missing or short `ENCRYPTION_KEY` fails startup fast (zod), matching
      the existing secret-key error style.
- [x] `cryptoBox` round-trips arbitrary payloads; two encryptions of the
      same input differ (random IV); a flipped ciphertext bit throws.
- [x] Helpers produce valid base32 secrets and a spec-conformant otpauth
      URI (assert parseable params, not string equality).
- [x] Severity map covers all five new types; `recordSecurityEvent`
      derives them without per-call severity.
- [x] ADR 0006 exists and names the rejected alternatives.
- [x] typecheck, lint, integration suite pass (no behavior change yet).

## Answer

Implemented on main in one commit. un test: 293 pass, 0 fail (27
files); typecheck and lint clean. Mutation checks run by hand and named at
their test sites: swallowing GCM's auth failure turns both cryptoBox tamper
tests red; mapping MFA_ENROLLED to INFO turns the severity-derivation test
red; widening the TOTP window to ±2 steps turns the stale-code rejection red.

Two deliberate deviations from the ticket's literal wording, both recorded
where they will be rediscovered:

- The ticket sketched the new timestamp columns as TIMESTAMPTZ. Kept
  Prisma's default TIMESTAMP(3) instead: every existing DateTime in this
  schema maps that way, and running two time regimes across columns costs
  more than the annotation would buy. Noted on the 	otp_secret doc comment
  in schema.prisma.
- ENCRYPTION_KEY validation also accepts unpadded base64url (a superset of
  the stated "base64 or hex"); normalization to trimmed value happens once,
  inside the zod schema.

Scope notes for later tickets: TTL_MS.MFA_CHALLENGE (5 min) is populated
now because the map is exhaustively typed; issuance/verification remain
ticket 03. projects.enforce_mfa / mfa_grace_days land as inert columns;
behavior is ticket 05. Glossary entries stay with ticket 06 per plan.
