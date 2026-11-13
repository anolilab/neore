# MOBILE APP KNOWLEDGE BASE

## INVARIANTS

- **Mobile offline cache** (`apps/mobile/src/offline/`, mobile-acp-and-remote-control.md §3.5) — read-only
  `expo-sqlite` copy of the thread list, the last 50 messages of the 20 newest threads, and host/worker status. Every
  row has `syncedAt`; every upsert is guarded in SQL (`updated_at`, then `synced_at`) and `mergeRows` keeps the newer
  copy and drops nothing, because a row absent from either side proves no deletion (eviction by the caps is not a
  delete either). There is deliberately no outbox table: offline, `write-gate.ts` disables the composer, send,
  approve, cancel and start controls, and `reconnect.ts` only re-runs reads. Any Lunora `.mutation(` call in the app
  must pass `onlineOnly: true` (actions are never queued and take no such option), or the client queues it and replays it on reconnect (`reconnect.test.ts`
  scans for it). The cache is bound to one account (`bindOwner`; a different id empties it) and `clear()` runs on
  sign-out; a save from a screen of a signed-out account is refused. Sign-out empties the cache BEFORE it asks the
  server (`auth/sign-out.ts`), so a failing or hanging request leaves nothing behind. Locked threads are never cached,
  and a chat the server refuses (`FORBIDDEN`/`NOT_FOUND`/`THREAD_LOCKED`, not a lapsed sign-in) is forgotten with its
  statuses and cleared from the screen (`message-read.ts`). Every start signs the stored user in before the first
  token mint answers (`session-state.ts`, `isConfirming`: not offline yet, but every write control waits for the token like a
  connection being checked; the splash holds until the chat list has read its saved rows, at most 2 s,
  `splash-gate.ts`). A mint still out when a sign-in or sign-out starts applies nothing (`createAuthEpoch`). A mint with no answer keeps them signed in without a JWT, which counts as offline; an answered "no session"
  signs out and empties the cache. Live queries wait for a JWT. A project subscription also counts as answered when the
  client's `onSyncStatus` reaches `synced` after registering (a reconnect's `resume` frame calls no rows callback). That
  report waits a microtask: Lunora reports a refused subscription `synced` before its error callback, so an error in
  between drops it, and a refused subscription counts no `synced` until its rows arrive. A 401/403 mint clears the stored
  grant only while it still holds the grant that mint sent (a new sign-in's grant survives an old mint's refusal).
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
- **Sending a message** (`src/chat/start-send.ts`, `chat-api.ts`, `unsent-send.ts`):
  - One `clientMessageId` per composed message, sent on `/v1/chat` and reused on every retry: the server saves it once.
  - 409 `CHAT_START_IN_PROGRESS`: the first try is still saving. Wait and resend (past the server's 2-minute lease); not a failure.
  - A try with no answer (timeout, dropped connection, 5xx) is resent a bounded number of times under the same id.
  - 200 with `duplicate: true`: the first send's ids. Open that chat like any start.
  - 422 `CLIENT_MESSAGE_ID_REUSED`: show it, never retry, drop the id.
  - A send that still fails gives its prompt back with its id held; the same text sent again is the same send.
  - A held prompt is only ever resent alone under its held id (`planSend`): given back ahead of text typed meanwhile,
    Send sends it first and keeps the rest for the next send; editing the prompt itself makes a new message.
  - A send stopped before its first try sends nothing; sign-out ends the mint epoch before its first await (`runSignOut`).
  - A start with `streaming: false` (no `streamToken`) follows no stream: the chat's saved reply is read instead.
  - Match codes lower-cased: the gateway passes `/chat/start`'s SCREAMING_CASE, the public API uses snake_case.
  - Nothing is held and polled for: the resend is idempotent.
- **Voice input paths** (`src/voice/`) — the cloud by default; "Transcribe on this device" (secure store, read on every
  press by `createDictationRouter`) switches to the phone's recognizer. There is NO fallback between them: an on-device
  press that cannot be served shows a message and records nothing, and a setting that cannot be read records nothing.
  On-device means `requiresOnDeviceRecognition: true`, Android 13+ only (older Android merely prefers offline), and the
  pnpm patch on `expo-speech-recognition` that makes iOS fail such a request instead of using the network. Re-check
  that patch on every upgrade of the module. The recognizer is one per app (`createRecognizerLock`): an aborted
  recognition holds it ("draining") until its `end`, heard by an app-wide listener, so a late end never closes a newer press.
- **Push registration** (`src/notifications/`) — the EXPO push token (`getExpoPushTokenAsync`, project id from
  `EAS_PROJECT_ID`; Android also needs `google-services.json`, `GOOGLE_SERVICES_JSON`) is registered with the phone's
  language (`languageTag`: language, script, region only) on every sign-in, token rotation and return to the front
  (at most once a minute after one that went through, `createForegroundGate`), silently when permission was already
  given. A token event registers only when the token changed (`createTokenChangeFilter`): fetching the token fires the
  same event, so registering on every event would loop. The server gives a token to whoever registered it last, so the foreground registration is what takes a phone back
  after someone else registered its token. The system prompt shows only after the person sends a message
  (`offerPhonePush`), once per sign-in, and only when the server has push on. The token is never logged. Sign-out
  closes the registration gate (`pushRegistrations`), lets registrations in flight settle, then releases the token
  (bounded to 5 s) before the grant is revoked, since the release needs the sign-in. The server also sends only while
  the registering session lives, so a failed release still stops the pushes once the revoke lands. Pushes carry only a generic alert and ids.
