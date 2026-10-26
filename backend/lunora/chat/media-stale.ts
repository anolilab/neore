/**
 * Fails "generating…" rows that nothing will ever finish. A generate action
 * saves a `pending` row carrying a `__*_GENERATING__` marker and replaces it
 * when the render ends. Called from the jobs queue, the row is stamped with the
 * job's key and `chat/media-abandon.ts` fails it when the delivery dies. Called
 * by an agent tool or a workflow it has no stamp, so if the action dies there
 * (evicted, a crash between the save and the `try`) the row spins for good.
 *
 * This sweep (per-shard housekeeping, `lib/shard-housekeeping.ts`) fails those
 * rows once they are older than any generation can still be running. Stamped
 * rows are left to the claim reaper, which knows whether its job is alive.
 */
import { MODEL_REGISTRY } from "@neore/ai/models";
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { patchRow } from "../lib/patch";
import { isThreadLocked } from "../lib/thread-lock";
import { ABANDONED_MEDIA_TEXT, stampedJobId } from "./media-abandon";

const MINUTE_MS = 60 * 1000;

/** The placeholder texts the generate actions write (image, audio, video, music). */
export const MEDIA_GENERATING_MARKERS: ReadonlySet<string> = new Set(["__AUDIO_GENERATING__", "__IMAGE_GENERATING__", "__MUSIC_GENERATING__", "__VIDEO_GENERATING__"]);

const MEDIA_MODES: ReadonlySet<string> = new Set(["image", "music", "text-to-speech", "video"]);

/** The slowest media model's typical latency; `avgLatencyMs` is an average, hence the factor below. */
const SLOWEST_MEDIA_LATENCY_MS = Math.max(0, ...MODEL_REGISTRY.filter((model) => model.mode && MEDIA_MODES.has(model.mode)).map((model) => model.avgLatencyMs ?? 0));

/** A generate action runs inside an action, which Cloudflare ends at 15 minutes wall time. */
const ACTION_WALL_TIME_MS = 15 * MINUTE_MS;

/**
 * How old a pending media row must be before it counts as abandoned: five times
 * the slowest media model's average latency (never under the action wall-time
 * cap), plus a margin. Derived from the registry so a slower model raises it.
 */
export const MEDIA_STALE_AFTER_MS = Math.max(5 * SLOWEST_MEDIA_LATENCY_MS, ACTION_WALL_TIME_MS) + 15 * MINUTE_MS;

/** Rows read per page, and in total per run: stamped and locked rows are skipped, so a plain `limit` could starve. */
const PAGE_SIZE = 100;
const MAX_ROWS_PER_RUN = 500;

const markerOf = (row: { message?: unknown; text?: string }): string | undefined => {
    if (row.text !== undefined) {
        return row.text;
    }

    const content = (row.message as { content?: unknown } | undefined)?.content;

    return Array.isArray(content) ? (content[0] as { text?: string } | undefined)?.text : undefined;
};

export const failStaleMediaRows = internalMutation
    .input({})
    .output(v.object({ failed: v.number() }))
    .mutation(async ({ ctx }) => {
        const cutoff = ctx.now - MEDIA_STALE_AFTER_MS;
        const lockedThreads = new Map<string, boolean>();
        let cursor: string | undefined;
        let failed = 0;
        let scanned = 0;

        do {
            const page = await ctx.db.messages.findMany({
                cursor,
                limit: PAGE_SIZE,
                where: { _creationTime: { lt: cutoff }, status: "pending", tool: false },
            });

            scanned += page.page.length;
            cursor = page.isDone ? undefined : (page.continueCursor ?? undefined);

            for (const row of page.page) {
                const marker = markerOf(row);

                if (marker === undefined || !MEDIA_GENERATING_MARKERS.has(marker) || stampedJobId(row.providerMetadata) !== undefined) {
                    continue;
                }

                if (!lockedThreads.has(row.threadId)) {
                    const thread = await ctx.db.get(row.threadId);

                    lockedThreads.set(row.threadId, thread !== null && isThreadLocked(thread));
                }

                // A locked chat takes no placeholder text, as in `failAbandonedMediaJob`.
                if (lockedThreads.get(row.threadId)) {
                    continue;
                }

                await patchRow(ctx.db, row, {
                    error: "The generation stopped before it finished.",
                    message: { content: [{ text: ABANDONED_MEDIA_TEXT, type: "text" }], role: "assistant" },
                    status: "failed",
                    text: ABANDONED_MEDIA_TEXT,
                });
                failed += 1;
            }
        } while (cursor && scanned < MAX_ROWS_PER_RUN);

        return { failed };
    });
