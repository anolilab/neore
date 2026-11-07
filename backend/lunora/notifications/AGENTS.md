# NOTIFICATIONS — AGENT NOTES

## INVARIANTS

- **Notifications, Web Push, home** (`backend/lunora/notifications/`,
  `home/overview.ts`, `apps/web/src/features/{notifications,home}`) — every
  write goes through `notify()` (or `internal.notifications.functions.createNotification`
  from an action): it lands on the RECIPIENT's shard (off it, it is scheduled
  there), is idempotent on `dedupeKey` (queue/workflow redelivery), and
  schedules push only when the user has a subscription. `title` is the
  SUBJECT; the UI words the headline from `type` + `outcome` (push, which has
  no catalog, uses `push-text.ts`). Pruned after 30 days by the housekeeping
  sweep, not a cron. Web Push is `@lunora/notify` (`ctx.push`, configured in
  `lunora/notify.ts`): subscriptions live in its D1 table
  `lunora_push_subscriptions` (lazily created, owner-scoped — not a schema
  table, so not on the user's shard; GDPR reaches it via `ctx.push`). The
  endpoint is browser-supplied, so `isAllowedPushEndpoint` (`push-endpoint.ts`)
  allow-lists the push services (SSRF) before `ctx.push.register`. Sign-out
  must unregister (`useReleasePushOnSignOut`), or the next account on that
  browser is refused the endpoint (`taken`). VAPID keys are
  OPTIONAL — unset, push is off. The SW handlers are `public/push-sw.js`,
  pulled in by `generate-sw.mjs` `importScripts`; there is no SW in dev.
  `/dashboard` is the home, one live `getHomeOverview` query; the bell is one
  live `getNotificationInbox` (after first paint). The Daily Brief is opt-in
  (`userSettings.dailyBriefEnabled`) and scheduled like memory reflection —
  `afterRun` → `noteDailyBriefActivity` → `runAt` local 07:xx — and charged
  via `chargeRound` only when there is something to report.
- **Phone push** (`native-push.ts`, `expo-push.ts`, `push-content-http.ts`,
  `apps/mobile/src/notifications/`, `apps/mobile/targets/notification-service/`)
  — through Expo's push service with push security on (`EXPO_ACCESS_TOKEN`, a
  Worker secret; unset = phone push off: no row, no prompt, no send). **No title
  ever leaves us**: iOS gets the localised placeholder (`push-text.ts`) with
  `mutableContent`, Android a data-only message; both carry only
  `notificationId`/`threadId`. The phone fetches the text from
  `POST /notifications/push-content` (bearer JWT, owner-only, same 404 for any id
  that is not the caller's; a locked chat answers `{ generic: true }`): the iOS
  Notification Service Extension signs in with the session grant from the shared
  keychain group, the Android background task with the same grant. Tokens are
  `pushDevices` rows (global, unique `token`, owner-policied, every read
  `consistency: "primary"`); `registerPushDevice` MOVES an existing row to the
  caller through `systemDb`, which isolates two accounts on one phone, and takes
  its row back if an account deletion started during the write. A row is
  deleted on exactly one signal, `DeviceNotRegistered` (in the ticket, or in a
  receipt), and only while it still has the owner the send was for and has not
  registered again since (`lastSeenAt <= sentAt`); every other error fails the
  send and keeps the row. Receipts are read 15 min after the send; a missing
  one, or a request Expo did not answer, is asked again on
  `RECEIPT_RETRY_DELAYS_MS` (inside Expo's 24 h). The content route answers 404
  for an unknown or foreign id and logs any other failure as a 503; it gives
  text for a chat-linked notification only when the chat, read at request time
  on the shard it lives on (`threadShardFor`, `callOnShard` for a shared chat),
  is still readable by the caller in full (`resolveThreadReadAccess`) and is not
  locked, passcode-protected, deleted or archived. Anything else is generic.
