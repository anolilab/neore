# EXTENSION SIGN-OUT — SEQUENCE AND REASONING

The reference behind the sign-out rules in `apps/browser-extension/AGENTS.md`. Code: `endSession`
(`apps/browser-extension/src/lib/session.ts`) and `signOutGrant`, `removeSignedOutGrant`, `finishPendingSignOut`
(`apps/browser-extension/src/lib/extension-grant.ts`).

## Sequence

1. `endSession` holds new tokens and stops the refresh loop. The hold is a count (`releaseAccessTokens`), so one
   sign-out ending early never lifts another's hold.
2. The sign-out takes its own lock, `neore.signOut:<key>`, and keeps it from before the mark to the end of the removal.
3. Under the grant lock it checks and writes the mark, `neore.signedOutGrant`. Checking under the lock means an older
   sign-out never overwrites a newer grant's mark. The bearer, and the offline queue that clearing it drops, stays
   until this mark is written.
4. If storage fails to read the grant or to write the mark, nothing changed: the session comes back (tokens resume, the
   loop restarts) and Settings shows the failure.
5. Once marked, `readGrant` hides the grant, so the panel signs out at once.
6. The revoke runs, bounded by `REVOKE_TIMEOUT_MS`. Out of time counts as a failed revoke. Only the response status
   counts; its body is cancelled without awaiting, so a stalled cancel cannot hold the sign-out past the deadline.
7. The grant and its marks are forgotten whether or not the revoke succeeded.

## When the removal fails

- A marked grant stays hidden, so a failed removal never signs back in, in this panel or a later one. Settings is gone
  by then, so the sign-in page shows the failure (`useSignOutUnfinished`).
- The next panel to load removes the leftover (`finishPendingSignOut`), once per panel: every `useSession` shares one
  storage watch. One whose storage read fails runs again on the first good read after its own capped backoff, never
  sooner.
- That cleanup waits on the sign-out lock and reads again, so a sign-out still running in another panel is never
  revoked or removed twice. A panel closed mid-way releases the lock, and the waiting cleanup finishes the job.

## The warning

- It is read from storage: it shows in every panel only while the failure mark (`neore.signOutFailed`) names the stored
  marked grant and no removal runs in that panel. It never shows for a sign-out still running elsewhere, and it clears
  on a removal or a new sign-in.
- The failure mark is written only when storage keeps the grant, never for a failed revoke alone: an offline revoke is
  not a failure the user can act on, since the session expires on its own.
- The panel whose own removal failed also keeps that grant's key in memory (`failedHere`) and warns while it stays
  stored, since storage that keeps the grant often refuses the failure mark too.
- A sign-in drops the mark; one it fails to drop names an older key and hides nothing.

## Storage reads after a change

A storage read that fails after a change keeps the session shown, and the watch reads again with capped backoff until
one succeeds (a mark written during the outage fires no new change). Only the first read counts a failure as signed out.

## Which grant

A sign-out acts on the grant Settings shows (`grantKey`), leaving a newer one unrevoked, and one sign-out runs per grant.
A session started meanwhile (`suspend`'s generation check) is left alone.
