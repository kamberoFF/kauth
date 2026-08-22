# 07 — Audit-log project scoping and OAuth validation hygiene

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** Surfaced by `/code-review` while implementing ticket 03,
against code already merged on `main` from tickets 01–02 — not part of
ticket 03's own diff, filed here rather than bundled into it. Four
`SecurityEvent` writes in `backend/controllers/account.ts` are missing
`projectId` even though it's available at the call site, undermining
per-project audit queries. `backend/controllers/oauth.ts` re-implements
`middlewares/project.ts`'s project-id validation inline instead of sharing
it, with a resulting behavioral inconsistency (trimming) between the two
paths.

**Blocked by:** None

**Status:** done

- [x] `verifyEmail`'s `EMAIL_CONFIRMED` event carries `projectId` (available
      from the consumed `RecoveryToken`'s `record.project_id`)
      — `backend/controllers/account.ts` (`verifyEmail`)
- [x] `resetPassword`'s `PASSWORD_RESET_COMPLETED` event carries `projectId`
      (same `record.project_id` source; `PASSWORD_RESET_REQUESTED` earlier in
      the same flow already does this correctly)
      — `backend/controllers/account.ts` (`resetPassword`)
- [x] `changePassword`'s `PASSWORD_CHANGED` event carries `projectId`
      (`req.projectId` is already populated by `requireAuth` — just needs to
      be read via `requireProjectId(req)`) — `backend/controllers/account.ts`
      (`changePassword`)
- [x] `changePassword`'s failed-current-password `LOGIN_FAILED` event
      likewise carries `projectId`, for the same reason
      — `backend/controllers/account.ts` (`changePassword`)
- [x] `startOAuth`'s inline project-id validation (missing/format/existence
      checks, `backend/controllers/oauth.ts`) is replaced by a shared helper
      also used by `middlewares/project.ts`'s `requireProject`, so the two
      entry points can't drift — this also fixes the header path trimming the
      candidate id before validating while the query-param path does not
- [x] `oauthCallback` re-validates the project id from `PROJECT_COOKIE`
      against `resolveProject` before use, rather than trusting the cookie's
      mere presence — matches `startOAuth`'s existing validation for the same
      input, and only relevant once project deletion ships (schema/FK already
      models it)
- [x] Every affected existing integration test still passes; new tests cover
      `projectId` on each of the four events above and the trim-consistency
      fix

## Comments

- 2026-08-22: Shared validation lives in `lib/projects.ts`'s new
  `resolveProjectIdOrThrow`, used by both `middlewares/project.ts` and
  `controllers/oauth.ts` (`startOAuth` and the `oauthCallback` re-validation).
  Discovered along the way: re-validating the callback's project cookie means
  a stale/deleted project id can no longer even be *attributed* to an audit
  event (`security_events.project_id` is a real FK) — `fail()` now passes
  `null` instead of attempting an insert doomed to fail. The
  cookie-re-validation guard was mutation-checked: reverted to trusting the
  raw cookie, confirmed the new test then falls through to a generic
  `oauth_failed` (the exact pre-fix behavior) instead of `project_not_found`,
  restored.
- 2026-08-22 (first `/code-review` pass, 3 findings, all fixed): the initial
  `reason === "project_not_found"` string-match for nulling audit attribution
  was too narrow (missed `project_id_invalid`, and any failure whose project
  cookie went stale before re-validation ran) and spoofable (`req.query.error`
  is provider-controlled and reaches `fail()` before validation). Replaced
  with `attributedProjectId`, which starts as the raw cookie value and is
  only ever nulled by an actual `resolveProjectIdOrThrow` failure — immune to
  reason-string spoofing by construction. Also fixed a stale doc comment on
  `resolveProject` and un-exported it (nothing outside `lib/projects.ts` uses
  it directly anymore). New regression tests for both the malformed-cookie
  and spoofed-reason cases; the malformed-cookie one was mutation-checked
  (reverted the null-out, confirmed the audit row silently fails to insert
  instead, restored).
- 2026-08-22 (second `/code-review` pass — hit a session rate limit partway
  through; one angle completed, findings addressed anyway): restored
  per-entry-point message specificity lost when the three validation call
  sites were unified (`resolveProjectIdOrThrow` now takes an optional
  `source` string purely for message text, never the error code), and
  unified `oauthCallback`'s redundant `project_missing` code (untested, no
  external consumer) into the same `project_id_missing` the other two entry
  points already produce. Also dropped a redundant intermediate variable
  the same pass flagged.
- Full suite: 143 pass / 0 fail. typecheck and lint clean.

## Not in scope for this ticket

- `unlinkAccount`'s `FOR UPDATE` lock doing more round trips than strictly
  needed, and `routes/auth.ts` running `requireProject` (a DB round trip)
  before the in-memory rate limiters — both flagged by the same review pass
  as minor efficiency notes, not correctness bugs. Worth a look if this
  ticket's already touching these files, but not required to close it.
