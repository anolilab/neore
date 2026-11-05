# NOTIFICATIONS — AGENT NOTES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

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
