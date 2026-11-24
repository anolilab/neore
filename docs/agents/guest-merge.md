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
leaves only its fence: `releaseMergeLease` drops its lease, and the sweep drops a lapsed one with the record when a
run wrote the fence and died before its release. A missing guest `user` row (the anonymous plugin deletes it at
sign-up) never ends a merge: only its progress (`markers`) says the `guest` step ran. A sweep pass spends ≤ `MERGE_SWEEP_STATEMENTS` of D1.

Import markers (`guest-merge-row`), progress records and the pins-left signal (`guest-merge-pins-left`) never lapse,
and a lapsed one still counts: each goes only when the merge has done what it records (its end, the run cap, the
`global` step that re-points the moved pins' routes) or with the erasure of the account it is tagged with. A time to
live there would lose a stalled merge, write again a row the account deleted, or let another merge's `repins` step
skip a pin.

A merge that ends before its `global` step (an erasure, a gone account, the run cap) marks its pins-left signal
`abandoned`: a `repins` step that meets it stops its own merge and keeps that guest, never waits to its cap. That step
re-reads its route's owner (primary) after the signal check and follows a route re-pointed meanwhile.

The import copies re-point only `USER_REFERENCE_FIELDS`; content equal to the guest's id stays.

`DERIVED_FIELDS` are kept by each shard itself: `threads`' `SEARCH_INTERNAL_FIELDS` (the messages triggers' `userTurnCount`,
the palette sync's vector ids, claim and refusal). They stay out of every digest, so a trigger's or a sync's write is never
taken for an edit (the guest's clear counts `userTurnCount` down as it deletes messages; an imported late message counts
the copy up). A replaced row keeps the new shard's values; an inserted thread gets the user turns the new shard already
holds for it (`countUserTurns`). `shardLocalTables` puts `threads` just before `messages` (still after `embeddings*`), so a
thread is nearly always there before its messages and the new shard's trigger counts each one.

A merge stopped at its run cap leaves a stop record (`guest-merge-stopped`, tagged with the new account, no time to live).
`acquireMergeLease` and `recordGuestMerge` read it before they write a lease or a record: a late delivery or a repeated
hand-over stops at once, and the sweep has no record to restart. Without it a late delivery took generation 1 after the
stop dropped the lease, wrote a fresh record, and the sweep restarted it until its generation passed the guest shard's.

A guest row the clear read but the guest deleted before `deleteShardRows` ran is reported back as `gone`, never taken as
deleted by the merge: the clear's import may just have written it on the new shard. `dropRowsGoneFromGuest` removes that
copy there only while it still matches its import marker (the account never changed it), and keeps the marker, so no
later import writes it again. An absent source row is never a confirmation of the copy that was read from it.

A row the copy brought over and the guest deleted before the clear read its table is never seen by the clear. The
clear's import records every row of its page it is about to delete (`guest-merge-cleared`, keyed as the import marker,
written before the guest's delete, so a run cut off in between keeps the copy); a row `deleteShardRows` keeps for a
changed digest loses its record until the clear reads it again. Once the clear has emptied a table, the `reconcile`
phase pages its import markers on the new shard (`listUnclearedImports`, the clear's page size, so an audited table's
drop stays within the D1 budget), asks the guest's shard which of those without a record it no longer holds
(`listRowsMissingOnGuest`), and hands them to `dropRowsGoneFromGuest`: an unchanged copy goes, an account-edited one
stays, the marker stays. Three calls a step, its cursor the last marker key, safe to run again. The records go with the
markers (`dropImportMarkersPage`) and count for `mergeCleanupPending`.

`auth/hooks.ts#deleteMergedGuest` reads the guest's `user` row from the primary: a replica that has not seen it yet
would pass for the anonymous plugin's deletion and the guest would stay.

The root dispatch clears a shard's due time only while it still holds the value it read, and puts it back (never
throwing) when the tick's send fails; a merge's save (`noteShardDue`'s `rearmPassed` only) moves a passed one so it is
not cleared; the tick replaces only the one it read (`consumed`).

Everything after the lease is taken runs inside the `try` that gives it back.

An erasure of either account that begins during a run is fenced where the guest's data would move, not only at the run's
start (`beginMergeRun`): each step that writes guest data on the new account's side (`importShardRows` for the copy and
the clear, `handOverOrganizationContributors`, `reassignGlobalRows`, `reassignThreadFollowsPage`, `moveSharedPinRouteOf`;
the owner shard's pin move already checks) reads both accounts' erasing markers (primary, two D1 reads) after its lease
check and before any write (`stoppedForErasure`). Seeing one, it writes nothing and stops the merge in that transaction:
markers end, the progress record goes, the result says `erasing`, and the run ends `stopped` with no further call, so no
clear page is deleted on the guest's shard and the guest stays for its erasure to take. The deletion waits for the merge's
markers and erases only the guest's shard, so without this a later import of the same run would have handed guest rows to
the new account after the erasure began. The reconcile's and the clear's take-backs (`dropRowsGoneFromGuest`) are not
fenced: they only remove copies from the new account.

Rule for what moved before the erasure: a row, global row, follow or route a step wrote before that step saw the guest's
erasing marker is the new account's, as anything the account holds is, and goes only with the new account's own erasure;
the guest's erasure takes what is still on the guest's shard. A step that read no marker counts as before the erasure even
when the marker was written while it ran: the deletion then still waits on the merge's live markers, and the next step
stops.

A fenced merge with import or account-move markers left drains its `markers` phase. Every step that writes checks the
lease generation first (owner-shard pin moves: both accounts' erasure markers).

The new account's `importing` marker is shared by every merge into it: each merge holds it through its own
`guest-merge-importing` claim, and only the last live holder ends it; a merge's own cleanup is read from its own
claims, never the marker.

The merge reads the guest's shard whole only on its own shard (`onGuestShard`); on dev's shared `SHARD_ROUTING=off` it
stops at once (`sharedShard`), never fenced done. Every stop (cap, sweep drop, erasure, gone account, shared store)
ends its markers, keeps the guest.
