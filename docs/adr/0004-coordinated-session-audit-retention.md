# Sessions are eventually deleted, coordinated with audit-log retention

`CLAUDE.md` states sessions are revoked, never deleted, because the audit
log references those rows. That's still true for *revocation* — a revoked
session's row stays queryable indefinitely as part of normal operation. But
the ops-hardening cleanup job (`docs/roadmap.md` "1. Operations") needs
revoked/expired sessions to eventually be purged, or they accumulate
forever. `SecurityEvent.session` uses `onDelete: SetNull`
(`schema.prisma:379`), so a naive delete of an old session wouldn't error —
it would silently null out `session_id` on every audit event that
referenced it, severing exactly the audit trail the "never deleted"
invariant protects.

We resolved this with a single retention window and a strict two-step
ordering, not by leaving sessions untouched or by archiving them:

1. Delete `SecurityEvent` rows older than `AUDIT_RETENTION_DAYS` (new env
   var, default 365).
2. Only then delete `Session` rows that are both revoked/expired **and**
   older than that same cutoff.

By the time step 2 runs, nothing still references those sessions — step 1
already removed every audit event that could. The ordering itself is the
guarantee; no "does anything still reference me" check is needed. This
keeps `AUDIT_RETENTION_DAYS` deliberately separate from refresh-token
cleanup's own `CLEANUP_RETENTION_DAYS` (default 30) — audit/session history
plausibly needs much longer retention (compliance, security investigation)
than "clear out stale refresh tokens," and conflating the two knobs would
force operators into a bad trade-off between them.

## Consequences

- A session can outlive its own revocation by up to a year (the default
  `AUDIT_RETENTION_DAYS`) before it's actually purged. That's intentional —
  the audit trail's completeness is worth more than reclaiming that storage
  sooner.
- Revisit if operators want session identity/history preserved
  independently of full audit-event retention — e.g. "keep a record that
  someone logged in from X" without needing the complete audit trail that
  long. That would call for an archival approach instead (move old sessions
  to a cold table/export rather than `DELETE`, preserving referenceability
  indefinitely) rather than coordinated deletion. Not needed yet — nothing
  has asked for it, and it's a real added mechanism (a new table/export
  path) this decision deliberately avoided building speculatively.
