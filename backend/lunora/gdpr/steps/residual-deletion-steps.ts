/**
 * Account-deletion steps for the user data `deletion-steps.ts` never reached.
 *
 * A coverage sweep of `schema.ts` against the deletion workflow found 20-odd
 * user-keyed tables nothing deleted — knowledge files and their chunks, every
 * `embeddings_*` row, triggers, messenger connections, API keys, sandbox
 * sessions, workflow data, the identity rows in D1 (`user` itself included) and
 * the `documentHistory` snapshots the audit triggers write on EVERY delete.
 *
 * ## Owners erase their own rows
 *
 * A step here owns no table it writes to but `usageDaily` and the identity and
 * ledger rows nothing else owns. Every other table is erased by a plain function
 * in its owner's `<module>/gdpr.ts` (`agent/gdpr.ts`, `knowledge/gdpr.ts`,
 * `triggers/gdpr.ts`, …), called from the step with the same `ctx`, so the
 * write stays in this mutation's transaction and the `cross_module_table_write`
 * advisor sees each write in the module that owns it.
 *
 * ## Batching
 *
 * Every mutation here removes at most {@link BATCH} rows per table and returns
 * `{ hasMore }`; the workflow calls it in a loop inside ONE `step.do` until it
 * reports done (see `drain` in `deletion-workflow.ts`) — one durable step per
 * phase, however large the account, so the instance's step budget is not the
 * limit. Each call is its own transaction, and a retried step simply re-queries
 * from the start: deleting is idempotent. The reads use `.take(BATCH)` rather
 * than `collect()`, so one account cannot build a transaction the Durable Object
 * cannot finish.
 *
 * ## What is kept, and why
 *
 * - `gatewayUsageDeductions` are credit-ledger records: amounts stay, the owner
 *   becomes {@link DELETED_USER_MARKER} (constant, so nothing maps back).
 * - `gdprRequests` / `gdprAuditLog` are the proof that the request was honoured
 *   (Art. 5(2) accountability). They keep the user id and request metadata only:
 *   see {@link minimiseGdprRecords}.
 * - `emails` (the bounce/complaint suppression list) and `organization` rows the
 *   user owns are NOT touched here — the first is kept so we never mail a
 *   bouncing address again, the second belongs to other members too.
 */
import { v } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import {
    eraseEmbeddingsForUser,
    eraseChatFileAccessForUser,
    eraseStreamingMessagesForUser,
    eraseWorkflowExecutionsForProject,
    eraseWorkflowExecutionsForUser,
} from "../../agent/gdpr";
import { eraseSubAgentRunsForUser } from "../../sub-agents/gdpr";
import { eraseSystemPromptPresetsForUser } from "../../system-prompts/gdpr";
import { eraseWorkflowVersionsAndPresenceForProject, eraseWorkflowVersionsAndPresenceForUser } from "../../workflow/gdpr";
import { eraseSkillRatingRows } from "../../skills/gdpr";
import { eraseKnowledgeForUser, eraseProjectKnowledgeForProject } from "../../knowledge/gdpr";
import { eraseTriggersForUser } from "../../triggers/gdpr";
import { eraseSandboxSessionsForUser } from "../../sandbox/gdpr";
import { eraseMessengerConnectionsForUser } from "../../messenger/gdpr";
import { queueOrganizationBillingCancel, teamBillingOnAccountDeletion } from "../../billing/gdpr";
import { queueSeatSync } from "../../billing/seats";
import { E2B_API_KEY } from "../../env";
import type { StoredOAuthClient } from "../../connectors/lib/grant-runtime";
import { revokeStoredGrant } from "../../connectors/lib/grant-runtime";
import { BATCH, deleteOneByOne, type BatchResult, full } from "../batch";
import { forgetMessengerCredentials } from "../../messenger/lib/forget";
import { FETCH_TIMEOUT_SHORT_MS, fetchWithDeadline } from "../../lib/fetch-timeout";
import { gdprLogger } from "../../lib/logger";
import { scheduleObjectDeletion } from "../../lib/storage-cleanup";
import { recomputeSkillRatings } from "../../skills/rating-cascade";
import { anonymiseGatewayUsage, deleteIdentityRows, deleteUserRecord, readIdentityRows } from "../../auth/gdpr";
import { eraseUsageForUser } from "../../usage/gdpr";
import { eraseGatewayNotificationsForUser } from "../../saas/gdpr";
import { DELETED_USER_MARKER } from "../constants";

