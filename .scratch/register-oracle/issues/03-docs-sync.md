# 03 — Docs-sync: roadmap and status tables

Status: done

**What to build:** the living docs stop describing the registration oracle as
an open, deferred risk.

- `docs/roadmap.md` section 3 ("Close the identity oracles") records the
  registration email oracle as **closed** — register drops auto-login, the
  generic `202`, the `REGISTER_DUPLICATE_EMAIL` audit event, ADR 0008 — rather
  than "deferred as accepted residual risk".
- The roadmap intro's "Next up" list drops the registration-oracle item (and,
  if the deferred-closeout batch framing needs it, notes epic 1 complete and
  the contract at `0.6.0`).
- `Last reviewed:` date bumped.
- `backend/README.md` and the SDK READMEs: update any status table or prose
  that names the contract version or describes the register flow as returning
  a session.
- Standard epic close-out per the batch plan; may be folded into ticket 02's
  merge if they land together — implementer's call.

**Blocked by:** 02

- [x] `docs/roadmap.md` section 3 describes the registration oracle as closed, referencing ADR 0008
- [x] The roadmap intro no longer lists the registration oracle as pending work; contract version stated as `0.6.0` where the roadmap tracks it
- [x] `Last reviewed:` updated
- [x] `backend/README.md` / SDK READMEs carry no stale "register returns tokens" or pre-`0.6.0` contract-version text
