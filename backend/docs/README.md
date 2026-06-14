# Kauth Backend Hardening Roadmap

## Why This Exists

Kauth already proves that the core idea works: users can register, log in, refresh tokens, and log out. That is the easy part. Production auth systems fail in the edges around session lifecycle, abuse resistance, operational visibility, and data discipline.

This roadmap turns the current backend into a sequence of deliberate hardening phases. Each phase is written as guidance, not code. The goal is to help you implement the correct shape of the system instead of rushing into local fixes that will have to be undone later.

## Operating Principles

- Treat the auth server as security infrastructure, not as a convenience API.
- Stabilize the server contract before building the SDK.
- Prefer explicit session lifecycle over implicit token trust.
- Prefer revocation, observability, and auditability over cleverness.
- Ship abuse controls and runtime visibility with the feature, not after it.

## Roadmap At A Glance

| Phase | Theme                              | Main Outcome                                                               |
| ----- | ---------------------------------- | -------------------------------------------------------------------------- |
| 1     | Session and token correctness      | Tokens stop being the source of truth and sessions become first-class      |
| 2     | Identity, data, and migrations     | Persistence becomes stable, auditable, and safe to evolve                  |
| 3     | API security and client contract   | The service boundary becomes explicit, consistent, and difficult to misuse |
| 4     | Observability and operations       | The backend becomes diagnosable, operable, and deployable                  |
| 5     | Verification and release readiness | Security claims become provable instead of aspirational                    |

## Reading Order

1. [Phase 1: Session and Token Correctness](./01-session-and-token-correctness.md)
2. [Phase 2: Identity, Data, and Migrations](./02-identity-data-and-migrations.md)
3. [Phase 3: API Security and Client Contract](./03-api-security-and-client-contract.md)
4. [Phase 4: Observability and Operations](./04-observability-and-operations.md)
5. [Phase 5: Verification and Release Readiness](./05-verification-and-release-readiness.md)

## Suggested Execution Order

Do not parallelize every phase blindly. This backend has a dependency chain:

- Phase 1 comes first because a broken session model makes every other security control less meaningful.
- Phase 2 comes next because stable persistence and migration discipline are required before you can safely add richer session, recovery, and audit models.
- Phase 3 should begin once the auth contract is becoming stable, because the future SDK will depend on it.
- Phase 4 should progress alongside late Phase 3, but should not be treated as optional polish.
- Phase 5 is the release gate. It is where you prove the earlier phases are real.

## What "Done Enough To Start The SDK" Means

Do not start the SDK when the backend merely "works". Start it when these are true:

- Session rotation and revocation rules are stable.
- The response and error contract is versioned and consistent.
- The token transport strategy is final for the supported client types.
- Core auth events are observable.
- Integration tests protect the main flows from regression.

If you build the SDK before that point, you will hard-code backend mistakes into a public contract.