export { BATCH };

export { DELETED_USER_MARKER };

const vBatchResult = v.object({ hasMore: v.boolean() });

/** Rate-limit rows read per page while erasing a user's windows (`minimiseGdprRecords`). */
export const RATE_LIMIT_PAGE = 500;

// --- External side effects (actions, best-effort) ---------------------------

export const listMessengerConnectionsForDeletion = internalQuery
    .input({ userId: v.string() })
    .output(v.array(v.object({ platform: v.string() })))
    .query(async ({ args: { userId }, ctx: context }) => {
        const connections = await context.db
            .query("messengerConnections")
            .withIndex("by_user_and_platform", (q) => q.eq("userId", userId))
            .collect();

        return connections.map((connection) => {
            return { platform: connection.platform };
        });
    });

/**
 * Point the user's Telegram bot away from us before its connection row goes,
 * and forget what we cached for every other platform.
 *
 * Telegram is the only platform whose webhook we can remove with the bot token:
 * Slack's Events URL, Discord's interactions endpoint, WhatsApp's callback, the
 * LINE / Feishu webhook URLs, the Teams messaging endpoint and WeChat's server
 * URL are app settings in the vendor console. For those, "forget" is what we can
 * do: drop the access tokens this isolate cached from the user's credentials
 * (the rows, dedupe records and encrypted keys go in later steps). Their
 * credentials are deliberately NOT revoked at the vendor — they belong to the
 * user's own app, which may serve other things. Once the connection row is gone
 * every webhook to its URL answers 401. Best-effort, and it MUST run before
 * `deleteUserSettings`, which deletes the encrypted keys.
 */
export const deregisterMessengerWebhooks = internalAction
    .input({ userId: v.string() })
    .output(v.null())
    .action(async ({ args: { userId }, ctx }) => {
        const connections = (await ctx.runQuery(internal.gdpr.steps.residual_deletion_steps.listMessengerConnectionsForDeletion, { userId })) as {
            platform: string;
        }[];

        if (connections.length === 0) {
            return null;
        }

        try {
            const keys = (await ctx.runQuery(internal.auth.functions.getDecryptedMessengerKeysQuery, { userId })) as Record<string, string>;

            forgetMessengerCredentials(keys);

            const botToken = connections.some((connection) => connection.platform === "telegram") ? keys.telegram_bot_token : undefined;

            if (botToken) {
                const response = await fetchWithDeadline(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
                    method: "POST",
                    timeoutMs: FETCH_TIMEOUT_SHORT_MS,
                });

                await response.body?.cancel();
            }
        } catch (error) {
            gdprLogger.warn("Telegram webhook deregistration failed; continuing with deletion:", error);
        }

        return null;
    });

/**
 * Revoke every connector grant at its provider, so erasing the account also
 * ends the third-party access it granted. Best-effort per grant — a provider
 * that is down or already revoked must not block the deletion — and it MUST run
 * before `deleteUserConnectors`, which deletes the encrypted tokens.
 */
export const revokeUserConnectorGrants = internalAction
    .input({ userId: v.string() })
    .output(v.null())
    .action(async ({ args: { userId }, ctx }) => {
        const grants = await ctx.runQuery(internal.connectors.store.listGrantsForRevocation, { userId });
        const results = await Promise.all(grants.map(async (grant) => await revokeStoredGrant(grant.encryptedTokens, grant.oauthClient as StoredOAuthClient)));
        const failed = results.filter((revoked) => !revoked).length;

        if (failed > 0) {
            gdprLogger.warn(`Connector revocation: ${String(failed)} of ${String(grants.length)} grant(s) not confirmed; continuing with deletion`);
        }

        return null;
    });

