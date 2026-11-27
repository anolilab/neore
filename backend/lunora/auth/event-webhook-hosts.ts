/**
 * The account's approved callback hosts for Events webhooks (`public-api/events-webhook.ts`). A subscription is accepted only
 * when its host is on this list. The owner adds and removes hosts in the app, behind their session, and an API key cannot: a
 * client cannot approve the host it wants events sent to.
 *
 * The table belongs to this module, so the owner's writes sit next to the other account settings. The Events code reads it
 * through `isHostApproved`, and writes nothing.
 */
import { LunoraError, v } from "lunorash/server";

import type { QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { isErasing } from "../lib/account-moves";
import { onOwnShard } from "../lib/own-shard";
import { MAX_APPROVED_HOSTS, MAX_LISTED_APPROVED_HOSTS, normalizeApprovedHost } from "../public-api/events-webhook";

/** Whether `host` is on `userId`'s approved list. The only read the Events code makes of this table. */
export const isHostApproved = async (ctx: Pick<QueryCtx, "db">, userId: string, host: string): Promise<boolean> => {
    // From the primary: a host removed a moment ago must not still pass on a replica that has not seen the removal.
    const row = await ctx.db.eventWebhookHosts.findFirst({ consistency: "primary", where: { host, userId } });

    return row !== null && row !== undefined;
};

/** The router's pre-check, run on the owner's shard before any DNS lookup. */
export const hostApproved = internalQuery
    .input({ host: v.string(), userId: v.string() })
    .output(v.object({ approved: v.boolean() }))
    .query(async ({ args, ctx }) => {
        return { approved: await isHostApproved(ctx, args.userId, args.host) };
    });

export const listEventWebhookHosts = authQuery
    .input({})
    .output(v.object({ hosts: v.array(v.object({ createdAt: v.number(), host: v.string() })) }))
    .query(async ({ ctx }) => {
        const { page } = await ctx.db.eventWebhookHosts.findMany({ limit: MAX_LISTED_APPROVED_HOSTS, where: { userId: ctx.user.userId } });

        return {
            hosts: page.map((row) => {
                return { createdAt: row.createdAt, host: row.host };
            }),
        };
    });

/**
 * Approves a host. Idempotent: an approved host is answered as it is. The shard's input gate serializes the check and the
 * insert, so two adds of one host cannot both insert.
 */
export const addEventWebhookHost = authMutation
    .input({ host: v.string().max(253) })
    .use(rateLimit("eventWebhookHosts/update"))
    .output(v.object({ host: v.string() }))
    .mutation(async ({ args, ctx: context }) => {
        // An admin acting as the owner must not change the list that authorizes where events are sent.
        if (context.user.impersonatedBy) {
            throw new LunoraError("FORBIDDEN", "Callback hosts cannot be approved while impersonating");
        }

        if (!onOwnShard(context.user.userId)) {
            throw new LunoraError("FORBIDDEN", "Callback hosts are saved on your own account only.");
        }

        const host = normalizeApprovedHost(args.host);

        if (host === null) {
            throw new LunoraError("INVALID_INPUT", "Enter a host name such as hooks.example.com, without a scheme, port or path.");
        }

        const { userId } = context.user;

        // The erasure's host step runs once, before auth records go: a host approved after it would survive the erasure.
        if (await isErasing(context, userId)) {
            throw new LunoraError("FORBIDDEN", "This account is being deleted, so no callback host can be approved.");
        }

        if (await isHostApproved(context, userId, host)) {
            return { host };
        }

        // A merge can leave one host in two rows, so the cap counts the distinct host names the owner approves.
        const { page } = await context.db.eventWebhookHosts.findMany({ limit: MAX_LISTED_APPROVED_HOSTS, where: { userId } });

        if (new Set(page.map((row) => row.host)).size >= MAX_APPROVED_HOSTS) {
            throw new LunoraError("INVALID_INPUT", `An account can approve up to ${String(MAX_APPROVED_HOSTS)} hosts.`);
        }

        await context.db.insert("eventWebhookHosts", { createdAt: context.now, host, userId });
        context.log.event("eventWebhookHosts.add", {});

        return { host };
    });

/**
 * Removes a host from the list. Idempotent. Subscriptions that already name the host are not ended here: part 2b checks the
 * list again before each delivery, so a removed host stops receiving events without a separate step.
 */
export const removeEventWebhookHost = authMutation
    .input({ host: v.string().max(253) })
    .use(rateLimit("eventWebhookHosts/update"))
    .output(v.object({ removed: v.boolean() }))
    .mutation(async ({ args, ctx: context }) => {
        if (context.user.impersonatedBy) {
            throw new LunoraError("FORBIDDEN", "Callback hosts cannot be removed while impersonating");
        }

        if (!onOwnShard(context.user.userId)) {
            throw new LunoraError("FORBIDDEN", "Callback hosts are saved on your own account only.");
        }

        const host = normalizeApprovedHost(args.host);

        if (host === null) {
            return { removed: false };
        }

        // Every row of the host: a merge can leave one host in two rows, and removing only one would leave it approved.
        // From the primary: a duplicate row a replica has not seen would stay, and the host would still be approved.
        const { page } = await context.db.eventWebhookHosts.findMany({
            consistency: "primary",
            limit: MAX_APPROVED_HOSTS,
            where: { host, userId: context.user.userId },
        });

        for (const row of page) {
            await context.db.delete("eventWebhookHosts", row._id);
        }

        context.log.event("eventWebhookHosts.remove", { removed: page.length > 0 });

        return { removed: page.length > 0 };
    });
