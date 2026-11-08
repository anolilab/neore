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
- **Phone push registration** (`native-push.ts`, `push-device-writes.ts`) —
  on only with `EXPO_ACCESS_TOKEN` (a Worker secret; unset = no row).
    - Tokens are `pushDevices` rows (global, unique `token`, owner-policied, every
      read `consistency: "primary"`). `registerPushDevice` stamps the caller's
      sign-in: the app grant's `grantSessionId` (JWT `gsid`, never `sid`:
      see `auth/AGENTS.md`), else a web `sessionId`; a call without a live one
      registers nothing. A row another user
      holds moves to the caller (`systemDb`): the latest registration wins (one
      that started before the row's last write is refused as superseded). A
      token is not a secret, so a leaked one can take a phone's pushes until it
      registers again (accepted: only the generic alert reaches a phone).
      A registration refused after its write (its session ended, or an account
      deletion started meanwhile) takes its row back: the registration it
      replaced is put back only while that sign-in is live (erasure revokes an
      account's sessions first, so a deleted account fails it). Only Lunora's `kind: "unique"` conflict is a race.
    - At most 10 per user (`trimPushDevices`). An account merge drops the guest's
      rows (`dropPushDevicesOf`) instead of moving them: they belong to a session
      that ends with the guest.
- **Phone push delivery** (`phone-delivery.ts`, `expo-push.ts`) — **no title
  ever leaves us**: every phone gets the same placeholder (`push-text.ts`,
  English until the phone reports its language; never `userSettings.language`,
  which is the AI-reply language) with only `notificationId`/`threadId` as data.
    - A phone is sent to only while the session that registered it exists and has
      not expired; an ended one is dropped at the next send.
    - Otherwise a row is deleted only on `DeviceNotRegistered` in the send's
      ticket. Every drop (this one, and an ended session's) needs the row to
      still have the owner and the session the send read, and not to have
      registered again since (`lastSeenAt <= sentAt`); any other error keeps it.
      Logs carry Expo's error code only, never its message (it can quote the
      token).
    - `notify()` schedules browsers (`sendPushForNotification`) and phones
      (`sendPhonePush`) as separate jobs, so neither holds the other back. The
      phone job is retried only for a failure before its send; a failed send is
      logged, never retried, so no phone gets an alert twice.