export const listSandboxIdsForDeletion = internalQuery
    .input({ userId: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args: { userId }, ctx: context }) => {
        const sessions = await context.db
            .query("sandboxSessions")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .collect();

        return sessions.filter((session) => session.sandboxId && session.status !== "terminated").map((session) => session.sandboxId as string);
    });

/** Kill the user's live E2B sandboxes. Best-effort: most have already timed out. */
export const killUserSandboxes = internalAction
    .input({ userId: v.string() })
    .output(v.null())
    .action(async ({ args: { userId }, ctx }) => {
        if (!E2B_API_KEY) {
            return null;
        }

        const sandboxIds = (await ctx.runQuery(internal.gdpr.steps.residual_deletion_steps.listSandboxIdsForDeletion, { userId })) as string[];

        if (sandboxIds.length === 0) {
            return null;
        }

        const { Sandbox } = await import("e2b");

        await Promise.allSettled(
            sandboxIds.map(async (sandboxId) => await Sandbox.kill(sandboxId, { apiKey: E2B_API_KEY, requestTimeoutMs: FETCH_TIMEOUT_SHORT_MS })),
        );

        return null;
    });

// --- Batched deletions -------------------------------------------------------

/**
 * The usage page's per-day rollup (`usage/activity.ts`): one row per skill per
 * day, so an active year is hundreds of them — plus its bookkeeping, the keys
 * of the replies it counted (`usageReplies`) and the backfill's position
 * (`usageBackfill`), which a step still running finds gone and stops.
 */
export const deleteUserUsageDaily = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }): Promise<BatchResult> => await eraseUsageForUser(context, userId));

/**
 * Sub-agent runs (`sub-agents/gdpr.ts`). A run still in flight finds its row
 * gone and posts nothing.
 */
export const deleteUserSubAgentRuns = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }): Promise<BatchResult> => await eraseSubAgentRunsForUser(context, userId));

/**
 * Knowledge files, chunks, links and collections (`knowledge/gdpr.ts`), with
 * the embeddings their chunks point at (`agent/gdpr.ts`).
 */
export const deleteUserKnowledge = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }): Promise<BatchResult> => await eraseKnowledgeForUser(context, userId));

/** Every `embeddings_*` row owned by the user (`agent/gdpr.ts`). */
export const deleteUserEmbeddings = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }): Promise<BatchResult> => await eraseEmbeddingsForUser(context, userId));

/** Streaming-message rows outlive their thread when a stream is abandoned (`agent/gdpr.ts`). */
export const deleteUserStreamingMessages = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }): Promise<BatchResult> => await eraseStreamingMessagesForUser(context, userId));

/**
 * Integrations and automations, each erased by its owner: messenger connections
 * (`messenger/gdpr.ts`), attachment grants (`agent/gdpr.ts`), triggers with their
 * run history (`triggers/gdpr.ts`) and sandbox sessions with their command log
 * (`sandbox/gdpr.ts`). The claim-once rows, notifications and consent records
 * the user owns are erased here.
 */
export const deleteUserIntegrations = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }): Promise<BatchResult> => {
        const [claims, consents] = await Promise.all([
            // Claim-once rows tagged with the user (`lib/claim-once.ts`): messenger
            // event ids and trigger-webhook deliveries.
            context.db
                .query("idempotencyClaims")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .take(BATCH),
            context.db
                .query("gdprConsent")
                .withIndex("by_user_and_purpose", (q) => q.eq("userId", userId))
                .take(BATCH),
        ]);

        // `gdprConsent` is audited: one delete at a time (`gdpr/batch.ts`).
        await deleteOneByOne(context, claims);
        await deleteOneByOne(context, consents);

        // The user's system-prompt presets (`system-prompts/gdpr.ts`).
        const presets = await eraseSystemPromptPresetsForUser(context, userId);

        const notifications = await eraseGatewayNotificationsForUser(context, userId);

        const connections = await eraseMessengerConnectionsForUser(context, userId);
        const fileGrants = await eraseChatFileAccessForUser(context, userId);
        const triggers = await eraseTriggersForUser(context, userId);
        const sessions = await eraseSandboxSessionsForUser(context, userId);

        return {
            hasMore:
                [claims, consents].some((rows) => full(rows)) ||
                presets.hasMore ||
                notifications.hasMore ||
                connections.hasMore ||
                fileGrants.hasMore ||
                triggers.hasMore ||
                sessions.hasMore,
        };
    });

