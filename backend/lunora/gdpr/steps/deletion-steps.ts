import { v } from "lunorash/server";

import { internalMutation } from "../../_generated/server";
import { endHostThread } from "../../acp/lib/thread-removed";
import { deleteAccountsOf, deleteSessionsOf, deleteUserSettingRows } from "../../auth/gdpr";
import { deleteShardRoutesOf } from "../../lib/shard-routes";
import { eraseConnectorsForUser } from "../../connectors/gdpr";
import {
    eraseDocumentsForUser,
    eraseProjectsForUser,
    releaseProjectImagesForUser,
    eraseThreadMetadataForUser,
    eraseThreadPasscodesForUser,
    eraseThreadSuggestionsAndInvites,
} from "../../agent/gdpr";
import {
    eraseSharedPinRoutesBatch,
    eraseThreadPinsAndTagsBatch,
    erasePersistentStreamsForUser,
    erasePresentationsForUser,
    materializePendingPinRoutesBatch,
} from "../../chat/gdpr";
import { deleteFollowRowsOfUserBatch } from "../../chat/follows/functions";
import { eraseVaultForUser } from "../../vault/gdpr";
import { erasePromptsForUser } from "../../prompts/gdpr";
import { eraseMemoriesForUser } from "../../memory/gdpr";
import { eraseImportJobsForUser } from "../../chat-import/gdpr";
import { eraseSkillsForUser } from "../../skills/gdpr";
import { erasePluginsForUser } from "../../plugins/gdpr";
import { eraseBrowserDataForUser } from "../../browser/gdpr";
import { BATCH } from "../batch";

/**
 * Steps that return `{ hasMore }` follow the residual steps' contract
 * (`residual-deletion-steps.ts`): at most {@link BATCH} rows per table per
 * call, drained by the workflow, idempotent on retry — one account's history
 * must never become one transaction the Durable Object cannot finish.
 */
const vBatchResult = v.object({ hasMore: v.boolean() });

export const revokeUserSessions = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { userId }, ctx: context }) => {
        await deleteSessionsOf(context, userId);

        return null;
    });

/**
 * The user's vault: files (with their R2 objects), then folders once no file is
 * left (`vault/gdpr.ts`). At most {@link BATCH} rows per call; `hasMore` while
 * any may remain — the workflow drains it.
 */
export const deleteUserFiles = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx: context }) => await eraseVaultForUser(context, userId));

/** The user's prompts, history, thread variables and variable defaults (`prompts/gdpr.ts`). */
export const deleteUserPrompts = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { userId }, ctx: context }) => {
        await erasePromptsForUser(context, userId);

        return null;
    });

export const deleteUserSettings = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { userId }, ctx: context }) => {
        await deleteUserSettingRows(context, userId);

        // The usage page's per-day rollup goes in its own batched step
        // (`residual-deletion-steps.ts#deleteUserUsageDaily`): a year of it is
        // hundreds of rows per skill.

        // `.global()` routes into this user's shard (webhooks, public links).
        await deleteShardRoutesOf(context, userId);

        return null;
    });

// --- Thread-dependent deletions (MUST run before thread deletion) ---

/** One batch of the pin routes that name the user (`chat/gdpr.ts`), drained by the deletion workflow. */
export const deleteUserSharedPinRoutes = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await eraseSharedPinRoutesBatch(context, userId));

/** One batch of the owed route restores that name the user, made into routes before the second owner-shard sweep (`chat/gdpr.ts`). */
export const materializePendingPinRoutes = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await materializePendingPinRoutesBatch(context, userId));

/** One batch of the user's follow rows on any thread (`chat/follows/functions.ts`); drained by the workflow. */
export const deleteUserFollowRows = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => {
        return { hasMore: !(await deleteFollowRowsOfUserBatch(context, userId)) };
    });

export const deleteUserThreadMetadata = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { userId }, ctx: context }) => {
        // Relationships, temporary threads and thread grants are the agent module's (`agent/gdpr.ts`).
        await eraseThreadMetadataForUser(context, userId);

        // Passcodes are the agent module's; pins and tags are drained by `deleteUserPinsAndTags`.
        await eraseThreadPasscodesForUser(context, userId);

        return null;
    });

/** One batch of the user's pins and tags (`chat/gdpr.ts`), drained by the deletion workflow before the threads go. */
export const deleteUserPinsAndTags = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await eraseThreadPinsAndTagsBatch(context, userId));

