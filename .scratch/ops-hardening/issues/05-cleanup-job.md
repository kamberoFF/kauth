# 05 — Cleanup job for stale sessions, refresh tokens, and audit events

**What to build:** A discrete, operator-triggered maintenance step that
purges data with no ongoing value — consumed/expired refresh tokens, and
eventually revoked/expired sessions — without ever severing the audit
trail's reference to a session that's still within its own retention
window. Full design rationale: `docs/adr/0004-coordinated-session-audit-retention.md`.
This ticket is one coupled unit — the ordering below is a correctness
guarantee, not an implementation detail, and must not be split across
multiple tickets/PRs in a way that separates it from what it protects.

**Blocked by:** 01 (structured logging foundation) — the job's own run
should log through the new logger from the start

**Status:** done

- [x] Two independently configurable retention windows exist, following
      this repo's existing env-var/config conventions: one governing
      consumed/expired refresh tokens, one governing audit events (and, by
      extension, when a session becomes eligible for deletion) — each with
      its own sensible default, settable independently so an operator isn't
      forced to trade one off against the other
- [x] Cleanup runs as a discrete, externally-triggerable step (e.g. a
      standalone script), not an always-running in-process timer inside the
      main server process
- [x] Running cleanup deletes consumed/expired refresh tokens older than
      their retention window
- [x] Running cleanup deletes audit-log events older than their retention
      window
- [x] Running cleanup deletes revoked/expired sessions, but **only** once
      they are older than the audit-log retention window — never before
- [x] **The mutation-critical guarantee**: a session that is already past
      its own expiry/revocation, but still has an audit-log event
      referencing it that is inside the audit retention window, is **not**
      deleted by a cleanup run. Once that referencing event itself ages out
      of retention, a subsequent cleanup run **does** delete the session.
      This must be exercised by a real test, and that test must be
      mutation-checked (break the ordering deliberately, confirm the test
      catches it, then restore) per this repo's convention for
      security/integrity-relevant guarantees
- [x] Cleanup never leaves an audit-log event pointing at a session that no
      longer exists as a side effect of running out of order
- [x] Running cleanup with nothing eligible is a safe no-op
