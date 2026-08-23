# Exact-match contract version header, not multi-version API hosting

kauth is self-hosted per operator — one instance per deployer, never a single
shared deployment serving many independent callers on their own upgrade
schedules the way a SaaS API does. So a running kauth instance never needs to
serve two different contract shapes to two different callers at once; the
problem to solve is narrower: catch a mismatch during an operator's own
upgrade window, when kauth has moved to a new response/error shape but a
downstream app's SDK hasn't been redeployed yet.

We treat **any** change to a response or error shape as breaking, including a
purely additive one (a new optional field), rather than trying to classify
changes as safe/unsafe case by case. The server advertises its current
contract version — kauth's own package release version, no separate parallel
numbering scheme — via an `X-Kauth-Contract-Version` header on every
response. The SDKs (tickets 05/06) compare this against the version they were
built for on every request and hard-fail on any exact mismatch. This is
deliberate: every kauth upgrade becomes a coordinated-redeploy event by
design, trading operational friction for a mechanism with zero judgment calls
and no need to host multiple contract versions at once.

## Consequences

- Detection happens via the *response* header, so on a mutating call
  (`signUp`, `login`, `revokeSession`, etc.) a mismatch is only caught after
  the request already completed server-side. Accepted as the cost of
  exact-match rather than added round trips before every mutating call. The
  SDK's error message must say the operation may have completed and must
  never imply it didn't; it must not auto-retry a mutating call on this
  error.
- Every kauth release that touches any response or error shape requires
  every downstream app's SDK to be redeployed before that app can call kauth
  again. Chosen deliberately over Stripe-style perpetual multi-version
  hosting, which solves a problem (many callers frozen on many versions
  forever) kauth's single-operator-per-instance model doesn't have.
- Revisit if kauth ever needs one running instance to simultaneously serve
  multiple active contract versions — e.g. a future hosted/managed
  kauth-as-a-service model where the operator and the downstream developer
  are different parties on independent upgrade schedules. That would need
  real multi-version hosting (parallel-served handlers per version), not
  this mechanism.
