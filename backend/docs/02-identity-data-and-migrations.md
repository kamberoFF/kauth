# Phase 2: Identity, Data, And Migrations

## The Story

An auth server ages through its data, not through its routes. When the schema is weak, every future feature becomes dangerous: password reset, email verification, admin controls, audit trails, account lockouts, and session management all become harder than they should be.

This phase is about making persistence disciplined enough that the backend can evolve without turning into a migration minefield.

## Problems Encountered

- Email and username uniqueness exist, but normalization and canonical lookup rules are not yet explicit.
- Registration pre-checks are thinner than the actual database constraints.
- The current refresh storage model is too small for real session lifecycle management.
- Recovery token modeling is still placeholder-level.
- Prisma source schema and generated client state have already drifted.
- Migration history is not checked in, which makes environment state harder to trust.

## What The Correct Solution Looks Like

At the end of this phase, the data model should feel boring in the best possible way.

- Identity fields have clear canonical forms.
- Credential state is separate from profile state when that separation improves clarity.
- Sessions, recovery flows, and audit trails have room to evolve.
- Migrations are deterministic, reviewable, and safe to promote across environments.

## Implementation Guidance

### 1. Normalize Identity Inputs Deliberately

Define canonical rules for identity fields.

- Lowercase email for lookup and uniqueness.
- Decide whether username is case-sensitive for display, lookup, or both.
- Reject or normalize unexpected whitespace and invisible characters.
- Decide how far you want to go on Unicode normalization now versus later.

The main goal is simple: the same human identity should not accidentally exist in multiple database spellings.

### 2. Split Data By Responsibility

Do not keep asking one table to explain everything.

Suggested separation of concerns:

- User identity and profile data
- Credential and password state
- Session records and refresh state
- Recovery and verification flows
- Security or audit events

Whether these land as separate tables immediately or in carefully staged steps is up to you. The important part is that each record type has one job.

### 3. Upgrade The Recovery Model Into A Real Lifecycle

Password reset and email verification should not be afterthoughts.

The recovery model should support:

- A relation to the user or subject it belongs to
- Purpose or token type
- Expiry time
- Consumption time
- Revocation or invalidation state
- Safe storage of token material, preferably hashed rather than plaintext

The design should make replay, race conditions, and token leakage harder by default.

### 4. Introduce Migration Discipline Early

Treat the Prisma schema as source code, not local state.

Correct practice:

- Check migrations into version control
- Regenerate the client as part of normal schema changes
- Make schema drift visible in CI
- Never rely on a developer's local database as the hidden source of truth

If the generated client can drift away from the checked-in schema, eventually the deployed service will too.

### 5. Design For Backfills And Future Security Fields

You already know more fields are coming. Leave room for them.

Examples of future-proof security fields:

- `password_changed_at`
- `email_verified_at`
- `locked_at`
- `failed_login_count`
- `last_login_at`
- `revoked_at`
- `expires_at`
- `compromised_at`

Do not add every field just because it exists. Add the ones that support explicit policies you are prepared to enforce.

### 6. Clean Up Seed And Environment Expectations

Seed data is a developer convenience, not part of the security model.

The correct approach is:

- Make demo credentials obviously non-production
- Keep production deployment paths independent from development seeds
- Avoid teaching future readers that hardcoded sample credentials are normal auth behavior

## Correctness Questions To Answer Before Coding

- Which fields are canonical versus display-only?
- Which auth state belongs on `users` and which belongs elsewhere?
- Do you want one session table or a session table plus refresh family history?
- How much security-event history should remain in the main database versus a separate log sink?
- What migration and rollback expectations will this project enforce?

## Anti-Patterns To Avoid

- Letting business rules live only in implicit database errors.
- Treating Prisma client output as if it automatically proves schema discipline.
- Keeping placeholder recovery tables that look secure but cannot support safe flows.
- Overloading `users` until it becomes impossible to reason about.
- Skipping migrations because local development still works.

## Done Looks Like

- Identity normalization rules are documented and enforced.
- The data model clearly separates users, credentials, sessions, and recovery concerns.
- Recovery and verification flows have a real lifecycle model.
- Prisma schema, generated client, and migration history are in sync.
- Database evolution becomes predictable instead of fragile.
