/**
 * The run webhook in the GDPR export and account deletion. Wired into
 * `gdpr/workflows/export-workflow.ts` ("collect-run-webhooks") and
 * `gdpr/workflows/deletion-workflow.ts` ("delete-user-run-webhooks").
 *
 * The export carries the URL and the switch, never the secret: the secret is a
 * credential the user can rotate, not a record about them.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";

const BATCH = 200;

export const collectRunWebhookForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ runWebhooks: v.array(v.object({ createdAt: v.number(), enabled: v.boolean(), updatedAt: v.number(), url: v.string() })) }))
    .query(async ({ args: { userId }, ctx }) => {
        const { page } = await ctx.db.runWebhooks.findMany({ limit: 1, where: { userId } });

        return {
            runWebhooks: page.map((row) => {
                return { createdAt: row.createdAt, enabled: row.enabled, updatedAt: row.updatedAt, url: row.url };
            }),
        };
    });

/** Deletes up to `BATCH` rows per call; `hasMore` asks the workflow to call again. Idempotent on retry. */
export const deleteUserRunWebhooks = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const { page } = await ctx.db.runWebhooks.findMany({ limit: BATCH, where: { userId } });

        await Promise.all(page.map(async (row) => await ctx.db.delete("runWebhooks", row._id)));

        return { hasMore: page.length >= BATCH };
    });
