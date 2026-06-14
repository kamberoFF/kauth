# Phase 1: Session And Token Correctness

## The Story

Right now the backend can mint tokens, but it does not yet behave like a system that truly owns session state. In a production auth service, tokens are not magical proof that explains everything by themselves. They are artifacts issued by a session authority.

This phase is where the backend stops acting like a token generator and starts acting like a real session service.

## Problems Encountered

- The refresh flow currently depends on access-token auth, which defeats the purpose of refresh.
- Refresh validation is too close to "token exists" and not close enough to "this session is still valid for this client under this policy."
- Device identity is currently a caller-supplied UUID. That is useful as a hint, but too weak to be trusted as a full session anchor.
- Access and refresh tokens are verified too similarly, which makes the contract easier to misuse.
- The token response contract is already inconsistent across endpoints, which will become painful once an SDK depends on it.

## What The Correct Solution Looks Like

At the end of this phase, the source of truth should be the session record, not the token itself.

- Access tokens should be short-lived and treated as presentation artifacts.
- Refresh credentials should be tied to a server-owned session lifecycle.
- Rotation should be one-time-use and have a clear reuse policy.
- Revocation should be explicit and queryable.
- The client contract should be stable enough that a future SDK can wrap it without guessing.

## Implementation Guidance

### 1. Decide What A Session Means

Write this down before implementing anything:

- What starts a session?
- What ends a session?
- What causes the server to revoke only one session versus every session for a user?
- What happens when refresh reuse is detected?
- What client metadata is trusted, what is only logged, and what is ignored?

If those answers are fuzzy, the implementation will be fuzzy too.

### 2. Separate Access And Refresh Responsibilities

Use different semantics for the two artifacts.

- Access token: short lifetime, audience-bound, issuer-bound, intended for authorization checks.
- Refresh credential: intended only for session continuation, never for normal API access.

Recommended direction:

- Keep access tokens as signed tokens if other services or clients need self-contained auth context.
- Move refresh away from self-contained JWT thinking and toward an opaque secret or server-tracked credential model.

Why this is the cleaner model:

- The server already checks persistence for refresh.
- Opaque refresh credentials are easier to rotate and easier to reason about.
- Storing only a hash of the refresh secret reduces blast radius if the database leaks.

### 3. Make Session State First-Class

Model a real session with fields that support lifecycle decisions.

At minimum, the backend should be able to answer:

- When was this session created?
- When was it last rotated?
- Is it active, revoked, expired, or compromised?
- Which refresh family does it belong to?
- Why was it revoked?
- What user and client context was it created under?

This is the point where the backend starts behaving like a security product instead of a CRUD app.

### 4. Implement Rotation As A Policy, Not A Helper Function

Refresh rotation needs an explicit policy document.

The implementation should define:

- Whether every refresh invalidates the previous refresh credential immediately.
- Whether reuse of an old refresh credential revokes only one session or the whole token family.
- Whether suspicious reuse escalates to all-session revocation for the user.
- Whether inactive sessions expire differently from absolute session lifetime.

The correct approach is usually one-time-use refresh with family tracking and reuse detection.

### 5. Be Honest About Device Identity

Do not treat the current `x-device-id` header as if it is a high-trust security signal.

Use it as one of several pieces of client context:

- Caller-supplied device id or install id
- User agent or client type
- IP or proxy-aware network source
- Session creation time and previous activity

If you want stronger device semantics later, design for progressive trust rather than pretending the current header is enough.

### 6. Standardize The Auth Contract Before The SDK Exists

Before writing more auth behavior, freeze the contract shape.

Decide and document:

- Response field names for every auth endpoint
- Error envelope shape
- Error code taxonomy
- Token transport strategy
- Session metadata that is safe to return to clients

Do not let different endpoints invent slightly different field names for the same concept.

## Correctness Questions To Answer Before Coding

- Will refresh be body-based, cookie-based, or support different modes for different clients?
- Do browser clients and SDK clients share one auth contract or separate contracts?
- Is session revocation per device, per client install, per session, or per user?
- Should access tokens be symmetric initially or move directly to asymmetric signing?
- What is the policy for signing key rotation and `kid` support?

## Anti-Patterns To Avoid

- Treating refresh tokens as long-lived access tokens.
- Keeping refresh logic stateless while also storing refresh state in the database.
- Encoding too much trust into caller-controlled device identifiers.
- Returning inconsistent token field names across endpoints.
- Making reuse detection a log line instead of a state transition.

## Done Looks Like

- The refresh endpoint is independent from access-token validity.
- Session lifecycle rules are documented and implemented consistently.
- Refresh credentials are one-time-use and tied to a clear server-side record.
- Revocation and compromise handling have explicit rules.
- The auth contract is stable enough to be wrapped by an SDK without guesswork.
