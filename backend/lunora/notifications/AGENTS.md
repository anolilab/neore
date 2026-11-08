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
      session (`sid`; a call without one registers nothing). A row another user
      holds moves to the caller (`systemDb`): the latest registration wins (one
      that started before the row's last write is refused as superseded). A
      token is not a secret, so a leaked one can take a phone's pushes until it
      registers again (accepted: only the generic alert reaches a phone).
      A registration takes its row back if an account deletion started meanwhile.
    - At most 10 per user (`trimPushDevices`). An account merge drops the guest's
      rows (`dropPushDevicesOf`) instead of moving them: they belong to a session
      that ends with the guest.
