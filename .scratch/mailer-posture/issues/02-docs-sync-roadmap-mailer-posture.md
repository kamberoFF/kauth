# 02 — Docs-sync: roadmap mailer-posture note

**What to build:** `docs/roadmap.md` reflects that the
console-transport-in-production risk is closed.

The roadmap's security-considerations / operations narrative currently frames
the missing mail transport as an expectation on the deployer with no
enforcement. Update it to record that a production instance now refuses to
start without `MAILER_MODULE` configured, and that the console transport is
development/test only.

This is the epic's standard close-out docs-sync ticket (the rbac-enforcement
pattern — each deferred-closeout epic ends with one). If the register-oracle
epic lands close behind this one, its docs-sync may be folded together with
this — implementer's call at merge time.

**Blocked by:** 01 — `MAILER_MODULE` hook + production fail-fast.

**Status:** ready-for-agent

- [ ] `docs/roadmap.md`'s security-considerations / operations section states
      the console-transport-in-production risk is closed by the
      `MAILER_MODULE` requirement + production fail-fast
- [ ] Any roadmap language implying the mailer is purely a deployer
      convention with no enforcement is corrected
- [ ] No contract-version or ADR changes (this epic has neither)
