# 01 — Structured logging foundation

**What to build:** Every request produces a correlated, structured log line
(request id, user id when known, session id when known, route, outcome
code) instead of unstructured `console.*` calls scattered across the
codebase — a foundation the migrate-on-startup/shutdown ticket (03) and the
cleanup job (05) will log through too, so their output doesn't need to be
written twice.

**Blocked by:** None — can start immediately

**Status:** done

- [ ] A new logger utility produces one JSON object per line on stdout, with
      a `level` field and a message, no logging library dependency
- [ ] A request-scoped middleware mints a request id (always server-
      generated — never trusted from an inbound header) and makes it
      available to the logger for that request's lifetime, including error
      paths
- [ ] Log lines include user id and session id when the request is
      authenticated, and are correctly absent when it isn't
- [ ] Log lines include the route and an outcome code (e.g. status code or
      equivalent)
- [ ] A configurable log level exists, following this repo's existing
      env-var/config pattern (a zod-validated field with a sensible default)
- [ ] Every existing production `console.log`/`console.error` call site
      (startup messages, the 5xx error handler, the audit-log
      own-write-failure fallback, OAuth callback failures, mail-send
      stub/failure logging) is migrated to the new logger
- [ ] `SecurityEvent`/the existing audit-log write path is completely
      untouched — application logs and the audit log remain two separate
      mechanisms, and no log line ever contains a token, hash, or credential
      value
