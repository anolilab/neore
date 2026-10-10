import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { callOnShard } from "../lib/cross-shard";
import { authAction, rateLimit } from "../lib/crpc";
import { grantOwnedChatFiles } from "../lib/storage-ownership";
import { ownedStorageRefsInUrlFields, storageKeysInUrlFields } from "../lib/stored-url-fields";
import { throwForbidden, throwNotFound } from "../lib/error-helpers";
import { MAX_LENGTH } from "../lib/validators";
import { findOwnedVaultRows, insertVaultCopies, rewriteStorageKeys, scheduleVaultObjectCopies, vVaultRowToCopy, type VaultRowToCopy } from "../vault/fork-copy";

/**
 * Fork a public workflow into the user's own workspace.
 *
 * An action, because a fork spans two shards (docs/plans/per-user-sharding.md):
 * the author's vault rows are read on THEIR shard, and the copy is written on the
 * forker's. `projects` and the chat-file tables are `.global()`, so only the vault
 * needs the hop.
 */
export const forkWorkflow = authAction
    .use(rateLimit("projects/create"))
    .input({
        sourceProjectId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ projectId: v.string() }))
    .action(async ({ args: { sourceProjectId }, ctx: context }): Promise<{ projectId: string }> => {
        const { userId } = context.user;
        const source = await context.runQuery(internal.workflow.fork.getForkSource, { sourceProjectId });

        assertForkable(source, userId);

        const authorId = source.userId;
        const vaultRows: VaultRowToCopy[] =
            authorId && authorId !== userId
                ? await callOnShard(internal.workflow.fork.getAuthorVaultRows, { authorId, sourceProjectId }, { shardKey: authorId })
                : [];

        const forked = await context.runMutation(internal.workflow.fork.completeFork, { sourceProjectId, userId, vaultRows });

        context.log.event("workflow.fork_workflow", { authorIsOther: authorId !== userId, vaultRowCount: vaultRows.length });

        return forked;
    });

/** Most forks one count reads. A source with more keeps this count at the cap. */
const MAX_COUNTED_FORKS = 10_000;

interface ForkSource {
    isPublic?: boolean;
    projectType?: string;
    userId?: string | null;
}

/** Who may fork what: the one rule both the action and the mutation enforce. */
function assertForkable(source: ForkSource | null, userId: string): asserts source is ForkSource {
    if (!source) {
        throwNotFound("Workflow");
    }

    if (source.projectType !== "workflow") {
        throw new LunoraError("BAD_REQUEST", "Project is not a workflow");
    }

    if (!source.isPublic && source.userId !== userId) {
        throwForbidden("Cannot fork a private workflow");
    }
}

/** The fields of the source a fork needs. The output is narrow: the source row also carries the share token. */
export const getForkSource = internalQuery
    .input({ sourceProjectId: v.string() })
    .output(v.union(v.null(), v.object({ isPublic: v.optional(v.boolean()), projectType: v.optional(v.string()), userId: v.optional(v.string()) })))
    .query(async ({ args, ctx }) => {
        const project = await ctx.db.projects.findFirst({ where: { _id: args.sourceProjectId as Id<"projects"> } });

        if (!project) {
            return null;
        }

        return { isPublic: project.isPublic, projectType: project.projectType, userId: project.userId ?? undefined };
    });

/** On the AUTHOR's shard: the vault rows the source graph names that the author owns and that may be copied. */
export const getAuthorVaultRows = internalQuery
    .input({ authorId: v.string(), sourceProjectId: v.string() })
    .output(v.array(vVaultRowToCopy))
    .query(async ({ args, ctx }) => {
        const source = await ctx.db.projects.findFirst({ where: { _id: args.sourceProjectId as Id<"projects"> } });

        if (!source || source.userId !== args.authorId) {
            return [];
        }

        return await findOwnedVaultRows(ctx.db, args.authorId, storageKeysInUrlFields(source.workflowContent));
    });

/** On the FORKER's shard: the fork itself. */
export const completeFork = internalMutation
    .input({ sourceProjectId: v.string(), userId: v.string(), vaultRows: v.array(vVaultRowToCopy) })
    .output(v.object({ projectId: v.string() }))
    .mutation(async ({ args: { sourceProjectId, userId, vaultRows }, ctx: context }) => {
        const source = await context.db.projects.findFirst({ where: { _id: sourceProjectId as Id<"projects"> } });

        assertForkable(source, userId);

        let { workflowContent } = source;
        let vaultCopies = new Map<string, string>();

        if (source.userId && source.userId !== userId) {
            // Only keys the author's graph names are granted or copied. The author's
            // chat files are granted; a vault file has one owner, so the forker gets a
            // copy of it. A key the author planted to someone else's file is neither.
            const keys = new Set(storageKeysInUrlFields(source.workflowContent));
            const granted = await grantOwnedChatFiles(context.db, source.userId, userId, keys);

            // A guest account gets its fork without the vault copies: a copy costs
            // storage, and guest accounts are free to create. The images are stripped.
            const forker = await context.db.user.findFirst({ where: { _id: userId as Id<"user"> } });
            const copyable = forker?.isAnonymous === true ? [] : vaultRows.filter((row) => keys.has(row.key) && !granted.has(row.key));

            vaultCopies = await insertVaultCopies(context.db, copyable, userId);
            workflowContent = rewriteStorageKeys(workflowContent, vaultCopies);
        }

        // Create the forked project
        const forkedProject = await context.runMutation(internal.agent.projects.createProject, {
            color: source.color ?? undefined,
            description: source.description ?? undefined,
            forkedFromId: sourceProjectId,
            icon: source.icon ?? "workflow",
            projectType: "workflow",
            title: `${source.title} (Fork)`,
            userId,
            workflowContent: await ownedStorageRefsInUrlFields(context, userId, workflowContent),
        });

        await scheduleVaultObjectCopies(context, vaultCopies);

        // The count is recomputed from the forks that exist, not incremented: an
        // increment reads the value first, so two racing forks can both write the same
        // number. Each fork recounts after its own insert, so the last recount runs
        // after every insert that finished before it. Capped at MAX_COUNTED_FORKS.
        if (source.isPublic) {
            const forks = await context.db.projects.findMany({ where: { forkedFromId: sourceProjectId }, limit: MAX_COUNTED_FORKS });

            await context.runMutation(internal.agent.projects.updateProject, {
                patch: {
                    galleryForkCount: forks.page.length,
                },
                projectId: sourceProjectId as Id<"projects">,
            });
        }

        return { projectId: forkedProject._id };
    });
