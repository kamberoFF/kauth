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
