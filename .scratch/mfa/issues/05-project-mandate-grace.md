# 05 — Project mandate with grace period

Spec: `.scratch/mfa/spec.md`

**What to build:** Owner-settable mandatory MFA per Project with a clamped
per-user grace window — enforced by walling usage in `requireAuth`, never
by blocking sign-in.

**Blocked by:** 02
**Status:** ready-for-agent

## Behavior

- **Settings**: `PATCH /projects/:id` (owner-only, alongside
  `min_password_length`) accepts `enforce_mfa: boolean` and
  `mfa_grace_days: int` clamped to **3–90**, default **7** when unset at
  activation. Validation errors follow existing project-PATCH error codes.
  Flipping either records `PROJECT_MFA_POLICY_CHANGED` (WARNING).
- **Activation backfill**: setting `enforce_mfa = true` stamps
  `mfa_grace_ends_at = now + grace_days` once, in the PATCH transaction,
  for the Project's currently-active unenrolled users (so nobody is walled
  instantly). Users who enroll later keep their cleared stamp semantics.
- **Stamping at entry points**: a shared helper called in the register /
  login-phase-one / oauth-exchange transactions: when the Project mandates
  MFA and the user is unenrolled and `mfa_grace_ends_at` is null, set it
  to `now + grace_days`. Idempotent; never shortens an existing window.
  When stamping applies, phase-one responses (and register/exchange
  success bodies) gain optional `mfaGraceEndsAt` (ISO string).
- **The wall**: widen `requireAuth`'s existing single `findUnique` with
  nested selects (`user { mfa_enrolled_at, mfa_grace_ends_at }`,
  `project { enforce_mfa }`) — still one query, honoring the deliberate
  DB-per-request stance. New branch after the expiry checks:
  `project.enforce_mfa && !user.mfa_enrolled_at && user.mfa_grace_ends_at
  && now > user.mfa_grace_ends_at` → `403 mfa_enrollment_required`.
  An unenrolled user with **no** stamp under active policy is also walled
  (entry points always stamp, so this state means "wiped post-disable").
  - Exemptions where self-service must survive: anything under `/mfa` and
    `POST /logout`. Everything else walls — including refresh-adjacent
    reads; note refresh itself is *not* `requireAuth`-gated and stays open
    deliberately (the wall blocks usage anyway; sessions still expire
    naturally; no hot-path change there).
- **Coherence property**: disabling MFA while the mandate is active leaves
  no grace stamp, so the current session walls immediately — the mandate
  needs no special case for disable.
- Mandate off → branch inert; stale stamps harmless.

## Acceptance criteria

- [ ] Owner sets/clears `enforce_mfa` and `mfa_grace_days`; out-of-clamp
      values rejected; `PROJECT_MFA_POLICY_CHANGED` recorded each change.
- [ ] Activation backfills stamps for active unenrolled users only;
      enrolled users untouched; users enrolling during grace clear theirs.
- [ ] Fresh sign-in under mandate stamps grace and surfaces
      `mfaGraceEndsAt` in the response; second sign-in doesn't shorten it.
- [ ] Past-deadline session: every non-exempt route → `403
      mfa_enrollment_required`, while `/mfa/*` and logout still work —
      enrollment-under-wall succeeds end-to-end (**mutation check**:
      remove the exemptions and confirm this test deadlocks/red).
- [ ] Within grace: everything works as before.
- [ ] Disable-MFA-under-mandate coherence: immediate wall on the wiped
      session's next request.
- [ ] `requireAuth` still issues exactly one query (nested selects, not a
      second round-trip).
- [ ] Mandate off restores pre-mandate behavior for previously stamped
      users without data cleanup.
- [ ] typecheck, lint, full integration suite pass.
