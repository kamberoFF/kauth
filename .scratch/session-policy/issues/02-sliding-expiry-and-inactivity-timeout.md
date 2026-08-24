# 02 — Sliding expiry and inactivity timeout

Spec: `.scratch/session-policy/spec.md`

**What to build:** Session lifetime becomes activity-based instead of
anchored purely at creation, and an idle session stops counting as live.

**Blocked by:** None
**Status:** done

## Behavior

- **Sliding expiry:** a successful refresh sets
  `session.expires_at = now + SESSION_TTL_MS` (30d rolling window). The
  replacement refresh token already dies with the session, so no change is
  needed there beyond inheriting the new value.
- **Inactivity timeout:** if `now - last_used_at` exceeds
  `SESSION_INACTIVITY_DAYS` (new config knob, default 14), the session is
  treated as expired:
  - `requireAuth` selects `last_used_at` in its existing primary-key read
    and rejects with the existing `session_expired` code — no extra query,
    no write on the hot path.
  - `refresh` marks the session `EXPIRED` inside its existing transaction
    and returns `session_expired`.
- `last_used_at` continues to be written only by refresh (and creation); it
  is read for policy now, which is the roadmap item's actual point.
- Cleanup job needs no change: an inactive session stops sliding, so
  `expires_at` freezes and ADR 0004 retention reclaims it.

## Acceptance criteria

- [x] Refresh slides `expires_at` to now + TTL; access tokens minted before
      the slide keep working up to the new bound.
- [x] A session whose `last_used_at` is older than the inactivity window is
      rejected by `requireAuth` with `session_expired`, even though
      `expires_at` is still in the future.
- [x] The same stale session is marked `EXPIRED` and rejected at refresh.
- [x] A recently used session within the window passes both checks.
- [x] typecheck, lint, and the full integration suite pass.
