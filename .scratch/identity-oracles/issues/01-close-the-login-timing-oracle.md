# 01 — Close the login timing oracle

Spec: `.scratch/identity-oracles/spec.md`

**What to build:** `login` in `backend/controllers/auth.ts` only calls
`bcrypt.compare` when the user exists and has a credential password, so
response timing distinguishes "unknown account" from "bad password" on an
unauthenticated endpoint. Extract a small credential-password helper
(hash + verify) into `lib/` where the verify side always performs exactly
one comparison — against a lazily precomputed dummy hash when no stored
credential exists — and use it in `login`. The failed-login audit event
keeps its server-side `reason` distinction; only the observable response
timing changes.

**Blocked by:** None

**Status:** done

- [x] A shared `lib/passwords.ts` owns the credential-rounds constant,
      `hashPassword`, and a `verifyPassword` that runs one `bcrypt.compare`
      regardless of whether a stored hash exists (dummy hash otherwise)
- [x] `login` uses `verifyPassword`; behavior is unchanged — unknown
      account and bad password both return 401 / `auth_failed`
- [x] Failed-login audit metadata keeps distinguishing `unknown_account`,
      `no_credential_account`, and `bad_password` (server-side only)
- [x] New integration test: unknown-account login takes at least a fixed
      fraction of the wall-clock time of a bad-password login (relative
      threshold so the test survives machine-speed variance);
      mutation-checked by reverting the fix
- [x] Existing auth tests still pass unchanged

## Deferred (recorded, not built here)

- Registration `duplicate_email` oracle — closing it requires register to
  stop returning tokens (contract change under ADR 0003); see the spec.

## Comments

- 2026-08-24: Implemented as specced. The timing guard is a relative
  median-of-3 assertion (unknown-account vs bad-password wall-clock), so it
  survives machine-speed variance; mutation-checked by short-circuiting
  `verifyPassword` on a missing hash — the test failed (≈11 ms vs ≈100 ms),
  restored. `PASSWORD_HASH_ROUNDS` moved to `lib/passwords.ts`; refresh-token
  verifier hashing keeps its own constant in `controllers/auth.ts` (different
  secret, untouched by this ticket). Full suite 232 pass / 0 fail; typecheck
  and lint clean.
- 2026-08-24 (`/code-review` pass — run inline; the sub-agent provider was
  returning network errors): one real finding — `controllers/account.ts`
  still defined its own `PASSWORD_HASH_ROUNDS = 10`, now duplicated by
  `lib/passwords.ts`. Fixed by routing account.ts's two hash sites through
  `hashPassword`; its `bcrypt.compare` of the current password stays inline
  (authenticated endpoint — no existence oracle to guard against). The
  rounds constant went back to module-private once nothing imported it.

