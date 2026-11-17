/**
 * The user's outbound run webhook: one row per user, read and written by the
 * settings page, and "Send test" to check the receiver.
 *
 * The secret is created with the row and by a rotation, shown once in the answer
 * to that call, and stored encrypted under the `tool-keys` purpose. No read
 * returns it, so it can only be seen at creation or rotation.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { decryptKey, encryptKey } from "../lib/encryption";
import { deliverRunWebhook } from "./delivery";
import { buildTestEvent, generateRunWebhookSecret, MAX_RUN_WEBHOOK_URL_LENGTH, runWebhookUrlProblem } from "./payload";

const vDeliveryResult = v.object({
    durationMs: v.number(),
    error: v.optional(v.string()),
    ok: v.boolean(),
    status: v.optional(v.number()),
});

const vRunWebhookView = v.object({
    configured: v.boolean(),
    enabled: v.boolean(),
    url: v.optional(v.string()),
});

/** The user's row, if any. Reads are bounded by the one-row-per-user rule. */
const ownRow = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<Doc<"runWebhooks"> | null> => {
    const { page } = await ctx.db.runWebhooks.findMany({ limit: 1, where: { userId } });

    return page[0] ?? null;
};

export const getRunWebhook = authQuery
    .input({})
    .output(vRunWebhookView)
    .query(async ({ ctx }) => {
        const row = await ownRow(ctx, ctx.user.userId);

        return row ? { configured: true, enabled: row.enabled, url: row.url } : { configured: false, enabled: false };
    });

/**
 * Creates the webhook on first save (with a new secret, returned once) or updates
 * the URL and the switch. The secret never changes here; a rotation does that.
 */
export const saveRunWebhook = authMutation
    .input({
        enabled: v.boolean(),
        url: v.string().max(MAX_RUN_WEBHOOK_URL_LENGTH),
    })
    .use(rateLimit("runWebhooks/update"))
    .output(v.object({ secret: v.optional(v.string()) }))
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;
        const problem = runWebhookUrlProblem(args.url);

        if (problem !== null) {
            throw new LunoraError("INVALID_INPUT", problem);
        }

        const existing = await ownRow(context, userId);

        if (existing) {
            await context.db.patch("runWebhooks", existing._id, { enabled: args.enabled, updatedAt: context.now, url: args.url });
            context.log.event("runWebhooks.save", { created: false, enabled: args.enabled });

            return {};
        }

        const secret = generateRunWebhookSecret();

        context.log.event("runWebhooks.save", { created: true, enabled: args.enabled });

        await context.db.insert("runWebhooks", {
            createdAt: context.now,
            enabled: args.enabled,
            secretCiphertext: await encryptKey(secret, "tool-keys"),
            updatedAt: context.now,
            url: args.url,
            userId,
        });

        return { secret };
    });

/** Replaces the secret. The old one stops working at once: there is no overlap in part 1. */
export const rotateRunWebhookSecret = authMutation
    .input({})
    .use(rateLimit("runWebhooks/update"))
    .output(v.object({ secret: v.string() }))
    .mutation(async ({ ctx: context }) => {
        const existing = await ownRow(context, context.user.userId);

        if (!existing) {
            throw new LunoraError("NOT_FOUND", "Save a webhook URL first.");
        }

        const secret = generateRunWebhookSecret();

        await context.db.patch("runWebhooks", existing._id, {
            secretCiphertext: await encryptKey(secret, "tool-keys"),
            updatedAt: context.now,
        });
        context.log.event("runWebhooks.rotate_secret", {});

        return { secret };
    });

/** The row the send action needs, with the secret still encrypted. Internal: no client sees it. */
export const getRunWebhookInternal = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ found: v.boolean(), secretCiphertext: v.optional(v.string()), url: v.optional(v.string()) }))
    .query(async ({ args, ctx }) => {
        const row = await ownRow(ctx, args.userId);

        return row ? { found: true, secretCiphertext: row.secretCiphertext, url: row.url } : { found: false };
    });

/**
 * Sends a signed test event to the saved URL, enabled or not, and reports the
 * answer. Actions are where outbound calls belong (`backend/AGENTS.md`).
 */
export const sendRunWebhookTest = authAction
    .use(rateLimit("runWebhooks/test"))
    .input({})
    .output(vDeliveryResult)
    .action(async ({ ctx: context }) => {
        const { userId } = context.user;
        const row = await context.runQuery(internal.run_webhooks.functions.getRunWebhookInternal, { userId });

        if (!row.found || row.url === undefined || row.secretCiphertext === undefined) {
            throw new LunoraError("NOT_FOUND", "Save a webhook URL first.");
        }

        const secret = await decryptKey(row.secretCiphertext, "tool-keys");
        // Read here: the action context is not the mutation's, and the signature's timestamp must be this attempt's.
        const now = Date.now();
        const attempt = await deliverRunWebhook({
            event: buildTestEvent(now),
            now,
            secret,
            url: row.url,
        });

        // The outcome only: the URL and the secret stay out of the log.
        context.log.event("runWebhooks.send_test", { ok: attempt.ok, status: attempt.status ?? null });

        return attempt;
    });
