/**
 * The account's approved callback hosts for Events webhooks (`public-api/events-webhook.ts`). A subscription is accepted only
 * when its host is on this list. The owner adds and removes hosts in the app, behind their session, and an API key cannot: a
 * client cannot approve the host it wants events sent to.
 *
 * The table belongs to this module, so the owner's writes sit next to the other account settings. The Events code reads it
 * through `isHostApproved`, and writes nothing.
 */
import { LunoraError, v } from "lunorash/server";

import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { MAX_APPROVED_HOSTS, normalizeApprovedHost } from "../public-api/events-webhook";

/** Whether `host` is on `userId`'s approved list. The only read the Events code makes of this table. */
export const isHostApproved = async (ctx: Pick<QueryCtx, "db">, userId: string, host: string): Promise<boolean> => {
    const row = await ctx.db.eventWebhookHosts.findFirst({ where: { host, userId } });

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
        const { page } = await ctx.db.eventWebhookHosts.findMany({ limit: MAX_APPROVED_HOSTS, where: { userId: ctx.user.userId } });

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
        const host = normalizeApprovedHost(args.host);

        if (host === null) {
            throw new LunoraError("INVALID_INPUT", "Enter a host name such as hooks.example.com, without a scheme, port or path.");
        }

        const { userId } = context.user;

        if (await isHostApproved(context, userId, host)) {
            return { host };
        }

        const { page } = await context.db.eventWebhookHosts.findMany({ limit: MAX_APPROVED_HOSTS, where: { userId } });

        if (page.length >= MAX_APPROVED_HOSTS) {
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
        const host = normalizeApprovedHost(args.host);

        if (host === null) {
            return { removed: false };
        }

        const { page } = await context.db.eventWebhookHosts.findMany({ limit: 1, where: { host, userId: context.user.userId } });

        for (const row of page) {
            await context.db.delete("eventWebhookHosts", row._id);
        }

        context.log.event("eventWebhookHosts.remove", { removed: page.length > 0 });

        return { removed: page.length > 0 };
    });

/** Erases the account's approved hosts (account deletion, `gdpr/steps/deletion-steps.ts`). */
export const deleteEventWebhookHostsOf = async (ctx: Pick<MutationCtx, "db">, userId: string): Promise<void> => {
    const { page } = await ctx.db.eventWebhookHosts.findMany({ where: { userId } });

    for (const row of page) {
        await ctx.db.delete("eventWebhookHosts", row._id);
    }
};
