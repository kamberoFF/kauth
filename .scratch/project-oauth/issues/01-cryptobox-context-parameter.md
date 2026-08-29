# 01 — cryptoBox context parameter (prefactor)

Status: done

**What to build:** `lib/cryptoBox.ts` stops hard-coding its key-derivation
context so a second encrypted-at-rest consumer can derive its own subkey from
the same `ENCRYPTION_KEY` without sharing the MFA one — the extension ADR
0006 explicitly anticipated ("a future consumer derives its own subkey from
the same `ENCRYPTION_KEY` under a different context label").

- `encrypt` / `decrypt` take the derivation-context label as an argument
  (either `encrypt(plaintext, context)` / `decrypt(payload, context)` or a
  `cryptoBox(context) => { encrypt, decrypt }` factory — implementer's call).
- Every current call site (MFA TOTP secret) passes `"kauth:mfa-totp"`.
  Behaviour and on-disk ciphertext are unchanged — an existing enrolled
  secret still decrypts.
- A ciphertext sealed under one context must fail to decrypt under another
  (GCM auth tag + distinct derived key already guarantee this; this ticket
  adds the test).

No new consumer is introduced here — `"kauth:project-oauth"` arrives in
ticket 03. This is pure "make the change easy".

**Implementation notes (from `.scratch/project-oauth/spec.md`):**

- Prior art: `backend/tests/cryptoBox.test.ts`,
  `backend/tests/configEncryptionKey.test.ts`.
- The MFA enrollment / disable / challenge suites are the regression proof —
  they must stay green with no edits beyond the call-site argument.

**Blocked by:** None — can start immediately

- [x] `encrypt` / `decrypt` accept a context label; MFA call sites pass `"kauth:mfa-totp"`
- [x] An MFA secret encrypted before this change still decrypts after it (round-trip test with a fixed context)
- [x] A ciphertext sealed under `"kauth:mfa-totp"` throws when decrypted under a different context label
- [x] The MFA suites pass unchanged except for the added call-site argument
- [x] `bun test`, `bun run typecheck`, `bun run lint` all green

---

Implemented in this commit. `encrypt(plaintext, context)` / `decrypt(payload, context)`
(positional form — matches the phrasing in tickets 02 and 03). `controllers/mfa.ts`
passes `TOTP_SECRET_CONTEXT = "kauth:mfa-totp"` at all four call sites. Regression
proof: a frozen ciphertext sealed by the pre-context implementation still decrypts
under `"kauth:mfa-totp"`. Full suite 453 pass / 0 fail.
