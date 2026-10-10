/**
 * `@lunora/notify`: codegen wires `ctx.push` / `ctx.notify` from this file.
 *
 * Web Push only — the app has no native client, so FCM stays unwired. Device
 * subscriptions live in the backend D1 (`DB`), in the package's own lazily
 * created `lunora_push_subscriptions` table, not on the user's shard; GDPR
 * export and deletion reach them through `ctx.push` (`notifications/gdpr.ts`).
 */
import type { D1Like } from "@lunora/notify";
import { d1SubscriptionStore, defineNotify, memorySubscriptionStore } from "@lunora/notify";

import { webPushConfig } from "./notifications/push-config";

const isD1 = (value: unknown): value is D1Like => typeof value === "object" && value !== null && "prepare" in value;

export default defineNotify({
    // Every deployment binds `DB` (the `.global()` tables live there). The store
    // factory runs for every handler ctx, so an env without it — the in-memory
    // test harness — gets a throwaway store instead of failing every procedure.
    store: (env) => (isD1(env.DB) ? d1SubscriptionStore(env.DB) : memorySubscriptionStore()),
    webPush: (env) => webPushConfig(env),
});