/**
 * Workflow-builder data. By `userId` for what the user did anywhere, and by
 * project for everything attached to projects the user owns — including other
 * people's presence rows, which point at a project that is about to vanish.
 * Runs BEFORE `deleteUserProjects`, which only removes the project rows.
 * Executions and project knowledge are erased by their owners
 * (`agent/gdpr.ts`, `knowledge/gdpr.ts`).
 */
export const deleteUserWorkflowData = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }): Promise<BatchResult> => {
        const userExecutions = await eraseWorkflowExecutionsForUser(context, userId);
        let hasMore = userExecutions.hasMore;

        // Versions and presence the user wrote, anywhere (`workflow/gdpr.ts`).
        const userVersions = await eraseWorkflowVersionsAndPresenceForUser(context, userId);
        hasMore ||= userVersions.hasMore;

        const { page: projects } = await context.db.projects.findMany({ where: { userId } });

        for (const project of projects) {
            // Versions and presence attached to the project (`workflow/gdpr.ts`).
            const projectRows = await eraseWorkflowVersionsAndPresenceForProject(context, project._id);
            const executions = await eraseWorkflowExecutionsForProject(context, project._id);
            const knowledge = await eraseProjectKnowledgeForProject(context, project._id);

            hasMore ||= projectRows.hasMore || executions.hasMore || knowledge.hasMore;
        }

        return { hasMore };
    });

/**
 * Keep the credit ledger, drop the owner. The amounts are accounting records;
 * the constant marker makes the rows unattributable. It terminates because a
 * rewritten row stops matching.
 */
export const anonymiseGatewayUsageDeductions = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }): Promise<BatchResult> => await anonymiseGatewayUsage(context, userId));

/**
 * The identity side in D1 that `deleteAuthRecords` leaves behind: 2FA,
 * passkeys, organization/team membership and member credits, better-auth API keys, rating
 * rows, pending invitations addressed to the user's email — and finally the
 * `user` row itself, last, once nothing else points at it.
 *
 * Invitations the user SENT are left: they belong to the invitee and the org.
 */
export const deleteUserIdentity = internalMutation
    .input({ userEmail: v.string(), userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userEmail, userId }, ctx: context }): Promise<BatchResult> => {
        const id = userId as Id<"user">;

        const [identity, skillRatings] = await Promise.all([
            readIdentityRows(context, { userEmail, userId }),
            context.db.skillRatings.findMany({ limit: BATCH, where: { userId } }).then((result) => result.page),
        ]);
        const hasMore = Object.values(identity).some((rows) => full(rows)) || full(skillRatings);

        // Take this user's scores out of the averages of the skills they rated
        // BEFORE their rating rows go: once a row is deleted, nothing says which
        // skill it counted towards. Recomputed without them, so a retry is a no-op.
        await recomputeSkillRatings(
            context.db,
            skillRatings.map((rating) => rating.skillId),
            userId,
        );

        // Sequential, one table at a time: every delete fires the audit triggers.
        await deleteIdentityRows(context, identity);

        // The rating rows themselves (`skills/gdpr.ts`).
        await eraseSkillRatingRows(context, skillRatings);

        // Team billing (these deletes bypass better-auth's hook in `auth.ts`): a Team
        // this user pays for is cancelled — found by purchaser, so also after they
        // left the organization — and so is one left without members; any other
        // organization they belonged to has its seats re-billed. Both jobs re-read
        // at run time, so a batch retry queues them again harmlessly.
        const { page: purchased } = await context.db.organization.findMany({ limit: BATCH, where: { creemPurchaserId: userId } });
        const purchasedIds = new Set(purchased.map((organization) => organization._id as string));
        const affected = new Set([...purchasedIds, ...identity.members.map((member) => member.organizationId)]);

        await Promise.all(
            [...affected].map(async (organizationId) => {
                const remainingMembers = await context.db.member.count({ organizationId });
                const action = teamBillingOnAccountDeletion({ isPurchaser: purchasedIds.has(organizationId), remainingMembers });

                await (action === "cancel" ? queueOrganizationBillingCancel(organizationId) : queueSeatSync(organizationId));
            }),
        );

        if (hasMore) {
            return { hasMore: true };
        }

        await deleteUserRecord(context, id);

        return { hasMore: false };
    });

