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

**Status:** ready-for-agent

- [ ] `verifyEmail`'s `EMAIL_CONFIRMED` event carries `projectId` (available
      from the consumed `RecoveryToken`'s `record.project_id`)
      — `backend/controllers/account.ts` (`verifyEmail`)
- [ ] `resetPassword`'s `PASSWORD_RESET_COMPLETED` event carries `projectId`
      (same `record.project_id` source; `PASSWORD_RESET_REQUESTED` earlier in
      the same flow already does this correctly)
      — `backend/controllers/account.ts` (`resetPassword`)
- [ ] `changePassword`'s `PASSWORD_CHANGED` event carries `projectId`
      (`req.projectId` is already populated by `requireAuth` — just needs to
      be read via `requireProjectId(req)`) — `backend/controllers/account.ts`
      (`changePassword`)
- [ ] `changePassword`'s failed-current-password `LOGIN_FAILED` event
      likewise carries `projectId`, for the same reason
      — `backend/controllers/account.ts` (`changePassword`)
- [ ] `startOAuth`'s inline project-id validation (missing/format/existence
      checks, `backend/controllers/oauth.ts`) is replaced by a shared helper
      also used by `middlewares/project.ts`'s `requireProject`, so the two
      entry points can't drift — this also fixes the header path trimming the
      candidate id before validating while the query-param path does not
- [ ] `oauthCallback` re-validates the project id from `PROJECT_COOKIE`
      against `resolveProject` before use, rather than trusting the cookie's
      mere presence — matches `startOAuth`'s existing validation for the same
      input, and only relevant once project deletion ships (schema/FK already
      models it)
- [ ] Every affected existing integration test still passes; new tests cover
      `projectId` on each of the four events above and the trim-consistency
      fix

## Not in scope for this ticket

- `unlinkAccount`'s `FOR UPDATE` lock doing more round trips than strictly
  needed, and `routes/auth.ts` running `requireProject` (a DB round trip)
  before the in-memory rate limiters — both flagged by the same review pass
  as minor efficiency notes, not correctness bugs. Worth a look if this
  ticket's already touching these files, but not required to close it.
