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

**Status:** done

- [x] `docs/roadmap.md`'s security-considerations / operations section states
      the console-transport-in-production risk is closed by the
      `MAILER_MODULE` requirement + production fail-fast
- [x] Any roadmap language implying the mailer is purely a deployer
      convention with no enforcement is corrected
- [x] No contract-version or ADR changes (this epic has neither)

## Comments

### Implemented 2026-08-28 (`/implement`)

Docs-only. `docs/roadmap.md`:

- Intro paragraph: the mailer posture moves out of the "Next up" list into a
  "now underway / shipped 2026-08-28" note pointing at the Operations section;
  the rest of the deferred-closeout batch stays as next-up (register-oracle
  not yet built).
- `### 1. Operations` gains a "Mail transport hardening — done 2026-08-28"
  paragraph: `consoleMailer` is dev/test only, `MAILER_MODULE` + `bootMailer`
  install an operator transport before migrations, production fails fast
  without one, wizard gates `REQUIRE_EMAIL_VERIFICATION`. Records "no ADR".
- `Last reviewed:` bumped to 2026-08-28.

No language in the roadmap actually claimed the mailer was an unenforced
deployer convention, so the second checkbox was satisfied by the framing
change above rather than a correction. Not folded with the register-oracle
docs-sync — that epic has not landed.