/**
 * The audit triggers snapshot every delete of an audited table into
 * `documentHistory` — `userSettings`, `prompts`, `gdprConsent`, `session`, the
 * `user` row… — so deleting an account WRITES copies of what it removes. This
 * must therefore be the last data step, after `deleteUserIdentity`.
 */
export const purgeUserDocumentHistory = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }): Promise<BatchResult> => {
        const { page } = await context.db.documentHistory.findMany({ limit: BATCH, where: { userId } });

        for (const row of page) {
            await context.db.delete(row._id);
        }

        return { hasMore: full(page) };
    });

/** Audit-detail keys that are request metadata; anything else is dropped. */
const AUDIT_DETAIL_KEYS = new Set(["action", "requestedAt", "requestId", "timedOutAt"]);

const minimiseDetails = (details: string): string => {
    try {
        const parsed = JSON.parse(details) as unknown;

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return "{}";
        }

        return JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([key]) => AUDIT_DETAIL_KEYS.has(key))));
    } catch {
        return "{}";
    }
};

/**
 * `gdprRequests` and `gdprAuditLog` are KEPT — they are the record that the
 * erasure happened (Art. 5(2), Art. 17) and are what answers a regulator or a
 * later dispute. They are minimised to the user id and request metadata:
 * the email address and free-text error messages go, the export file (if one is
 * still stored) is deleted, and audit `details` keep only the whitelisted keys.
 *
 * Runs after the final `log-audit` step. Per-user volumes here are a handful of
 * rows (both writers are rate-limited), and rewriting is idempotent, so this is
 * one pass rather than rounds.
 */
export const minimiseGdprRecords = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { userId }, ctx: context }) => {
        const [requests, auditRows] = await Promise.all([
            context.db
                .query("gdprRequests")
                .withIndex("by_user_and_type", (q) => q.eq("userId", userId))
                .collect(),
            context.db
                .query("gdprAuditLog")
                .withIndex("by_user", (q) => q.eq("userId", userId))
                .collect(),
        ]);

        for (const request of requests) {
            if (request.storageId) {
                await scheduleObjectDeletion(context, [request.storageId]);
            }

            // `null` clears an optional column; `undefined` is rejected by `patch`.
            await context.db.patch(request._id, {
                downloadUrl: null,
                errorMessage: null,
                storageId: null,
                userEmail: "",
            });
        }

        for (const row of auditRows) {
            const details = minimiseDetails(row.details);

            if (details !== row.details) {
                await context.db.patch(row._id, { details });
            }
        }

        // Rate-limit windows keyed to the user. Keys are `neore:<name>:<identifier>`
        // and the identifier is often composite (`<connection>:<sender>`), so the
        // userId is never an index prefix: walk the `by_key` index one page at a
        // time and keep the `includes` match. Bounded per page, not per call.
        let cursor: string | null = null;
        let isDone = false;

        while (!isDone) {
            const page = await context.db.query("rateLimits").withIndex("by_key").paginate({ cursor, numItems: RATE_LIMIT_PAGE });

            for (const limit of page.page) {
                if (limit.key.includes(userId)) {
                    await context.db.delete(limit._id);
                }
            }

            cursor = page.continueCursor;
            isDone = page.isDone;
        }

        return null;
    });
