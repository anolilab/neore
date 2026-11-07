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
- **Push** (`src/notifications/`, `targets/notification-service/`) — the EXPO push token (`getExpoPushTokenAsync`,
  project id from `EAS_PROJECT_ID`) is registered on every sign-in and token rotation, silently when permission was
  already given, and retried on foreground until registered; the system prompt shows only after the person sends a
  message (`offerPhonePush`) and only when the server has push on. A push carries only ids, never text: iOS shows the
  placeholder, and the Notification Service Extension (Swift, `@bacons/apple-targets`) rewrites it with the text from
  `/notifications/push-content`, signing in with the session grant from the APP'S OWN keychain group (its application
  identifier, listed for both in `app.config.ts`), so a pre-update grant is already readable; the grant is
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` so a locked phone can read it). Android gets a data-only message: `background-task.ts`, loaded first from `index.ts`, fetches the text
  and posts the notification itself; the placeholder on any failure. Mirror any change to the fetch in both
  `push-content.ts` and `NotificationService.swift`; both re-read the session after the fetch and keep the placeholder
  if it changed or is gone. Sign-out: cache wipe, then `takeStoredGrant` clears the keychain item the extension reads
  (before any network wait), then the registration gate closes, in-flight registrations settle, the token is released
  (bounded to 5 s), and the session is revoked, with the token a failed keychain clear still carries. Delivered
  alerts and a held tap are dropped on sign-out, on a server-ended session (`emptyCacheWhileSignedOut`) and on an
  account switch, which is detected across relaunches (`noteAccountOnPhone`). A refused grant (401) clears only that
  grant, never a newer one: the push background task runs beside the app.
  `secureGrantStore` rewrites a pre-update grant over itself once (`upgradeGrantInPlace`, a `SecItemUpdate` that carries
  `keychainAccessible`, or the old accessibility stays), never delete-and-re-add, retried on the next use if it fails; keychain items are written only when they differ. A 404 from the content route (another account's
  notification) posts nothing on Android. A tapped notification's chat is held (`pending-tap.ts`): the hook goes
  there once signed in and past sign-in, otherwise the sign-in gate goes there instead of the chat list. Android needs
  `google-services.json` (`GOOGLE_SERVICES_JSON`).
