/**
 * Develop mode, freshness: the repositories a user chose to keep up to date.
 *
 * A watched repository has a cached list (the open pull requests that ask the user for a review), refreshed when
 * Develop opens (`refreshWatchedRepositories`) and by polling through the shard tick
 * (`freshness-internal.ts`). Only watched repositories are ever polled, so the user's API budget is spent where they
 * asked. A webhook is optional: it can only mark a repository dirty so the next tick polls it.
 *
 * Every row is the caller's own, stamped from `ctx.user`. The host the row is for comes from the driver, never from
 * the client. The webhook secret is encrypted at rest and is returned exactly once, when it is issued.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { encryptKey } from "../lib/encryption";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow } from "../lib/patch";
import { deleteShardRoute, setShardRoute } from "../lib/shard-routes";
import { noteShardDue } from "../lib/shard-housekeeping";
import { MAX_LENGTH } from "../lib/validators";
import { DEVELOP_DRIVER } from "./develop-driver";
import { MAX_WATCHED_REPOSITORIES } from "./freshness-logic";
import { hostPoll, runRepoPoll } from "./freshness-poll";
import { vCachedRequest, vPollStatus } from "./validators";

const vWatched = v.object({
    checkedAt: v.number(),
    dirty: v.boolean(),
    id: v.string(),
    lastStatus: vPollStatus,
    repository: v.string(),
    requested: v.array(vCachedRequest),
    webhook: v.object({ enabled: v.boolean(), seenAt: v.number() }),
});

const rowFor = async (ctx: Pick<QueryCtx, "db">, userId: string, repo: string): Promise<Doc<"watchedRepositories"> | null> => {
    // The same text `watchRepo` accepts (a URL, a `.git` suffix); text that is no repository matches no row.
    const wanted = DEVELOP_DRIVER.normalizeRepository(repo)?.toLowerCase();

    if (wanted === undefined) {
        return null;
    }

    const rows = await ctx.db
        .query("watchedRepositories")
        .withIndex("by_user_and_repository", (q) => q.eq("userId", userId).eq("hostOrigin", DEVELOP_DRIVER.webOrigin))
        .take(MAX_WATCHED_REPOSITORIES + 1);

    // GitHub's repository names ignore case, so `Octo/Hello` and `octo/hello` are one watch.
    return rows.find((row) => row.repository.toLowerCase() === wanted) ?? null;
};

/** The caller's watched repositories with their cached lists, live: a poll on the shard shows without a refetch. */
export const listWatchedRepositories = authQuery
    .input({})
    .output(v.object({ limit: v.number(), watched: v.array(vWatched) }))
    .query(async ({ ctx }) => {
        const rows = await ctx.db
            .query("watchedRepositories")
            .withIndex("by_user_and_repository", (q) => q.eq("userId", ctx.user.userId).eq("hostOrigin", DEVELOP_DRIVER.webOrigin))
            .take(MAX_WATCHED_REPOSITORIES);

        return {
            limit: MAX_WATCHED_REPOSITORIES,
            watched: rows.map((row) => {
                return {
                    checkedAt: row.checkedAt,
                    dirty: row.dirtyAt > 0,
                    id: row._id,
                    lastStatus: row.lastStatus,
                    repository: row.repository,
                    requested: row.requested,
                    webhook: { enabled: row.webhookSecret !== undefined, seenAt: row.webhookSeenAt },
                };
            }),
        };
    });

/** Starts watching a repository: its first poll is the baseline, so existing review requests do not notify. */
export const watchRepo = authMutation
    .use(rateLimit("sourceControl/watch"))
    .input({ repository: v.string().max(MAX_LENGTH.short) })
    .output(v.object({ status: v.union(v.literal("invalid"), v.literal("limit"), v.literal("ok")) }))
    .mutation(async ({ args, ctx }) => {
        const repo = DEVELOP_DRIVER.normalizeRepository(args.repository);

        if (repo === null) {
            return { status: "invalid" as const };
        }

        const { userId } = ctx.user;

        if ((await rowFor(ctx, userId, repo)) !== null) {
            return { status: "ok" as const };
        }

        const held = await ctx.db
            .query("watchedRepositories")
            .withIndex("by_user_and_repository", (q) => q.eq("userId", userId))
            .take(MAX_WATCHED_REPOSITORIES);

        if (held.length >= MAX_WATCHED_REPOSITORIES) {
            return { status: "limit" as const };
        }

        const { now } = ctx;

        await ctx.db.insert("watchedRepositories", {
            checkedAt: 0,
            createdAt: now,
            dirtyAt: 0,
            etag: null,
            hostOrigin: DEVELOP_DRIVER.webOrigin,
            lastStatus: "ok",
            leasedAt: 0,
            login: null,
            nextPollAt: now,
            repository: repo,
            requested: [],
            seeded: false,
            userId,
            webhookSeenAt: 0,
        });
        await noteShardDue(ctx, now, userId);

        return { status: "ok" as const };
    });

