/**
 * The webhook signature schemes, declared once: `schema.ts` stores one, the
 * procedures accept and return it, `http.ts` keys its handlers on it and
 * `presets.ts` derives its type from it, so a new scheme cannot reach one and not
 * the others.
 *
 * An inline `v.union(...)` of literals: codegen resolves that, not one built by a call.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

/** How a webhook delivery is signed; see `triggers/http.ts`. Absent on a row means "timestamped". */
export const vWebhookSignatureScheme = v.union(v.literal("timestamped"), v.literal("native"), v.literal("gitlab-token"));

export type WebhookSignatureScheme = Infer<typeof vWebhookSignatureScheme>;

/**
 * What an event trigger watches. One object per source, so a mismatched set of fields cannot be stored.
 * `intervalMinutes` is how often the condition is checked (at least five), `cooldownMinutes` how long a
 * source that keeps watching waits after it fires. A moment in time fires once.
 */
export const vEventSource = v.union(
    v.object({
        contains: v.optional(v.string()),
        cooldownMinutes: v.optional(v.number()),
        intervalMinutes: v.optional(v.number()),
        kind: v.literal("page"),
        selector: v.optional(v.string()),
        url: v.string(),
    }),
    v.object({ at: v.number(), kind: v.literal("time") }),
    v.object({
        cooldownMinutes: v.optional(v.number()),
        intervalMinutes: v.optional(v.number()),
        kind: v.literal("thread"),
        threadId: v.string(),
    }),
);

export type EventSourceConfig = Infer<typeof vEventSource>;

/**
 * What the last checks left behind. The sources own `hash`/`matched` (page) and `lastOrder`/`lastStepOrder`
 * (thread); the scheduler owns the rest. An empty object means "no baseline yet": the first check records one.
 */
export const vEventState = v.object({
    // When the watcher was last switched on or pointed at something else. A check carries it and is dropped if it changed
    // (`recordEventCheck`): a quick off/on leaves no other mark an old, in-flight check could be told apart by.
    armedAt: v.optional(v.number()),
    checkedAt: v.optional(v.number()),
    // Consecutive failed checks whose cause the owner can fix; at `TRIGGER_PAUSE_AFTER_FAILURES` the watcher pauses.
    checkFailures: v.optional(v.number()),
    // Consecutive failed checks that heal on their own (a timeout, an outage): they never pause the watcher, they only push the next check out.
    checkRetries: v.optional(v.number()),
    firedAt: v.optional(v.number()),
    hash: v.optional(v.string()),
    lastOrder: v.optional(v.number()),
    lastStepOrder: v.optional(v.number()),
    matched: v.optional(v.boolean()),
    // A firing whose run the jobs queue has not accepted yet; kept so a send that fails is tried again (`startEventRun`) and never lost.
    pendingRun: v.optional(v.object({ firing: v.number(), payload: v.string() })),
});

export type EventState = Infer<typeof vEventState>;
