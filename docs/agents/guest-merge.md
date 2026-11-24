# Guest merges — reference

The rules are summarized in `backend/lunora/lib/AGENTS.md`; this file holds the detail. Paths are repo-relative to
`backend/lunora/`.

## Recovery and the housekeeping sweep

`lib/account-merge.ts` keeps each merge's latest progress in `idempotencyClaims` (scope `guest-merge-progress`, on the
new account's shard, tagged with it so its erasure drops it). `resumeStalledGuestMerges` (`shardSweeps()`) queues a
merge again when its lease is free and its progress older than `MERGE_STALL_MS`; it drops a finished, erased or
over-cap one.

Restarts rely on the lease generation, never on the queue: keep every step safe to run twice, and save progress
through `releaseMergeLease`, never from the job payload. The record only moves forward (a later `run` writes it; a
delivery behind it starts from it), the sweep moves its time before it sends the job, and each save arms the shard's
timed work (`noteShardDue`) for its stall: the minute tick runs the sweep there (`resumeStalledGuestMergesOnTick`),
since housekeeping reads only the most active shards.

An erasure takes every claim tagged with the account, its erasing marker too, so the lease, each run's start and the
sweep read the new account's `user` row (`auth/lib/merge-destination.ts`, primary): once it is gone the merge stops,
writes nothing there and keeps the guest. Lease and generation never lapse while a merge is unfinished; a finished one
leaves only its fence. A missing guest `user` row (the anonymous plugin deletes it at sign-up) never ends a merge:
only its progress (`markers`) says the `guest` step ran. A sweep pass spends ≤ `MERGE_SWEEP_STATEMENTS` of D1.

Import markers (`guest-merge-row`), progress records and the pins-left signal (`guest-merge-pins-left`) never lapse,
and a lapsed one still counts: each goes only when the merge has done what it records (its end, the run cap, the
`global` step that re-points the moved pins' routes) or with the erasure of the account it is tagged with. A time to
live there would lose a stalled merge, write again a row the account deleted, or let another merge's `repins` step
skip a pin.

A merge that ends before its `global` step (an erasure, a gone account, the run cap) marks its pins-left signal
`abandoned`: a `repins` step that meets it stops its own merge and keeps that guest, never waits to its cap. That step
re-reads its route's owner (primary) after the signal check and follows a route re-pointed meanwhile.

The import copies re-point only `USER_REFERENCE_FIELDS`; content equal to the guest's id stays.

A guest row the clear read but the guest deleted before `deleteShardRows` ran is reported back as `gone`, never taken as
deleted by the merge: the clear's import may just have written it on the new shard. `dropRowsGoneFromGuest` removes that
copy there only while it still matches its import marker (the account never changed it), and keeps the marker, so no
later import writes it again. An absent source row is never a confirmation of the copy that was read from it.

`auth/hooks.ts#deleteMergedGuest` reads the guest's `user` row from the primary: a replica that has not seen it yet
would pass for the anonymous plugin's deletion and the guest would stay.

The root dispatch clears a shard's due time only while it still holds the value it read, and puts it back (never
throwing) when the tick's send fails; a merge's save (`noteShardDue`'s `rearmPassed` only) moves a passed one so it is
not cleared; the tick replaces only the one it read (`consumed`).

Everything after the lease is taken runs inside the `try` that gives it back.

A fenced merge with import or account-move markers left drains its `markers` phase. Every step that writes checks the
lease generation first (owner-shard pin moves: both accounts' erasure markers).

The new account's `importing` marker is shared by every merge into it: each merge holds it through its own
`guest-merge-importing` claim, and only the last live holder ends it; a merge's own cleanup is read from its own
claims, never the marker.

The merge reads the guest's shard whole only on its own shard (`onGuestShard`); on dev's shared `SHARD_ROUTING=off` it
stops at once (`sharedShard`), never fenced done. Every stop (cap, sweep drop, erasure, gone account, shared store)
ends its markers, keeps the guest.
