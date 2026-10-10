import { v } from "lunorash/server";
import z from "zod/v4";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { publicAction, rateLimit } from "../lib/crpc";
import type { ChangelogEntry } from "./schema";
import { FETCH_TIMEOUT_SHORT_MS, fetchWithDeadline } from "../lib/fetch-timeout";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FEATUREBASE_API_URL = "https://do.featurebase.app/v2/changelogs";
const FEATUREBASE_VERSION = "2026-01-01.nova";

/**
 * Hard ceiling on the Featurebase call. This runs on the first-paint path, and
 * an unbounded outbound fetch here does not just make the changelog slow — every
 * other request on the `__root__` shard queues behind it. Measured on
 * 2026-09-04: one Featurebase call sat for 8.5s before returning 403, and the
 * five first-paint queries (`getUserSettings`, `getThreadListData`,
 * `listProjects`, x2 each) all blocked for 5.8s and completed within 90ms of
 * each other the moment it let go. The browser had already given up by then, so
 * `wrangler dev`'s ProxyWorker reported `Network connection lost.` and wrangler
 * escalated that to a fatal exit, taking the backend down with it.
 */
/** How long to stop calling Featurebase after it fails. */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Per-isolate circuit breaker.
 *
 * A failure was previously never recorded anywhere — the `catch` and the
 * `!response.ok` branch both returned the stale cache WITHOUT writing it — so a
 * bad or expired `FEATUREBASE_API_KEY` meant a fresh outbound call, and a fresh
 * stall, on literally every page load. Deliberately isolate-local rather than a
 * `changelogCache` column: `.global()` D1 tables here are created lazily with
 * whatever shape they had on first access, so adding a column to a table that
 * already exists locally is a runtime `no column named ...` waiting to happen.
 * Per-isolate is also the right granularity for a circuit breaker.
 */
let featurebaseCooldownUntil = 0;

// ---------------------------------------------------------------------------
// Internal cache helpers
// ---------------------------------------------------------------------------

export const getCachedChangelogs = internalQuery.input({}).query(async ({ ctx }) => await ctx.db.changelogCache.findFirst({}));

export const setCachedChangelogs = internalMutation
    .input({
        entries: v.array(v.any()),
        fetchedAt: v.number(),
        total: v.number(),
    })
    .mutation(async ({ args, ctx }) => {
        const existing = await ctx.db.changelogCache.findFirst({});

        if (existing) {
            await ctx.db.patch(existing._id, {
                entries: args.entries,
                fetchedAt: args.fetchedAt,
                total: args.total,
            });
        } else {
            await ctx.db.insert("changelogCache", {
                entries: args.entries,
                fetchedAt: args.fetchedAt,
                total: args.total,
            });
        }
    });

// ---------------------------------------------------------------------------
// Zod schema for the response type (used for output validation)
// ---------------------------------------------------------------------------

const changelogCategorySchema = z.object({
    name: z.string(),
});

const changelogEntrySchema = z.object({
    categories: z.array(changelogCategorySchema),
    commentCount: z.number(),
    content: z.string(),
    createdAt: z.string(),
    date: z.string(),
    featuredImage: z.string().nullable(),
    id: z.string(),
    isPublished: z.boolean(),
    slug: z.string(),
    state: z.string(),
    title: z.string(),
    updatedAt: z.string(),
    url: z.string(),
});

// ---------------------------------------------------------------------------
// Public action — returns cached changelog entries, refreshing when stale
// ---------------------------------------------------------------------------

/**
 * Refresh the cache from Featurebase. Scheduled, never awaited by a caller.
 *
 * This is the half that must NOT run on the request path. It performs an
 * outbound fetch, and a `__root__` procedure holds that shard for its whole
 * duration — so every other first-paint query queues behind it. Measured on
 * 2026-09-06 with the old inline version: `getChangelogs` took 10454ms while
 * thirteen other RPCs sat behind it at ~7s each, and `wrangler dev` then died.
 */
export const refreshChangelogs = internalAction.input({}).action(async ({ ctx }): Promise<void> => {
    const apiKey = process.env.FEATUREBASE_API_KEY;

    if (!apiKey) {
        return;
    }

    try {
        const url = new URL(FEATUREBASE_API_URL);

        url.searchParams.set("limit", "30");
        url.searchParams.set("sortBy", "date");
        url.searchParams.set("sortOrder", "desc");
        url.searchParams.set("state", "live");

        const response = await fetchWithDeadline(url.href, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Featurebase-Version": FEATUREBASE_VERSION,
            },
            timeoutMs: FETCH_TIMEOUT_SHORT_MS,
        });

        if (!response.ok) {
            console.error(`[Changelog] Featurebase API error: ${response.status}`);

            featurebaseCooldownUntil = Date.now() + FAILURE_BACKOFF_MS;

            // Cancel the body we are about to discard. An unread response stream
            // leaves the runtime holding a socket nobody drains, which
            // `wrangler dev` escalates into a fatal `Network connection lost.`
            await response.body?.cancel();

            return;
        }

        const data = (await response.json()) as { data: unknown[]; pagination: { total: number } };
        const rawEntries = data.data ?? [];

        // Validate each entry against the schema to prevent storing malformed/malicious data
        const entries = rawEntries.filter((entry: unknown) => {
            const result = changelogEntrySchema.safeParse(entry);

            if (!result.success) {
                console.warn("[Changelog] Invalid entry filtered out:", result.error.message);
            }

            return result.success;
        });

        await ctx.runMutation(internal.changelog.functions.setCachedChangelogs, {
            entries,
            fetchedAt: Date.now(),
            total: entries.length,
        });

        featurebaseCooldownUntil = 0;
    } catch (error) {
        console.error("[Changelog] Failed to fetch from Featurebase:", error);

        featurebaseCooldownUntil = Date.now() + FAILURE_BACKOFF_MS;
    }
});

/**
 * Serve whatever is cached, and refresh in the background when it is stale.
 *
 * Stale-while-revalidate rather than fetch-on-miss: the outbound call now runs
 * in a scheduled action, so this procedure only ever does one cached read and
 * releases the `__root__` shard immediately. The first-ever call returns `[]`
 * and the entries appear on the next poll, which is the right trade for a
 * changelog panel — the alternative is holding up the whole first paint.
 */
export const getChangelogs = publicAction
    .use(rateLimit("changelog/read"))
    .input({})
    .output(v.from(z.array(changelogEntrySchema)))
    .action(async ({ ctx }): Promise<ChangelogEntry[]> => {
        const cached = await ctx.runQuery(internal.changelog.functions.getCachedChangelogs, {});
        const entries = (cached?.entries ?? []) as ChangelogEntry[];

        const isCacheFresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
        const isCoolingDown = Date.now() < featurebaseCooldownUntil;

        if (!isCacheFresh && !isCoolingDown && process.env.FEATUREBASE_API_KEY) {
            // Claim the window before scheduling, so a burst of concurrent first
            // paints queues ONE refresh rather than one per request.
            featurebaseCooldownUntil = Date.now() + FAILURE_BACKOFF_MS;

            await ctx.scheduler.runAfter(0, internal.changelog.functions.refreshChangelogs, {});
        }

        ctx.log.event("changelog.get_changelogs", { count: entries.length, isCacheFresh: Boolean(isCacheFresh) });

        return entries;
    });
