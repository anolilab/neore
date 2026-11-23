/**
 * The Events log and the Events webhook subscriptions in account deletion (`gdpr/workflows/deletion-workflow.ts`, step
 * "delete-user-mcp-events"). The log holds the owner's run and approval events; the subscriptions hold their callback URLs and
 * encrypted secrets. Both are erased in batches, and the workflow calls again while `hasMore` says so.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";

const BATCH = 200;

/** Deletes up to `BATCH` of the user's events per call. Idempotent on retry. */
export const deleteUserMcpEvents = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const { page } = await ctx.db.mcpEvents.findMany({ limit: BATCH, where: { userId } });
        const { page: subscriptions } = await ctx.db.eventWebhookSubscriptions.findMany({ limit: BATCH, where: { userId } });
        const { page: deliveries } = await ctx.db.eventWebhookDeliveries.findMany({ limit: BATCH, where: { userId } });
        const { page: verifications } = await ctx.db.eventWebhookVerifications.findMany({ limit: BATCH, where: { userId } });

        for (const row of page) {
            await ctx.db.delete("mcpEvents", row._id);
        }

        for (const row of deliveries) {
            await ctx.db.delete("eventWebhookDeliveries", row._id);
        }

        for (const row of verifications) {
            await ctx.db.delete("eventWebhookVerifications", row._id);
        }

        for (const row of subscriptions) {
            await ctx.db.delete("eventWebhookSubscriptions", row._id);
        }

        return { hasMore: [page, subscriptions, deliveries, verifications].some((batch) => batch.length >= BATCH) };
    });
