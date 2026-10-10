/**
 * The one way to write a notification.
 *
 * Call {@link notify} from a mutation, or `internal.notifications.functions.createNotification`
 * from an action — both land here. It:
 *
 * - writes on the RECIPIENT's shard. A notification belongs to its user
 *   (docs/plans/per-user-sharding.md), and a writer is not always there — a
 *   grantee's run pauses on the thread OWNER's shard. Off it, the write is
 *   scheduled onto the recipient's shard instead of landing where their inbox
 *   never looks.
 * - is idempotent on `dedupeKey`: queue jobs and workflow steps are delivered at
 *   least once, and a redelivered "task finished" must not notify twice.
 * - schedules Web Push only when the user has a subscription (`ctx.push`, in
 *   D1) and the deployment has VAPID keys, so a user without push costs one
 *   indexed read, no job.
 */
import type { Infer } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { servesUser } from "../lib/shard-context";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { isPushConfigured } from "./push-config";
import type { vNotificationInput } from "./validators";

export type NotificationInput = Infer<typeof vNotificationInput>;

export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 1000;
const DEDUPE_KEY_MAX = 200;

// eslint-disable-next-line no-control-regex -- control characters are exactly what a link must not carry
const CONTROL_CHARACTERS = /[\u{0}-\u{1F}\u{7F}]/u;

/**
 * An in-app path, or nothing. A link is rendered as a router `<Link>` and handed
 * to the service worker's `openWindow`, so only a same-origin path is accepted —
 * never a scheme, a protocol-relative `//host` or a backslash trick.
 */
export const safeNotificationLink = (link: string | undefined): string | undefined => {
    if (link === undefined || !link.startsWith("/") || link.startsWith("//") || link.includes("\\") || link.length > 500) {
        return undefined;
    }

    return CONTROL_CHARACTERS.test(link) ? undefined : link;
};

const clamp = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The row as it is stored: text clamped, link sanitised. Pure; pinned by `notify.test.ts`. */
export const normalizeNotification = (input: NotificationInput) => {
    const body = input.body?.trim();
    const link = safeNotificationLink(input.link);

    return {
        title: clamp(input.title.trim() || "—", NOTIFICATION_TITLE_MAX),
        type: input.type,
        userId: input.userId,
        ...(body && { body: clamp(body, NOTIFICATION_BODY_MAX) }),
        ...(input.dedupeKey && { dedupeKey: input.dedupeKey.slice(0, DEDUPE_KEY_MAX) }),
        ...(link && { link }),
        ...(input.outcome && { outcome: input.outcome }),
    };
};

/**
 * Write a notification for `input.userId`. Returns its id, or `null` when it was
 * a duplicate, was handed to the recipient's shard, or the recipient's account
 * is being deleted. Never throws for a
 * duplicate; a notification must not fail the work it reports on.
 */
export const notify = async (ctx: MutationCtx, input: NotificationInput): Promise<Id<"notifications"> | null> => {
    if (!servesUser(input.userId)) {
        await runAfterOnShard(ctx.scheduler, 0, internal.notifications.functions.createNotification, { ...input }, input.userId);

        return null;
    }

    // A late writer (an import finishing, a trigger run, an export step) must
    // not leave a row behind the GDPR deletion step that already erased them.
    if (await isAccountDeletionUnderway(ctx, input.userId)) {
        return null;
    }

    const row = normalizeNotification(input);

    if (row.dedupeKey !== undefined) {
        const existing = await ctx.db.notifications.findFirst({ where: { dedupeKey: row.dedupeKey, userId: row.userId } });

        if (existing) {
            return null;
        }
    }

    const notificationId = await ctx.db.insert("notifications", { ...row, createdAt: Date.now() });

    if (isPushConfigured()) {
        const [device] = await ctx.push.list({ limit: 1, userId: row.userId });

        if (device) {
            await ctx.scheduler.runAfter(0, internal.notifications.push.sendPushForNotification, { notificationId, userId: row.userId });
        }
    }

    return notificationId;
};

/** For writers that must not fail on a notification: logs and swallows. */
export const notifyQuietly = async (ctx: MutationCtx, input: NotificationInput): Promise<void> => {
    try {
        await notify(ctx, input);
    } catch (error) {
        console.warn(`[notifications] Failed to write a ${input.type} notification:`, error);
    }
};
