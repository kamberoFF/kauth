Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

What does the kauth SDK look like in practice — which language/framework
ships first, what's the API surface (signUp/signIn/session helpers, error
shapes), and how does it map onto the reconciled library-pivot direction from
ticket 01?

## Answer

**Headless first, TypeScript/JS core + React bindings.** Plain functions and
a session hook, not prebuilt UI — a themeable component library (fonts, dark
mode, i18n, accessibility) is a much bigger scope, layered on top later
without breaking anything built now. React matches `frontend/`'s existing
Vite+React scaffold, so it's the natural first framework binding rather than
a second, unrelated choice.

### A forced consequence of ticket 02, not a new design choice

The JWT signing key is one shared platform secret (ticket 02) — a downstream
app's backend cannot decode/verify an end-user's session token locally; it
doesn't have the secret, and sharing the platform-wide signing secret with
every project's backend would let any one project forge tokens for every
other project. So `verifySession()`-style calls on the backend SDK are real
network round-trips back to kauth, authenticated with the project's secret
key — not local, zero-latency JWT decodes. (Asymmetric signing with key
rotation, already on the hardening roadmap, is what would eventually enable
local verification — not this pass.)

### Two packages, not one — forced by ticket 04's key tiers

Ticket 04 settled two genuinely different keys for two genuinely different
runtimes: a publishable key that's safe in a browser bundle, and a secret key
that must never reach one. Shipping both from a single package invites the
exact foot-gun (a secret key accidentally bundled into client JS) that
Clerk/Stripe's own SDK splits exist to prevent. So:

- **Client package** (browser, publishable key): `signUp()`, `signIn()`,
  `signOut()`, a `useSession()` React hook — the tier-1 "start things for
  this project's end users" operations from ticket 04.
- **Backend package** (server, secret key): `verifySession()`, `listUsers()`,
  `revokeSession()` — the tier-2 elevated, that-project's-own-data
  operations from ticket 04.

### Error shape

Both packages pass through kauth's existing `{ error: { message, code } }`
contract directly rather than wrapping it in a generic `Error` — exposing
`code` lets a downstream app branch on it (`INVALID_CREDENTIALS`,
`EMAIL_NOT_VERIFIED`, etc.), matching the "assert on the error code, not the
message" convention this codebase already tests by.

### Relation to ticket 01

This *is* the "library" ticket 01 reframed `.scratch/library-pivot/spec.md`
around — a thin SDK consuming the hosted platform, not an embeddable auth
engine running in the consumer's own process.

### Explicitly deferred, not decided here

- **Prebuilt/themeable UI components** (drop-in `<SignIn/>`-style forms) —
  new fog item, deliberately deferred in favor of headless-first.
- **Framework bindings beyond React** (Vue, Next.js-specific middleware,
  Express middleware helpers for the backend package) — new fog item.
- **Package names / publishing details** — still open per ticket 01's
  original "license and package-publishing details... genuinely undecided"
  note; unaffected by this ticket.

No code or schema files were modified — this records the design.
