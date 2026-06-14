# Phase 3: API Security And Client Contract

## The Story

By this point the backend should know what a session is and how to store it. The next problem is the service boundary itself. A production auth service does not just need correct internals; it needs a contract that clients can use safely and security controls that are hard to accidentally bypass.

This phase is where the API stops feeling like a local Express app and starts feeling like a platform surface.

## Problems Encountered

- The current service boundary is minimal and inconsistent.
- Error envelopes are not standardized.
- Auth responses already differ in naming for closely related concepts.
- There is no visible rate-limiting, CORS strategy, or request hardening layer.
- Role exists in data, but there is not yet a meaningful authorization model built on top of it.

## What The Correct Solution Looks Like

At the end of this phase, the service boundary should be explicit.

- Clients know exactly what to send and what to expect back.
- Failures are structured and machine-readable.
- Endpoint-level security controls are intentional.
- Authorization policy is defined instead of implied.
- The future SDK can be a clean wrapper, not a repair layer.

## Implementation Guidance

### 1. Freeze The Public Contract

Write the contract before you keep adding features.

Document for each endpoint:

- Method and path
- Required headers
- Request body schema
- Success response schema
- Error response schema
- Error codes and their meaning
- Authentication and authorization requirements

If this is not documented, the real contract becomes whatever the frontend happened to tolerate last.

### 2. Choose A Token Transport Strategy On Purpose

Do not drift into a mixed model by accident.

There are two common paths:

- Browser-first: refresh in secure, HttpOnly cookies with CSRF strategy; access token short-lived and often header-based
- SDK or native-first: access token in authorization header; refresh handled through explicit client storage guidance and explicit transport rules

Pick the primary strategy based on the clients you truly plan to support first. If you later support multiple modes, document them as separate modes, not one blurry contract.

### 3. Standardize Errors For Humans And Machines

Clients need more than status codes.

The error model should include:

- Stable error code
- Human-readable message
- Optional field-level validation details
- Correlation or request id when useful
- Clear distinction between auth failure, validation failure, rate limit, and internal failure

The SDK should never have to parse ad hoc error text to decide what happened.

### 4. Build Abuse Controls Into The Boundary

Auth endpoints are attack surfaces.

Minimum controls to plan for:

- Rate limits per IP and per account identifier where appropriate
- Stronger limits for login, register, refresh, reset, and verification endpoints
- Request body size limits
- CORS policy with explicit origins
- Proxy-aware source IP handling when deployed behind infrastructure
- Security headers and safe defaults for content handling

These controls belong in the service design, not in a future cleanup ticket.

### 5. Define Authorization Before You Need Admin Features

The presence of a role column is not an authorization strategy.

Decide now:

- Which permissions exist
- Which are role-derived versus explicit
- Which endpoints require them
- Whether internal/admin operations live in the same API surface or a separate one

Keep the policy model understandable. Over-designed authorization becomes as risky as under-designed authorization.

### 6. Version The Contract Before It Sprawls

If the service will power an SDK and eventually more clients, versioning should be planned before the surface area grows.

That does not mean over-engineering immediately. It means deciding:

- Whether the API path will be versioned
- How backwards-incompatible changes are introduced
- Which fields are considered stable versus experimental

## Correctness Questions To Answer Before Coding

- Which client types are first-class on day one?
- Are browser and SDK clients sharing one auth transport model?
- What error codes will the SDK treat as stable?
- What is the minimum admin or internal authorization surface this backend must support?
- Where will API versioning become visible?

## Anti-Patterns To Avoid

- Returning different names for the same concept across auth endpoints.
- Mixing browser-style and SDK-style refresh handling without a formal contract.
- Relying on plain-language error text as the machine contract.
- Treating roles as authorization without defining permission boundaries.
- Adding rate-limiting only after public exposure.

## Done Looks Like

- The auth API contract is documented and stable.
- Clients receive consistent success and error envelopes.
- Token transport rules are explicit for the supported client modes.
- Rate limits and request-boundary hardening are part of the design.
- Authorization semantics exist beyond a stored role field.
