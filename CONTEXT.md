# kauth

Self-hosted auth backend for first-party apps, growing into a self-hosted,
multi-tenant auth platform: one kauth instance serving many independent
apps, each with its own isolated pool of end users.

## Language

**Project**:
A tenant. One customer's app, with its own isolated pool of Users, Sessions,
and linked-provider Accounts. Every user-owned table carries a `project_id`;
tables live in shared storage, not a separate schema or database per tenant.
_Avoid_: Tenant, org, workspace, app (when a specific tenant is meant, say
Project).

**Account**:
A linked external identity (e.g. a Google or GitHub OAuth account) attached
to a User. Distinct from the User itself, and from a "user account" in the
colloquial sense — that's just a User.
_Avoid_: OAuth account, provider account, connection.

**Contract version**:
The value of the `X-Kauth-Contract-Version` response header, one per kauth
release, bumped on any change to a response or error shape (including
purely additive ones). An SDK hard-fails on any mismatch between its own
built-against version and the server's — see ADR 0003. Deliberately not
"API version" in the Stripe sense: kauth never serves two contract versions
from one running instance at once, so there is no per-caller version
selection, only a single current one.
_Avoid_: API version (implies multi-version hosting, which this isn't).
