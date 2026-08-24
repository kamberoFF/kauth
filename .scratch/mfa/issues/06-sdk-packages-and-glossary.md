# 06 — SDK packages, glossary, and roadmap close-out

Spec: `.scratch/mfa/spec.md`

**What to build:** The consumer-facing half of the contract change: both
SDK packages learn the two-phase flow and new project settings; the
domain vocabulary lands in `CONTEXT.md`; the roadmap records the epic.

**Blocked by:** 03, 05
**Status:** ready-for-agent

## Behavior

- **`packages/client-sdk`**: `login()` returns a discriminated result —
  authenticated as before, or `{ mfaRequired: true, challengeToken }`
  with a `finishLogin(challengeToken, code)` companion (name to match the
  package's existing function style). Export the result types. Add a
  README snippet showing the two-step browser and body-token paths,
  including where `mfaGraceEndsAt` surfaces under a mandate. Contract
  constant is already `0.4.0` from ticket 03.
- **`packages/backend-sdk`**: extend Project-settings types for
  `enforce_mfa` / `mfa_grace_days`; README note on the clamp. Nothing
  else — no secret-key route changes exist in this epic.
- **`CONTEXT.md`** gains five glossary entries (implementation-free,
  glossary only — write these, lightly edited to fit house voice):

  - **Second factor** — proof an enrolled User must supply at sign-in
    beyond the first factor (password or social login): a TOTP code or a
    Backup code. Opt-in per User; a Project can mandate it via a Grace
    period. *Avoid*: 2FA; OTP (ambiguous).
  - **Enrollment** — binding a second factor to a User: secret generated
    → confirmed by a first valid code → active. A pending (unconfirmed)
    enrollment challenges nothing at sign-in. *Avoid*: setup; device
    registration (collides with Device id).
  - **Challenge** — the intermediate state between proven credentials and
    session creation for an enrolled User, carried by a single-use,
    short-lived token bound to the Device id that started sign-in.
    Deliberately a 200 response, not an error. *Avoid*: step-up (the
    declined sensitive-action concept); MFA prompt.
  - **Backup code** — single-use offline stand-in for a TOTP code, shown
    exactly once at Enrollment. Distinct from kauth's email recovery
    tokens (password reset / email confirmation / OAuth exchange): those
    prove control of an email channel; a Backup code is something you
    hold offline. *Avoid*: recovery code (collides with
    `recovery_tokens`).
  - **Grace period** — when a Project mandates MFA, the window granted to
    each unenrolled User from first post-policy sign-in, after which
    requests fail with `mfa_enrollment_required` everywhere except the
    enrollment routes and logout. Sign-in itself is never blocked.
    *Avoid*: trial, exemption.

- **`docs/roadmap.md`**: §6 Features — record MFA (TOTP) as done with
  today's date in the same one-pass style as the other entries; leave
  passkeys, RBAC enforcement, and asymmetric signing as the remaining
  bullets; refresh the header "Last reviewed" date and the intro's
  "Next up" sentence to point at what remains.

## Acceptance criteria

- [ ] Client-sdk two-phase flow demonstrated in README snippet matches
      actual server shapes (`mfaRequired`, `challengeToken`,
      `expiresInSeconds`, `deviceId`, `mfaGraceEndsAt` when present).
- [ ] Backend-sdk PATCH types accept the new settings; clamp documented.
- [ ] Both packages' contract-version lockstep tests stay green at 0.4.0.
- [ ] `CONTEXT.md` carries the five entries, glossary-clean (no endpoint
      names, no column names beyond what the terms themselves need).
- [ ] Roadmap §6 updated without disturbing the Done sections' history.
- [ ] Backend typecheck, lint, full integration suite pass.