/** Threads one {@link deleteUserThreadCascade} call visits. */
export const THREAD_CASCADE_PAGE = 25;

/**
 * `followupSuggestions` and `threadInvites` carry no `userId`, so they are
 * found through the user's threads — a page of threads per call, walked with
 * a cursor the workflow passes back in. A thread whose children fill a batch
 * is visited again (the same cursor comes back), so no call grows with the
 * account. A host thread (a coding agent on a paired computer) is ended here first (`endHostThread`: queued worker
 * runs cancelled, live turns ended, undelivered calls withdrawn), while its streams and runs still exist for that to
 * find; the later steps then delete rows nothing is still working on. The threads themselves are deleted by a LATER step
 * (`agent_users.deleteAllForUserIdAsync`, through `deleteMessage`, which
 * drops file refcounts), so this walk still finds them.
 */
export const deleteUserThreadCascade = internalMutation
    .input({ cursor: v.optional(v.union(v.string(), v.null())), userId: v.string() })
    .output(v.object({ cursor: v.union(v.string(), v.null()), hasMore: v.boolean() }))
    .mutation(async ({ args: { cursor, userId }, ctx: context }) => {
        const threads = await context.db.threads.findMany({
            cursor: cursor ?? null,
            limit: THREAD_CASCADE_PAGE,
            orderBy: [{ _creationTime: "asc" }],
            where: { userId },
        });
        let revisit = false;

        const { now } = context;

        for (const thread of threads.page) {
            await endHostThread(context, thread, now);
            // Not `revisit ||= await …`: a short-circuit would skip the threads after the first full one.
            const threadFull = await eraseThreadSuggestionsAndInvites(context, thread._id);

            revisit ||= threadFull;
        }

        if (revisit) {
            return { cursor: cursor ?? null, hasMore: true };
        }

        return threads.isDone ? { cursor: null, hasMore: false } : { cursor: threads.continueCursor, hasMore: true };
    });

export const deleteUserDocuments = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await eraseDocumentsForUser(context, userId));

/** The user's presentations and their slides (`chat/gdpr.ts`). */
export const deleteUserPresentations = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await erasePresentationsForUser(context, userId));

// --- Non-thread-dependent deletions ---

/** The user's memories and their embeddings (`memory/gdpr.ts`). */
export const deleteUserMemories = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await eraseMemoriesForUser(context, userId));

/**
 * The chat files the user's projects hold, released while their grants still exist (`agent/gdpr.ts`). Runs before
 * `deleteUserIntegrations`, which erases the grants.
 */
export const deleteUserProjectImages = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await releaseProjectImagesForUser(context, userId));

/** One page of the user's projects with their rule files (`agent/gdpr.ts`). */
export const deleteUserProjects = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await eraseProjectsForUser(context, userId));

/** The user's chat-import jobs (`chat-import/gdpr.ts`). */
export const deleteUserImportJobs = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await eraseImportJobsForUser(context, userId));

/** Skills and everything they hang off, plus the user's own skill rows (`skills/gdpr.ts`). */
export const deleteUserSkills = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { userId }, ctx: context }) => {
        await eraseSkillsForUser(context, userId);

        return null;
    });

/** The user's plugin installs and their child links (`plugins/gdpr.ts`). The children are erased by their own steps. */
export const deleteUserPlugins = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await erasePluginsForUser(context, userId));

export const deleteUserConnectors = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { userId }, ctx: context }) => {
        // The connector rows (`connectors/gdpr.ts`).
        await eraseConnectorsForUser(context, userId);

        return null;
    });

/**
 * A stream per reply, and every chunk of it: the largest per-user history
 * here, so batched. Tool-approval snapshots go with them (`chat/gdpr.ts`).
 * Sub-agent runs go in their own step (`residual-deletion-steps.ts#deleteUserSubAgentRuns`).
 */
export const deleteUserPersistentStreams = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await erasePersistentStreamsForUser(context, userId));

export const deleteAuthRecords = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { userId }, ctx: context }) => {
        await deleteAccountsOf(context, userId);
        await deleteSessionsOf(context, userId);

        return null;
    });

// ── Browser data cleanup ────────────────────────────────────────────────

/** Browser sessions, their actions, extensions and the human-check asks, batched (`browser/gdpr.ts`). */
export const deleteUserBrowserData = internalMutation
    .input({ userId: v.string() })
    .output(vBatchResult)
    .mutation(async ({ args: { userId }, ctx: context }) => await eraseBrowserDataForUser(context, userId));

export { deleteParentsWithChildren } from "../batch";
