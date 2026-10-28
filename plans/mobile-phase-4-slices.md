# Mobile Phase 4 — shippable slices

Splits §7 Phase 4 (auth + chat + threads + composer/attachments + push) and the
billing row into four slices. Each ships on its own. Owner picks slice 1 first.

Backend refs are `file:line` at the time of writing. "Exists" means the
backend entry point is there; the mobile app may not call it yet.

## Slice 1 — signed-in shell and thread list (read-only)

**Already in the tree:** sign-in (`apps/mobile/src/auth/sign-in.ts`, PKCE in
`grant.ts`), secure store, `app/index.tsx` thread list, `app/chat/[threadId].tsx`
message read.

- `getThreadListData`: exists, `backend/lunora/chat/composite.ts:195`.
- `getThreadUIMessages`: exists, `backend/lunora/chat/functions.ts:772`.
- Extension grant: exists, `backend/lunora/auth/extension-grant-http.ts:256-259`
  (`/extension/auth/*`).
- `MOBILE_REDIRECT_URI`: exists, `backend/lunora/lib/extension-origins.ts:88`,
  admitted only when listed in `TRUSTED_EXTENSION_REDIRECT_URIS` (line 132).

**Acceptance**
1. Sign in on an iOS simulator and an Android emulator, with the redirect
   listed in the backend env. Without it, `parseTrustedExtensionRedirectUris`
   drops the URI with a warning and sign-in fails.
2. The thread list shows the signed-in user's threads (count matches the web app).
3. Opening a thread shows its text parts in order. Reasoning and tool parts are
   not shown; the code says so (`toRow`).
4. Sign-out clears the secure-store grant. Relaunch lands signed out.

**Out of scope:** sending, streaming, branches, files, attachments, the
`@legendapp/list` benchmark (the list is a plain `FlatList` here).

## Slice 2 — streaming reply

**Already in the tree:** `apps/mobile/src/chat/stream.ts` (`relayReply`, resume
loop, tested in `stream.test.ts`) and `chat-api.ts` (`startChat` →
`POST /v1/chat`, `chat/chat-api.ts`).

- Gateway `POST /v1/chat` forwards to backend `/chat/start`:
  `services/llm-gateway/src/routes/v1/chat.ts:247,266`; backend
  `backend/lunora/chat/http.ts:261,311`.
- Gateway `POST /v1/stream` (NDJSON relay, resumable): `services/llm-gateway/src/routes/v1/client-stream.ts:125`.
- Backend `POST /chat/chunks` (the poll): `backend/lunora/http.ts:264`,
  `backend/lunora/chat/streaming/persistent/http-api.ts:84`.

**Gap fixed (2026-10-28):** the chat screen passed the global `fetch` (RN) into
`relayReply`; RN's fetch exposes no readable body, so `relayReply` returned
"failed" on the `!response.body` check. The relay now goes through `expo/fetch`
(`apps/mobile/src/lib/streaming-fetch.ts`). Still to prove on a device: a token
arrives before the reply completes (acceptance 1).

**Acceptance**
1. A prompt sent on a phone streams to the screen with first text in under
   2 s on Wi-Fi, against the deployed gateway.
2. Killing the network mid-reply and restoring it resumes without a duplicate or
   a gap (`lastChunkIndex` count matches the stored message text).
3. **Markdown-while-streaming (open question, §7).** Measure on a 50-message
   thread on a mid-range Android: frame time during a 2-minute stream, reported
   as p95 frame time. Threshold: p95 under 33 ms (30 fps) with no dropped
   scroll. Candidates: native renderer vs one `"use dom"` Streamdown per message.
   Pick the first that passes; if neither does, ship plain text while streaming
   and render markdown on completion.
4. `@legendapp/list` vs FlashList v2 on the same thread, same device, same metric.
   Pick the one with lower p95.

**Out of scope:** tool approvals, branches (`‹ 2/3 ›`), regenerate, edit,
attachments, background-resume of a stream.

