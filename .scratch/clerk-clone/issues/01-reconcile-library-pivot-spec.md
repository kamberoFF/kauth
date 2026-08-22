Type: task
Status: resolved

## Question

`.scratch/library-pivot/spec.md` is marked "exploratory — not yet committed"
and describes a service → embeddable-library pivot as if it were kauth's
whole future shape (deleting `backend/` outright, consumer supplies their own
process/DB). That's no longer accurate: the destination is now a hosted
multi-tenant platform, and the "library" is its SDK/client layer, not a
replacement for the hosted service.

Reconcile the spec with the new direction. Decide: edit `spec.md` in place to
reflect the SDK framing, or let it stand as superseded history and write a
fresh spec/ADR under the new domain docs? Either way, the outcome should make
clear that the hosted service is not going away.

## Answer

Edited `.scratch/library-pivot/spec.md` in place rather than replacing it or
writing a fresh doc — no `CONTEXT.md`/ADR trail exists yet to hang a fresh
spec on, and the original discussion is worth keeping as history rather than
discarding.

Marked the file `Status: superseded`, added a `## What changed` section up
top stating plainly that the hosted service stays and the "library" is now
the SDK/client layer (not an embed-in-your-process auth engine), and added
inline superseded/still-true annotations through the original sections rather
than rewriting them silently — so a future reader sees what changed and why,
not just a corrected document with no trail.

Two claims flipped by the platform direction: the repo-split/embed model
(`packages/core` + adapters + deleting `backend/`) no longer applies —
`backend/` becomes the platform, not a demo scaffold to discard; and
self-service (session revoke, linked-provider unlink) becomes hosted API
surface the SDK wraps, not in-process library functions. Sequencing
(hardening order first) and the greenfield/no-backward-compat stance both
still hold unchanged. The SDK's actual shape stays undecided here — pointed
at ticket 05 instead of guessed at.
