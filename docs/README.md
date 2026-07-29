# Documentation

## Living

Kept current. If one of these disagrees with the code, the document is wrong.

| Document | What it is |
| --- | --- |
| [roadmap.md](roadmap.md) | What is done, what is next, and what is deliberately not being done. **Start here** for current state. |
| [../README.md](../README.md) | What kauth is, how to run it, and how authentication works. |
| [../backend/README.md](../backend/README.md) | API surface, token transport, error codes, adding an OAuth provider. |

## Historical

Point-in-time records. Accurate as of their date and **not** updated since —
read them for reasoning, not for current state.

| Document | Date | What it is |
| --- | --- | --- |
| [audit-2026-07-27.md](audit-2026-07-27.md) | 2026-07-27 | Full audit of the backend against OWASP ASVS 5.0 (L2), RFC 9700, and NIST SP 800-63B-4. Assessed the project at ~15% of its stated goal. Most of what it found has since been fixed; its numbered findings are what the remediation logs refer to. |
| [remediation-2026-07-27.md](remediation-2026-07-27.md) | 2026-07-27 | Closed audit findings 1, 2, 4, 5, 6: the error contract, rate limiting, social login, the unused half of the schema, and tests + CI. |
| [remediation-2026-07-29.md](remediation-2026-07-29.md) | 2026-07-29 | Closed the access-token revocation gap and added cookie transport. |
| [auth-services-research-result.md](auth-services-research-result.md) | undated | Survey of how the field solves these problems in 2026 — better-auth, Lucia/Oslo/Arctic, Clerk, Ory, SuperTokens — plus the ASVS / RFC 9700 / NIST baseline. The reference standard the audit measured against. |

The remediation logs are worth reading even where they are superseded: they
record *why* each design choice was made, which the code cannot.

The audit refers to a five-phase hardening roadmap under `backend/docs/`. That
directory was removed on 2026-07-29 — it was written before any of it was built,
and much of it had since been implemented or contradicted. What was still
relevant lives in [roadmap.md](roadmap.md); the history is in git.

## A note on dates

Every document here is dated in its filename or its header. The roadmap carries
a "last reviewed" date instead. Nothing in this directory should be trusted as
current unless it says it is living.
