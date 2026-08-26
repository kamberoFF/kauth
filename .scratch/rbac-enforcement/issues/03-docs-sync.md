# 03 — Docs sync: glossary, roadmap, README

Spec: `.scratch/rbac-enforcement/spec.md`

**What to build:** The living-docs truthfulness pass so the record matches
the shipped code — the repo's rule is "if it disagrees with the code, the
file is wrong."

**Status:** ready-for-agent

## Checklist

- [ ] `CONTEXT.md`: **Role** entry (per-Project enum; ADMIN means platform
      staff inside the reserved platform Project and gates the staff
      surface; the JWT claim rides along but never decides — point at
      ADR 0007) and **Platform staff** entry (operator of one kauth
      instance; bootstrapped by script, extended by staff endpoint).
      Respect existing _Avoid_ lists.
- [ ] `docs/roadmap.md`: "Features" bullet for RBAC moves from open to
      done with its date; "Next up" line updated to passkeys + asymmetric
      signing only; per-project tenant-admin gating recorded as deferred
      with its revisit trigger.
- [ ] `README.md`: the "Not built yet" row drops MFA and RBAC enforcement
      (both shipped); keeps what remains true.
- [ ] No contract/SDK/code changes in this ticket — docs only.

## Out of scope

Dated audit/remediation logs are history and stay untouched.
