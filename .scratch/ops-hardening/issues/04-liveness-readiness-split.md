# 04 — Liveness/readiness split

**What to build:** A deployment automation tool can distinguish "the
process is alive" from "the process can actually serve requests" and act on
each correctly — the existing liveness check stays exactly as it is, and a
new readiness check reflects real database connectivity.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] The existing liveness endpoint's behavior and shape are completely
      unchanged
- [ ] A new readiness endpoint exists, separate from the liveness endpoint
- [ ] The readiness endpoint performs a real, cheap database connectivity
      check (not a static response)
- [ ] The readiness endpoint returns success when the database is reachable
      and a failure status when it isn't
- [ ] The readiness endpoint's failure response uses this platform's
      existing `{ error: { message, code } }` shape, for consistency with
      the rest of the API
