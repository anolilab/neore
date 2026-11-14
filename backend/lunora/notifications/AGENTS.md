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
  in the language the phone reported at registration, English without one; never
  `userSettings.language`, which is the AI-reply language) with only `notificationId`/`threadId` as data.
    - **Exception: a tool approval** that carries its `approvalId` (`notification.approvalId`) is pushed with the tool's
      name as the title and the teammate's name (the thread's bot, `thread.botId` → `bots.name`, or the app's name without one)
      as the body, plus the `tool_approval` action set
      (approve, deny) and the approval id in `data`. Never its arguments. Sent only while the approval is still pending
      on its chat (`approvalPushNames`): not for an answered one, a foreign chat, a question or a secret request. A locked
      chat gets the generic alert instead, so the owner still learns a run waits. Its answer goes through
      `respondToToolApproval`, as the in-app card's does.
    - A phone is sent to only while the session that registered it exists and has
      not expired; an ended one is dropped at the next send.
    - Otherwise a row is deleted only on `DeviceNotRegistered`, in the send's
      ticket or in its receipt (read 15 min later, asked again on
      `RECEIPT_RETRY_DELAYS_MS` while missing, inside Expo's 24 h). Every drop (this one, and an ended session's) needs the row to
      still have the owner and the session the send read, and not to have
      registered again since (`lastSeenAt <= sentAt`); any other error keeps it.
      Logs carry Expo's error code only, never its message (it can quote the
      token).
    - `notify()` schedules browsers (`sendPushForNotification`) and phones
      (`sendPhonePush`) as separate jobs, so neither holds the other back. The
      phone job is retried only for a failure before its send; a failed send is
      logged, never retried, so no phone gets an alert twice.
    - **Android data-only** (`buildsAlert` on the row, set by a build that runs the
      background task): the message is ids only, and the app builds the alert. Roll
      an Android build back only after `ANDROID_DATA_ONLY_PUSH=off` is set (the repo
      variable of that name, deployed to the Worker; the switch is read in
      `native-push-config.ts`), or a phone that still stores the flag gets pushes
      with no alert.
- **Phone push content** (`push-content-http.ts`, `phone-content.ts`) —
  `POST /notifications/push-content` gives a phone the text of one of its
  owner's notifications (`pushHeadline`, the same as Web Push). Another user's
  or a missing id: the same 404; not an id: 400; a failure on our side: a
  logged 503. Only a notification linking to a chat ever gets text: one linking
  elsewhere can carry chat content (a task round's answer on `/tasks`, the
  Daily Brief) with no chat to check, so it stays generic. A chat-linked one
  gets text only while the chat, read
  at request time on the shard it lives on (`threadShardFor`, `callOnShard`),
  is fully readable by the caller (`resolveThreadReadAccess`) and not locked,
  passcode-protected, deleted or archived; otherwise `{ generic: true }`. Body
  capped at 1 KiB while read; 120 requests a minute per caller.
