# MOBILE APP KNOWLEDGE BASE

## INVARIANTS

- **Mobile offline cache** (`apps/mobile/src/offline/`, mobile-acp-and-remote-control.md §3.5) — read-only
  `expo-sqlite` copy of the thread list, the last 50 messages of the 20 newest threads, and host/worker status. Every
  row has `syncedAt`; every upsert is guarded in SQL (`updated_at`, then `synced_at`) and `mergeRows` keeps the newer
  copy and drops nothing, because a row absent from either side proves no deletion (eviction by the caps is not a
  delete either). There is deliberately no outbox table: offline, `write-gate.ts` disables the composer, send,
  approve, cancel and start controls, and `reconnect.ts` only re-runs reads. Any Lunora `.mutation(`/`.action(` call
  in the app must pass `onlineOnly: true`, or the client queues it and replays it on reconnect (`reconnect.test.ts`
  scans for it). The cache is bound to one account (`bindOwner`; a different id empties it) and `clear()` runs on
  sign-out; a save from a screen of a signed-out account is refused. Sign-out empties the cache BEFORE it asks the
  server (`auth/sign-out.ts`), so a failing or hanging request leaves nothing behind. Locked threads are never cached,
  and a chat the server refuses (`FORBIDDEN`/`NOT_FOUND`/`THREAD_LOCKED`, not a lapsed sign-in) is forgotten with its
  statuses and cleared from the screen (`message-read.ts`). A cold start with no network signs the stored user in
  without a JWT (`auth-context.tsx`) so the saved chats can open; that state counts as offline.
  **Stamps and races:** a read stamps its rows with the moment it STARTED (`syncedAt`), and only the newest read of a
  screen may paint or save (`createMessageReadGate`), because messages carry no server version. A thread missing from
  a COMPLETE first-page list read is pruned (`pruneThreads`, rows synced by a later read stay); a partial page never
  prunes. **Writes:** `canWrite` stays false after the network reports back until a request has answered, so the
  controls are off during the transition. Reachability is `isConnected` only (Android's `isInternetReachable` reads
  false until its probe ends) and a successful request overrides a no-network hint. Only fetch's own errors and the
  client's transport errors/timeouts are network failures (`isNetworkFailure`); other `TypeError`s are bugs. **The file
  lives in the cache directory** (`database-path.ts`), not expo-sqlite's default folder, which iOS backs up to iCloud;
  Android Auto Backup never copies the cache directory, so no backup rule is needed (the secure-store plugin owns the
  app's backup rules). `PRAGMA user_version` (`SCHEMA_VERSION` in `cache.ts`) drops and recreates the tables on a
  mismatch: bump it with any `SCHEMA` change. The screens are keyed by the signed-in account.
