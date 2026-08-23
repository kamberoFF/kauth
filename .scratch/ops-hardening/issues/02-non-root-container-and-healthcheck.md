# 02 — Non-root container and healthcheck

**What to build:** The production container runs as an unprivileged user
instead of root, and exposes a container-level healthcheck an orchestrator
can act on without depending solely on external monitoring.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] The container runs as the base image's built-in non-root user, not
      root
- [ ] The container defines a healthcheck instruction against the
      existing liveness endpoint
- [ ] The container still builds and runs correctly end-to-end (installs
      dependencies, generates the Prisma client, starts the server) as the
      non-root user — no permission errors on any file the process needs to
      read or write
- [ ] The base image stays the current full image, not a leaner variant —
      evaluated and deliberately declined (see
      `.scratch/ops-hardening/spec.md`)
