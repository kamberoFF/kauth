# 03 — Migrate-on-startup and graceful shutdown

**What to build:** The server applies pending database migrations as part
of its own startup instead of relying on a manual pre-deploy step, refuses
to serve traffic against a schema it failed to migrate, and shuts down
cleanly on termination — draining in-flight requests and closing the
database connection instead of dropping them.

**Blocked by:** 01 (structured logging foundation) — startup/shutdown
messages should log through the new logger from the start, not be written
once against `console.*` and reworked later

**Status:** ready-for-agent

- [ ] On startup, pending migrations are applied automatically before the
      server begins accepting requests
- [ ] A failed migration logs the failure and exits the process immediately
      — the server never begins serving traffic against a schema it failed
      to migrate
- [ ] Starting the server against an already-up-to-date schema is a no-op
      that boots normally
- [ ] On receiving a termination signal, the server stops accepting new
      connections, allows in-flight requests to complete, then closes the
      database connection before exiting
- [ ] If shutdown doesn't complete within a bounded timeout (a stuck
      connection, etc.), the process force-exits anyway rather than hanging
      indefinitely — the database connection is still given a chance to
      close first
- [ ] Both the migration and shutdown sequences log through the new
      structured logger from ticket 01, not raw `console.*`