/** Stops watching: the row goes, so no tick dispatches it and a poll already in flight records nothing. */
export const unwatchRepo = authMutation
    .use(rateLimit("sourceControl/watch"))
    .input({ repository: v.string().max(MAX_LENGTH.short) })
    .output(v.object({ removed: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const row = await rowFor(ctx, ctx.user.userId, args.repository);

        if (row === null) {
            return { removed: false };
        }

        if (row.webhookSecret !== undefined) {
            await deleteShardRoute(ctx, "watch", row._id);
        }

        await ctx.db.delete(row._id);

        return { removed: true };
    });

/**
 * Issues the secret for a repository's webhook (the person adds it on the host by hand). Shown once; asking
 * again rotates it, which makes the old one useless at once.
 */
export const enableWatchWebhook = authMutation
    .use(rateLimit("sourceControl/watch"))
    .input({ repository: v.string().max(MAX_LENGTH.short) })
    .output(
        v.union(
            v.object({ id: v.string(), secret: v.string(), status: v.literal("ok") }),
            v.object({ status: v.union(v.literal("not_found"), v.literal("unsupported")) }),
        ),
    )
    .mutation(async ({ args, ctx }) => {
        // A host whose deliveries we cannot verify has no webhook to set up.
        if (DEVELOP_DRIVER.webhookScheme === null) {
            return { status: "unsupported" as const };
        }

        const row = await rowFor(ctx, ctx.user.userId, args.repository);

        if (row === null) {
            return { status: "not_found" as const };
        }

        const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

        await ctx.db.patch(row._id, { webhookSecret: await encryptKey(secret, "tool-keys"), webhookSeenAt: 0 });
        await setShardRoute(ctx, "watch", row._id, ctx.user.userId);

        return { id: row._id, secret, status: "ok" as const };
    });

export const disableWatchWebhook = authMutation
    .use(rateLimit("sourceControl/watch"))
    .input({ repository: v.string().max(MAX_LENGTH.short) })
    .output(v.object({ disabled: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const row = await rowFor(ctx, ctx.user.userId, args.repository);

        if (row?.webhookSecret === undefined) {
            return { disabled: false };
        }

        await patchRow(ctx.db, row, { webhookSecret: undefined, webhookSeenAt: 0 });
        await deleteShardRoute(ctx, "watch", row._id);

        return { disabled: true };
    });

/**
 * "Refresh on open": polls the caller's watched repositories that were not checked in the last few seconds. With
 * a stored ETag each is one request the host does not count when nothing changed. Develop's route calls it;
 * `/chat` never does.
 */
export const refreshWatchedRepositories = authAction
    .use(rateLimit("sourceControl/refresh"))
    .input({})
    .output(v.object({ polled: v.number(), status: v.literal("ok") }))
    .action(async ({ ctx }) => {
        const { userId } = ctx.user;
        const leased = await ctx.runMutation(internal.source_control.freshness_internal.leaseWatchedRepositoriesForRefresh, { userId });

        if (leased.length === 0) {
            return { polled: 0, status: "ok" as const };
        }

        const poll = hostPoll(DEVELOP_DRIVER, await resolveGithubToken(ctx, userId));

        for (const { lease, watchId } of leased) {
            await runRepoPoll(
                {
                    fetch: poll,
                    read: async () => await ctx.runQuery(internal.source_control.freshness_internal.getWatchForPoll, { watchId }),
                    record: async (outcome) => await ctx.runMutation(internal.source_control.freshness_internal.recordRepoPoll, { lease, outcome, watchId }),
                },
                lease,
            );
        }

        ctx.log.event("source_control.refresh_watched", { polled: leased.length });

        return { polled: leased.length, status: "ok" as const };
    });
