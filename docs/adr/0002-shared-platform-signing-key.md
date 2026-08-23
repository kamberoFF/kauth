# One shared platform JWT signing key, not per-project

Multi-tenancy (ADR 0001) raised whether each Project should get its own JWT
signing key. We kept the single shared platform secret kauth already used
pre-pivot; the `projectId` claim inside the token is what scopes it, not a
different key. A per-project key would let a project rotate or revoke its
own signing key independently and would reduce blast radius if one project's
key leaked, but adds key-management infrastructure (storage, rotation,
lookup-by-project at verify time) the platform doesn't need yet with no
external developers holding keys.

Revisit once tickets 04+ introduce per-project API keys and outside
developers verify tokens themselves (`docs/roadmap.md`'s asymmetric-signing
item, "if other services ever need to verify tokens without sharing the
secret") — that's the point at which a shared symmetric secret stops being
tenable.

**Update, 2026-08-23:** ticket 04 shipped per-project API keys, satisfying
the first half of this trigger. The second half has not happened: the
backend SDK (ticket 05) deliberately verifies sessions by calling kauth's
own API rather than decoding the JWT locally, so outside developers still
aren't verifying tokens themselves. Confirmed with the project owner that
the trigger is a genuine AND, not satisfied by API-key issuance alone — this
ADR's decision stands. Revisit only if a future ticket has a service verify
a kauth-issued token without going through kauth's API (e.g. local/offline
verification), not on any ticket that merely issues or authenticates with
API keys.
