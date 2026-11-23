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
import { onOwnShard } from "../lib/own-shard";
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

/**
 * Nothing that holds or uses the signing secret runs while an admin acts as the owner: a save or a rotation hands the
 * secret back, and a test signs with it, so either would let the admin keep or use a credential with no impersonation
 * mark (`backend/lunora/auth/AGENTS.md`). The read returns no secret and stays open.
 */
const refuseImpersonation = (impersonatedBy: string | null | undefined): void => {
    if (impersonatedBy) {
        throw new LunoraError("FORBIDDEN", "The run webhook cannot be changed or tested while impersonating.");
    }
};

/** The user's row, if any. Reads are bounded by the one-row-per-user rule. */
const ownRow = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<Doc<"runWebhooks"> | null> => {
    const { page } = await ctx.db.runWebhooks.findMany({ limit: 1, where: { userId } });

    return page[0] ?? null;
};

/**
 * The webhook lives on its owner's own shard only, where export, erasure and the account merge read it. A call that
 * names a shared thread owner's shard, or `__root__`, is refused there: a row saved on it would escape all three.
 */
const assertOwnShard = (userId: string): void => {
    if (!onOwnShard(userId)) {
        throw new LunoraError("FORBIDDEN", "The run webhook is saved on your own account only.");
    }
};

export const getRunWebhook = authQuery
    .input({})
    .output(vRunWebhookView)
    .query(async ({ ctx }) => {
        // Off the caller's own shard nothing of theirs is there to read.
        const row = onOwnShard(ctx.user.userId) ? await ownRow(ctx, ctx.user.userId) : null;

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
        const { impersonatedBy, userId } = context.user;

        refuseImpersonation(impersonatedBy);
        assertOwnShard(userId);

        const problem = runWebhookUrlProblem(args.url);

        if (problem !== null) {
            throw new LunoraError("INVALID_INPUT", problem);
        }

        // Encrypted before the read, so the only await between the read and the insert is the write itself. The shard's
        // input gate then keeps two first saves from both finding no row (the same read-then-write rule `rls/policies.ts` names).
        const secret = generateRunWebhookSecret();
        const secretCiphertext = await encryptKey(secret, "tool-keys");
        const existing = await ownRow(context, userId);

        if (existing) {
            await context.db.patch("runWebhooks", existing._id, { enabled: args.enabled, updatedAt: context.now, url: args.url });
            context.log.event("runWebhooks.save", { created: false, enabled: args.enabled });

            return {};
        }

        context.log.event("runWebhooks.save", { created: true, enabled: args.enabled });

        await context.db.insert("runWebhooks", {
            createdAt: context.now,
            enabled: args.enabled,
            secretCiphertext,
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
        refuseImpersonation(context.user.impersonatedBy);
        assertOwnShard(context.user.userId);

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
        const { impersonatedBy, userId } = context.user;

        refuseImpersonation(impersonatedBy);
        assertOwnShard(userId);

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
