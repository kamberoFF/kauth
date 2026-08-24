# Close the identity oracles

Source: `docs/roadmap.md`, section "3. Close the identity oracles"
(2026-08-24 decision on scope, recorded in the ticket below).

Two unauthenticated endpoints disclose account existence:

1. **Login timing oracle** — `login` skips `bcrypt.compare` when the user
   is unknown (`backend/controllers/auth.ts`), so an unknown-account
   response returns in roughly one DB query while a bad-password response
   pays the full hash cost. Fix: always run exactly one comparison,
   against a precomputed dummy hash when there is no stored credential.
   **In scope.**
2. **Registration email oracle** — `register` returns
   `duplicate_email` (409) on an unauthenticated endpoint. Fully closing
   it means register can no longer auto-login (a duplicate-email caller
   cannot be handed tokens indistinguishable from the happy path), which
   changes the register contract that tickets 05/06 just froze behind
   `X-Kauth-Contract-Version`. **Deferred as accepted residual risk** —
   revisit only by explicitly re-deciding the contract question.
   The `duplicate_username` 409 stays: usernames are user-chosen public
   handles, so a collision reveals nothing about anyone's email address.