## Slice 3 — push notifications (APNs / FCM)

**Backend status:** Web Push only.

- `subscribePush` / `unsubscribePush` / `getPushSubscriptionStatus`:
  `backend/lunora/notifications/push.ts:57,108,126`. Keys are `auth` + `p256dh`
  (`push.ts:61`), which are Web Push fields. No native token shape exists.
- Endpoint allow-list is Web Push services only: `push-endpoint.ts:23`.
- Fan-out is `sendPushForNotification` (`push.ts:170`), called from `notify()`.

**Must build (none of this exists):**
- A device-token subscription kind (Expo push token or raw APNs/FCM), with its
  own table or a `kind` column on `lunora_push_subscriptions`.
- A send path in `sendPushForNotification` that routes by kind.
- Sign-out unregister for native tokens (mirrors `useReleasePushOnSignOut`).

**Acceptance**
1. Token registered on sign-in; row visible for the user; removed on sign-out.
2. An approval request on the web reaches a signed-in phone in under 10 s with
   the app backgrounded (iOS simulator with a real APNs key, Android emulator with FCM).
3. Tapping the notification opens the right thread.
4. Another account on the same phone receives its own pushes only.
5. Push is off when the native keys are unset (same as VAPID today).

**Out of scope:** the Web Push path, badge counts, quiet hours, widgets.

## Slice 4 — billing

**Decision (§9.2):** iOS shows no upgrade UI and no checkout link.

**Exists:**
- `getMyPlan` (`backend/lunora/billing/plans.ts:85`) — read-only, safe to call on any platform.
- `createCheckout` (`backend/lunora/billing/checkout.ts:118`) returns a hosted
  checkout URL; `openCustomerPortal` at `:160`.
- Creem webhook `/billing/creem/webhook` (`backend/lunora/http.ts:134`).
- Web billing UI: `apps/web/src/features/billing/components/personal-plan-card.tsx`.

**Acceptance**
1. iOS build: no upgrade button, no link to checkout, no "manage plan" that
   opens a payment page. A plan label (read-only) is allowed.
2. Android build: decide first whether Play policy allows an external checkout
   link for digital goods. Mark as open until someone reads the current Play
   policy. If not allowed, same as iOS.
3. Web: unchanged.

**Out of scope:** StoreKit, Play Billing, receipt validation. Not needed while
iOS hides the flow.

## Store review items (§8) that block submission

| Slice | Item | Blocks |
| --- | --- | --- |
| 1 | Account deletion reachable in-app (GDPR erasure exists; no in-app entry yet) | App Store |
| 1 | "Sign in with Apple" if any social login is offered (today: only the extension grant) | App Store |
| 2 | UGC report/abuse path for model output shown in the thread | App Store, Play |
| 3 | Push permission prompt with a stated reason | App Store |
| 4 | No payment link on iOS; Android per Play policy check | App Store, Play |

## Owner decisions needed before slice 1

1. **Sign-in grant.** Approve the extension grant for the app and the
   `neore-mobile://auth/callback` URI (`backend/lunora/lib/extension-origins.ts:88`).
   Requires adding it to `TRUSTED_EXTENSION_REDIRECT_URIS` on every stage. Run
   the `lunora-auth` review before code.
2. **Scheme.** Keep `neore-mobile://` as the default (`apps/mobile/app.json:6`),
   or pick a different one now. Changing it later means a new backend allow-list entry.
3. **Bundle id.** `ai.neore.mobile` (`app.json:10,14`) is fixed once a store build uploads.
4. **Slice order.** Recommend slice 1, then 2. Slice 2 is the risk: it gates the
   streaming UX and the markdown decision. Slice 3 needs native push credentials
   (APNs key, FCM project) that the owner must provide.
5. **Signing accounts** (§9.1): Apple and Google developer accounts for slice 1 TestFlight.
