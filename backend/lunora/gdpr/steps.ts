import { LunoraError, v } from "lunorash/server";

import { buildUsageJson, spliceUsageJson, usageObjectKey } from "./usage-export-steps";
import { readStoredText } from "../lib/storage-read";
import {
    CHAT_FILE_METADATA_CHUNK,
    capChatFiles,
    chatFileMeter,
    chatFileSectionBudget,
    collectAllChatFileMetadata,
    grantRevisionsExportPageKey,
    readAllGrantRevisionPages,
    readChunkMetadata,
    collectAllMessageFileIds,
    textBytes,
    walkIds,
    withChatFiles,
} from "../agent/export-pages";
import { USAGE_EXPORT_BYTES } from "../usage/gdpr";
import { callOnShard } from "../lib/cross-shard";
import { SWEEP_CALL_BUDGET, SWEEP_ROUTES_PER_ACTION, sweepRoutePage } from "./owner-sweep";
import { collectOrganizationReplyPages } from "../usage/organization";
import { collectAcpSessionPages } from "../acp/gdpr";
import { BROWSER_EXPORT_BYTES, browserExportPageKey, readAllBrowserPages } from "../browser/export-pages";
import { collectAllFeedback } from "../feedback/gdpr";
import { collectAllTriggers } from "../triggers/export-pages";
import { attachProjectRuleFiles, collectAllOwnedProjects, collectAllRepositories } from "../projects/export-pages";
import {
    chatFilesReadBudget,
    feedbackReadBudget,
    projectDetailsReadBudget,
    repositoriesReadBudget,
    threadFollowsReadBudget,
    triggerReadBudget,
} from "./read-budget";
import { collectAllThreadFollows } from "../chat/follows/export-pages";
import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { gdprLogger } from "../lib/logger";
import { queueEmail } from "../email/mailer";
import { SITE_URL } from "../env";
import { withDependency } from "../lib/dependency";
import { storedPage, storedRows } from "../lib/stored-row";

/**
 * The organization ledger the export holds, in bytes. Past it the oldest rows are cut and the file says so (`organizationRepliesCut`), so
 * the rest of the export still succeeds.
 */
const ORGANIZATION_REPLY_EXPORT_BYTES = 4 * 1024 * 1024;

/** The stored usage object's keys and braces around its two arrays: a few dozen bytes, allowed for in the read limit. */
const USAGE_OBJECT_WRAPPER_BYTES = 1024;

const TRAILING_SLASH = /\/$/;

export const collectProfile = internalQuery
    .input({ userId: v.string() })
    .output(
        v.union(
            v.object({
                createdAt: v.number(),
                email: v.string(),
                emailVerified: v.boolean(),
                id: v.string(),
                image: v.string(),
                name: v.string(),
            }),
            v.null(),
        ),
    )
    .query(async ({ args: { userId }, ctx: context }) => {
        // Reads the better-auth user row directly by primary key. The better-auth
        // tables are ordinary `.global()` rows here, so no generated CRUD surface
        // is involved.
        const user = await context.db.user.findFirst({ where: { _id: userId as Id<"user"> } });

        if (!user) {
            return null;
        }

        return {
            createdAt: user._creationTime ?? 0,
            email: user.email ?? "",
            emailVerified: user.emailVerified ?? false,
            id: user._id ?? "",
            image: user.image ?? "",
            name: user.name ?? "",
        };
    });

export const collectSettings = internalQuery
    .input({ userId: v.string() })
    .output(
        v.object({
            aiUserPreferences: v.union(v.any(), v.null()),
            userSettings: v.union(v.any(), v.null()),
        }),
    )
    .query(async ({ args: { userId }, ctx: context }) => {
        const userSettings = await context.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first();

        const aiPreferences = await context.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first();

        return {
            aiUserPreferences: aiPreferences
                ? {
                      ...aiPreferences,
                      customAIProviders: undefined,
                      generalProviders: undefined,
                      mcpSecretHeaders: undefined,
                      messengerKeys: undefined,
                      providerApiKeys: undefined,
                  }
                : null,
            userSettings: userSettings || null,
        };
    });

/**
 * The message fields the GDPR export publishes. `createdAt` renames
 * `_creationTime`.
 *
 * `Pick`ed to the non-id fields, with `_id` as a plain `string`: these rows
 * arrive over `runQuery` from `listMessagesByThreadId`, whose output validator
 * declares ids as `v.string()`, so no branded `Id<…>` survives the wire. Picking
 * only what the projection reads keeps the field TYPES tied to the schema
 * without inheriting the brands the wire has already erased.
 */
/** `user` | `assistant` | `system` | `tool`, from the stored UI message; the row itself has no role column. */
const roleOf = (message: unknown): string | undefined => {
    const role = (message as { role?: unknown } | null | undefined)?.role;

    return typeof role === "string" ? role : undefined;
};

const projectMessage = (
    message: Pick<
        Doc<"messages">,
        "_creationTime" | "createdAt" | "message" | "model" | "order" | "parentMessageId" | "status" | "stepOrder" | "text" | "tool"
    > & { _id: string },
) => {
    return {
        _id: message._id,
        // The display time: an imported message keeps its source time there, and a re-import should keep it too.
        createdAt: message.createdAt ?? message._creationTime,
        model: message.model,
        order: message.order,
        // As stored, so `"root"` (a top-level sibling) stays distinct from an id that is simply missing.
        parentMessageId: message.parentMessageId,
        role: roleOf(message.message),
        status: message.status,
        stepOrder: message.stepOrder,
        text: message.text,
        tool: message.tool,
    };
};

/**
 * The thread fields the GDPR export publishes. `userTags` is `tagIds` resolved
 * to names — the ids alone mean nothing to the data subject.
 */
const projectThread = (
    thread: Pick<
        Doc<"threads">,
        | "_creationTime"
        | "activeLeafMessageId"
        | "archivedAt"
        | "category"
        | "lastViewedAt"
        | "model"
        | "snoozeChosenAt"
        | "snoozedUntil"
        | "summary"
        | "tagIds"
        | "tags"
        | "title"
        | "updatedAt"
    > & {
        _id: string;
    },
    tagNames: ReadonlyMap<string, string>,
) => {
    return {
        _id: thread._id,
        // Where the user last pointed the branch switcher. Unset for a thread that never branched. A re-import
        // uses it to keep only the replies the user kept, rather than every alternative (`parsers/neore.ts`).
        activeLeafMessageId: thread.activeLeafMessageId,
        // When the chat was last archived (set by any archive, kept on reopen). Unset for a chat never archived.
        archivedAt: thread.archivedAt,
        category: thread.category,
        createdAt: thread._creationTime,
        lastViewedAt: thread.lastViewedAt,
        model: thread.model,
        // When the owner last chose a snooze, or the thread last woke from one.
        snoozeChosenAt: thread.snoozeChosenAt,
        snoozedUntil: thread.snoozedUntil,
        summary: thread.summary,
        tags: thread.tags,
        title: thread.title,
        updatedAt: thread.updatedAt,
        userTags: (thread.tagIds ?? []).flatMap((id) => {
            const name = tagNames.get(id);

            return name === undefined ? [] : [name];
        }),
    };
};

/** The user's own thread tags (`threadTags`), exported as a list of their own. */
export const collectThreadTags = internalQuery
    .input({ userId: v.string() })
    .output(v.array(v.object({ _id: v.string(), color: v.string(), createdAt: v.number(), name: v.string(), order: v.number(), updatedAt: v.number() })))
    .query(async ({ args: { userId }, ctx: context }) => {
        const tags = await context.db
            .query("threadTags")
            .withIndex("by_user_and_order", (q) => q.eq("userId", userId))
            .collect();

        return tags.map((tag) => {
            return { _id: tag._id as string, color: tag.color, createdAt: tag.createdAt, name: tag.name, order: tag.order, updatedAt: tag.updatedAt };
        });
    });

/** Every row of a paged export read: the pages one after another until the last. */
const readAllPages = async <T>(readPage: (cursor: string | null) => Promise<{ continueCursor: string | null; isDone: boolean; page: T[] }>): Promise<T[]> => {
    const rows: T[] = [];
    let cursor: string | null = null;

    for (;;) {
        const result = await readPage(cursor);

        rows.push(...result.page);

        if (result.isDone) {
            return rows;
        }

        cursor = result.continueCursor;
    }
};

export const collectConversations = internalAction.input({ userId: v.string() }).action(async ({ args: { userId }, ctx: context }) => {
    // OPTIMIZED: Use paginated approach to handle large datasets safely
    // Process threads in batches to prevent memory exhaustion and timeouts
    // Written structurally rather than as `ReturnType<typeof projectMessage>`:
    // this type flows into the exported action signature, and codegen inlines
    // such references into `_generated/api.ts` WITHOUT importing the names, so
    // the generated file failed to compile with `Cannot find name
    // 'projectMessage'`. The schema-derivation that
    // matters lives on the projections' PARAMETERS, which is what makes
    // `thread.summaryTYPO` an error; this annotation only has to describe the
    // wire shape.
    const conversations: {
        /** The condensed copies of the thread's older turns made while it sat idle (`agent/thread-summaries.ts`). */
        contextSummaries: { coveredCount: number; coveredUpToMessageId: string; createdAt: number; kind?: "compact"; summary: string }[];
        /** The thread's guest links, with or without notes: when each was made and when it lapses. */
        guestLinks: { createdAt: number; expiresAt: number }[];
        /** The notes strangers left through the thread's guest link, held and sent (`chat/guest-links.ts`). */
        guestNotes: { createdAt: number; status: string; text: string }[];
        messages: {
            _id: string;
            createdAt: number;
            model?: string;
            order?: number;
            parentMessageId?: string;
            role?: string;
            status?: string;
            stepOrder?: number;
            text?: string;
            tool?: boolean;
        }[];
        /** The owner's own pins on the thread: what each pins, the note on it and the text it quotes (`chat/pins/functions.ts`). */
        pins: {
            _id: string;
            createdAt: number;
            documentId?: string;
            documentKind?: string;
            imageIndex?: number;
            imageKey?: string;
            kind?: "document" | "image" | "message";
            messageId?: string;
            messageRole: string;
            note?: string;
            selectedText?: string;
            updatedAt: number;
        }[];
        thread: {
            _id: string;
            activeLeafMessageId?: string;
            category?: string;
            createdAt: number;
            model?: string;
            summary?: string;
            tags?: string[];
            title?: string;
            updatedAt?: number;
            userTags: string[];
        };
    }[] = [];

    const threadTags = await context.runQuery(internal.gdpr.steps.collectThreadTags, { userId });
    const tagNames = new Map(threadTags.map((tag) => [tag._id, tag.name]));

    let threadCursor: string | null = null;
    let hasMoreThreads = true;
    const THREAD_BATCH_SIZE = 100; // Process 100 threads at a time
    const MESSAGE_PAGE_SIZE = 500;

    while (hasMoreThreads) {
        // The INTERNAL twins: this step runs inside a workflow with no user
        // identity, and the public queries answer an identity-less caller with an
        // empty page — which is how exports shipped with no conversations at all.
        const threads: any = await context.runQuery(internal.agent.threads.listThreadsByUserIdInternal, {
            paginationOpts: { cursor: threadCursor, numItems: THREAD_BATCH_SIZE },
            status: undefined,
            userId,
        });

        // Process current batch of threads
        for (const listed of threads.page) {
            let collected: Omit<(typeof conversations)[number], "guestLinks" | "guestNotes" | "pins"> | undefined;

            try {
                // A locked chat is listed as its stub (no title, no model, no tags). The export
                // is the owner's own data-access right, not a view into the chat, so it reads the
                // full row and every message, without the proof. The list and every client read stay
                // guarded. Decided in the GDPR open questions (plan note, export section).
                const thread = listed.lockedAt
                    ? await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: listed._id as Id<"threads"> })
                    : listed;

                if (!thread) {
                    continue;
                }

                // Every message, page by page: an Art. 15/20 export has no business
                // truncating a long thread.
                const messages: (typeof conversations)[number]["messages"] = [];
                let messageCursor: string | null = null;
                let hasMoreMessages = true;

                while (hasMoreMessages) {
                    // Annotated: the loop feeds `messageCursor` back into the call, which
                    // otherwise makes the inferred type circular. The ADMITTED reader: no lock check,
                    // because the export is the owner's own data (see the comment above).
                    const result: { continueCursor: string | null; isDone: boolean; page: Parameters<typeof projectMessage>[0][] } = await context.runQuery(
                        internal.agent.messages.listMessagesByThreadIdAdmitted,
                        {
                            order: "asc",
                            paginationOpts: { cursor: messageCursor, numItems: MESSAGE_PAGE_SIZE },
                            threadId: thread._id as Id<"threads">,
                        },
                    );

                    for (const message of result.page) {
                        messages.push(projectMessage(message));
                    }

                    hasMoreMessages = !result.isDone && result.page.length > 0;
                    messageCursor = result.continueCursor;
                }

                const contextSummaries = await context.runQuery(internal.agent.thread_summaries.listThreadSummariesForExport, {
                    threadId: thread._id as Id<"threads">,
                });

                collected = { contextSummaries, messages, thread: projectThread(thread, tagNames) };
            } catch (error) {
                gdprLogger.error(`Failed to collect messages for thread ${listed._id}:`, error);
            }

            // Outside the catch above: a failed guest-link or guest-note read fails this export step (the workflow retries it), instead of
            // shipping an export that silently lacks the notes of a thread it did collect.
            if (collected) {
                const threadId = listed._id as Id<"threads">;
                const guestLinks = await readAllPages(
                    async (cursor) => await context.runQuery(internal.chat.guest_links.listGuestLinksForExport, { cursor, threadId }),
                );
                // A link goes only once its notes have (`deleteGuestLink`), so a thread with no links has no notes to read.
                const guestNotes =
                    guestLinks.length === 0
                        ? []
                        : await readAllPages(async (cursor) => await context.runQuery(internal.chat.guest_links.listGuestNotesForExport, { cursor, threadId }));

                // The owner's pins, read by the owner's id: a pin someone else made on a shared thread is theirs to export.
                const pins = await readAllPages(
                    async (cursor) => await context.runQuery(internal.chat.pins.functions.listPinsForExport, { cursor, threadId, userId }),
                );

                conversations.push({ ...collected, guestLinks, guestNotes, pins });
            }
        }

        // Check if there are more threads to process
        hasMoreThreads = !threads.isDone;
        threadCursor = threads.continueCursor;

        // Optional: Add progress logging for long exports
        if (hasMoreThreads) {
            gdprLogger.info(`GDPR export progress: Processed ${conversations.length} threads so far...`);
        }
    }

    gdprLogger.info(`GDPR export complete: Collected ${conversations.length} total threads`);

    return conversations;
});

/**
 * The pins the caller made on threads other people shared with them. Such a thread and its pins live on its owner's shard, so the
 * pins are read there, page by page, by the caller's own id. A thread's pins that the caller made nothing on are left out.
 */
export const collectSharedPins = internalAction.input({ userId: v.string() }).action(async ({ args: { userId }, ctx: context }) => {
    const routes = await readAllPages(async (cursor) => await context.runQuery(internal.chat.pins.functions.listSharedPinRoutesForExport, { cursor, userId }));
    const shared: { pins: unknown[]; threadId: string; unreadable?: true }[] = [];

    const seen = new Set<string>();

    for (const route of routes) {
        // A thread is read once, even if two routes name it (a replica can miss the first insert).
        if (seen.has(route.threadId)) {
            continue;
        }

        seen.add(route.threadId);

        let pins: unknown[];

        try {
            pins = await readAllPages(
                async (cursor) =>
                    await callOnShard(
                        internal.chat.pins.functions.listPinsForExport,
                        { cursor, threadId: route.threadId as Id<"threads">, userId },
                        { shardKey: route.ownerId },
                    ),
            );
        } catch (error) {
            // One owner's shard that cannot be read (an unreachable shard, a thread removed mid-read) must not fail the whole export:
            // the thread is listed as unreadable, so the file says its pins were not included rather than dropping them silently.
            gdprLogger.error(`Failed to read shared pins for thread ${route.threadId}:`, error);
            shared.push({ pins: [], threadId: route.threadId, unreadable: true });
            continue;
        }

        if (pins.length > 0) {
            shared.push({ pins, threadId: route.threadId });
        }
    }

    return shared;
});

/**
 * Erases the caller's pins on the threads other people own, from each owner's shard, before the routes that find them are removed
 * (`gdpr/workflows/deletion-workflow.ts`). A collaborator's pins are written on the owner's shard, so the caller's own shard holds none.
 *
 * One bounded page of routes per call, within `SWEEP_CALL_BUDGET` shard calls (`gdpr/owner-sweep.ts`). When the budget runs out inside
 * a route, the call returns that route as `resume` with the same page `cursor`, and the next call starts there. A page is only left
 * behind once every route on it is done, so the cursor is always a safe resume point.
 */
export const erasePinsOnOwnerShards = internalAction
    .input({
        cursor: v.union(v.string(), v.null()),
        resume: v.union(v.object({ ownerId: v.string(), threadId: v.string() }), v.null()),
        userId: v.string(),
    })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            hasMore: v.boolean(),
            owners: v.array(v.string()),
            resume: v.union(v.object({ ownerId: v.string(), threadId: v.string() }), v.null()),
            routes: v.number(),
        }),
    )
    .action(async ({ args: { cursor, resume, userId }, ctx: context }) => {
        const result = await context.runQuery(internal.chat.pins.functions.listSharedPinRoutesForExport, {
            cursor,
            limit: SWEEP_ROUTES_PER_ACTION,
            userId,
        });

        // Resumes at the route it stopped at. A route no longer on the page was removed since (a refused write took it back), so the page
        // is swept from its start: every route on it is idempotent to sweep again.
        const found = resume === null ? -1 : result.page.findIndex((route) => route.threadId === resume.threadId && route.ownerId === resume.ownerId);

        // Each owner shard is fenced before it is swept, and stays fenced until the routes are gone (`releasePinFences`): a pin write of
        // this account on that shard is refused in its own transaction for the whole erasure, so nothing it commits can escape the sweep.
        // The read above is one call of the budget, so the sweep gets the rest.
        const { owners, unfinished } = await sweepRoutePage(
            result.page,
            {
                eraseBatch: async (route) =>
                    await callOnShard(
                        internal.chat.pins.functions.eraseUserPinsOnThread,
                        { threadId: route.threadId as Id<"threads">, userId },
                        { shardKey: route.ownerId },
                    ),
                fence: async (ownerId) => {
                    await callOnShard(internal.lib.account_moves.fencePinsOnShardFor, { userId }, { shardKey: ownerId });
                },
            },
            { budget: SWEEP_CALL_BUDGET - 1, start: Math.max(0, found) },
        );

        if (unfinished !== null) {
            return { cursor, hasMore: true, owners, resume: { ownerId: unfinished.ownerId, threadId: unfinished.threadId }, routes: result.page.length };
        }

        return { cursor: result.continueCursor, hasMore: !result.isDone, owners, resume: null, routes: result.page.length };
    });

/**
 * Lifts the erasure's fences on the owner shards (`gdpr/workflows/deletion-workflow.ts`), before the routes are drained: the owners are
 * read from those routes, so a fresh instance could not find them afterwards. A pin write is still refused once lifted, since the erasing
 * marker is live until the erasure ends. The workflow calls it in batches of owners.
 */
export const releasePinFences = internalAction
    .input({ owners: v.array(v.string()), userId: v.string() })
    .output(v.null())
    .action(async ({ args: { owners, userId } }) => {
        for (const ownerId of owners) {
            await callOnShard(internal.lib.account_moves.unfencePinsOnShardFor, { userId }, { shardKey: ownerId });
        }

        return null;
    });

export const collectFiles = internalQuery
    .input({ userId: v.string() })
    .output(
        v.object({
            files: v.array(
                v.object({
                    _id: v.id("files"),
                    createdAt: v.number(),
                    name: v.string(),
                    size: v.number(),
                    tags: v.optional(v.array(v.string())),
                    type: v.string(),
                    updatedAt: v.number(),
                }),
            ),
            folders: v.array(
                v.object({
                    _id: v.id("folders"),
                    createdAt: v.number(),
                    name: v.string(),
                    updatedAt: v.number(),
                }),
            ),
            // Saved site logins (`vault/site-logins.ts`): the site, the username and which teammates may use each; the
            // secret stays out.
            siteLogins: v.array(
                v.object({
                    createdAt: v.number(),
                    label: v.optional(v.string()),
                    signInUrl: v.optional(v.string()),
                    site: v.string(),
                    teammateIds: v.array(v.id("bots")),
                    updatedAt: v.number(),
                    username: v.string(),
                }),
            ),
        }),
    )
    .query(async ({ args: { userId }, ctx: context }) => {
        const files = await context.db
            .query("files")
            .withIndex("by_user_and_folder", (q) => q.eq("userId", userId))
            .collect();

        const folders = await context.db
            .query("folders")
            .withIndex("by_user_and_parent", (q) => q.eq("userId", userId))
            .collect();

        const siteLogins = await context.db
            .query("savedSiteLogins")
            .withIndex("by_userId_origin", (q) => q.eq("userId", userId))
            .collect();

        return {
            files: files.map((f) => {
                return {
                    _id: f._id,
                    createdAt: f.createdAt ?? f._creationTime,
                    name: f.name,
                    size: f.size,
                    tags: f.tags,
                    type: f.type,
                    updatedAt: f.updatedAt ?? f._creationTime,
                };
            }),
            folders: folders.map((f) => {
                return {
                    _id: f._id,
                    createdAt: f.createdAt,
                    name: f.name,
                    updatedAt: f.updatedAt,
                };
            }),
            siteLogins: siteLogins.map((login) => {
                return {
                    createdAt: login.createdAt,
                    label: login.label,
                    signInUrl: login.signInUrl,
                    site: login.origin,
                    teammateIds: login.teammateIds ?? [],
                    updatedAt: login.updatedAt,
                    username: login.username,
                };
            }),
        };
    });

/** Rows of each activity table in the export. Past this the export says so rather than growing without bound. */
const EXPORT_ACTIVITY_CAP = 5000;

/** The export JSON is built whole in memory before it is stored; this is the largest one we will write. */
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

/** The share of the export trigger run history may take; past it, the oldest runs are left out and marked as cut. */
const TRIGGER_EXPORT_BYTES = 8 * 1024 * 1024;

/** The share of the export the projects' legacy `context` texts may take; past it, a project's is left out and marked. */
const PROJECT_CONTEXT_EXPORT_BYTES = 8 * 1024 * 1024;

/**
 * Sub-agent delegations (their task text and results) and knowledge
 * collections — user data the export used to leave out. The usage rollup is
 * read a page at a time by the export workflow's usage steps and `prepareUsageForExport`, not here.
 */
export const collectActivityForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ knowledgeCollections: v.array(v.any()), subAgentRuns: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx: context }) => {
        const [subAgentRuns, { page: collections }] = await Promise.all([
            context.db
                .query("subAgentRuns")
                .withIndex("by_user_and_createdAt", (q) => q.eq("userId", userId))
                .take(EXPORT_ACTIVITY_CAP),
            context.db.knowledgeCollections.findMany({ where: { userId } }),
        ]);

        return {
            knowledgeCollections: collections.map((collection) => {
                return {
                    createdAt: collection.createdAt,
                    description: collection.description,
                    id: collection._id,
                    name: collection.name,
                    sharedWithOrganization: collection.organizationId ?? null,
                    updatedAt: collection.updatedAt,
                };
            }),
            subAgentRuns: subAgentRuns.map((run) => {
                return {
                    childThreadId: run.childThreadId,
                    completedAt: run.completedAt,
                    createdAt: run.createdAt,
                    error: run.error,
                    id: run._id,
                    parentThreadId: run.parentThreadId,
                    result: run.result,
                    role: run.role,
                    skillSlug: run.skillSlug,
                    status: run.status,
                    task: run.task,
                };
            }),
        };
    });

export const collectPrompts = internalQuery.input({ userId: v.string() }).query(async ({ args: { userId }, ctx: context }) => {
    // `prompts` / `promptHistory` are `.global()` (D1): ORM facade, no legacy
    // reader. Unlimited `findMany` returns every matching row. Order mirrors the
    // old `by_user_and_favorite` walk and the old full-table scan.
    const { page: prompts } = storedPage(
        await context.db.prompts.findMany({
            orderBy: [{ isFavorite: "asc" }, { _creationTime: "asc" }],
            where: { userId },
        }),
    );

    // History of the user's prompts only — filtered in the query rather than by
    // scanning every user's history rows.
    const relevantHistory =
        prompts.length === 0
            ? []
            : await context.db.promptHistory
                  .findMany({ orderBy: [{ _creationTime: "asc" }], where: { promptId: { in: prompts.map((p) => p._id) } } })
                  .then((result) => storedRows(result.page));

    return {
        promptHistory: relevantHistory.map((h) => {
            return {
                _id: h._id,
                changeType: h.changeType,
                content: h.content,
                createdAt: h.createdAt,
                promptId: h.promptId,
                version: h.version,
            };
        }),
        prompts: prompts.map((p) => {
            return {
                _id: p._id,
                content: p.content,
                createdAt: p._creationTime,
                description: p.description,
                isFavorite: p.isFavorite,
                lastUsedAt: p.lastUsedAt,
                name: p.name,
                tags: p.tags,
                updatedAt: p.updatedAt,
                usageCount: p.usageCount,
            };
        }),
    };
});

export const generateExportFile = internalAction
    .input({
        // Coding-agent sessions on paired devices (`acp/gdpr.ts`). Read here, a page at a
        // time, unless a workflow already in flight passes them.
        acpSessions: v.optional(v.any()),
        // Sub-agent runs and knowledge collections (`collectActivityForExport`).
        // Optional for the same in-flight-replay reason as `threadTags`.
        activity: v.optional(v.any()),
        // Bots, their persona and computer settings (`bots/gdpr.ts`). Optional for
        // the same in-flight-replay reason as `threadTags`.
        bots: v.optional(v.any()),
        // The workflow stopped at `BROWSER_EXPORT_PAGES` with history left: the section is marked as cut.
        browserCut: v.optional(v.boolean()),
        // How many browser pages the workflow stored under `browserPrefix` (`browser/export-pages.ts`), read here. Optional for
        // the same in-flight-replay reason as `threadTags`.
        browserPages: v.optional(v.number()),
        browserPrefix: v.optional(v.string()),
        // Coding-agent runs (`coding-agents/gdpr.ts`). Optional for the same
        // in-flight-replay reason as `threadTags`.
        codingAgentRuns: v.optional(v.any()),
        conversations: v.any(),
        // Paired devices and their call audit (`devices/gdpr.ts`). Optional for
        // the same in-flight-replay reason as `threadTags`.
        devices: v.optional(v.any()),
        // Eval datasets, cases, runs and results (`evals/gdpr.ts`). Optional for
        // the same in-flight-replay reason as `threadTags`.
        evals: v.optional(v.any()),
        files: v.any(),
        // How many grant-revision pages the workflow stored under `browserPrefix` (`agent/export-pages.ts`), every one of them,
        // read here. Optional for the same in-flight-replay reason as `threadTags`: absent is no page.
        grantRevisionPages: v.optional(v.number()),
        // The owner's Events log: their run and approval events (`public-api/gdpr.ts`). Optional for the same reason.
        mcpEvents: v.optional(v.any()),
        // Memories (superseded history included) and reflection digests
        // (`memory/gdpr.ts`). Optional for the same in-flight-replay reason as `threadTags`.
        memories: v.optional(v.any()),
        // Notifications and push subscriptions (`notifications/gdpr.ts`). Optional
        // for the same in-flight-replay reason as `threadTags`.
        notifications: v.optional(v.any()),
        // Pages, their comments and grants (`pages/gdpr.ts`). Optional for the
        // same in-flight-replay reason as `threadTags`.
        pages: v.optional(v.any()),
        profile: v.any(),
        prompts: v.any(),
        // AI guides of pull requests (`source-control/gdpr.ts`). Optional for the same in-flight-replay reason.
        pullRequestGuides: v.optional(v.any()),
        // The links between threads and pull requests (`source-control/gdpr.ts`). Optional for the same reason.
        pullRequestThreads: v.optional(v.any()),
        // `requestId` is new. Lunora's `storage.store` takes the object key, and
        // keying the export by its request id makes the blob traceable back to the
        // row that produced it — otherwise a stray object in the bucket is
        // unattributable, which is a poor property for a GDPR artefact.
        requestId: v.id("gdprRequests"),
        // Review drafts on pull requests (`source-control/gdpr.ts`). Optional for
        // the same in-flight-replay reason as `threadTags`.
        reviewDrafts: v.optional(v.any()),
        // The outbound run webhook's URL and switch, never its secret (`run-webhooks/gdpr.ts`). Optional for the same reason.
        runWebhooks: v.optional(v.any()),
        settings: v.any(),
        // The pins the caller made on threads shared with them, read from each owner's shard (`collectSharedPins`). Optional for
        // the same in-flight-replay reason as `threadTags`.
        sharedThreadPins: v.optional(v.any()),
        // Goals and tasks with their run history (`tasks/gdpr.ts`). Optional for
        // the same in-flight-replay reason as `threadTags`.
        tasks: v.optional(v.any()),
        // Optional so an export workflow already in flight when this shipped
        // still replays against the new signature.
        threadTags: v.optional(v.any()),
        // The usage JSON `prepareUsageForExport` stored (its object key). Absent for an export that started before the usage
        // pieces existed, whose usage came in `activity`.
        usageKey: v.optional(v.string()),
        userEmail: v.string(),
        userId: v.string(),
        // The user's watched repositories (`source-control/gdpr.ts`). Optional for the same in-flight-replay reason.
        watchedRepositories: v.optional(v.any()),
    })
    .action(async ({ args, ctx: context }) => {
        const activity = args.activity as { knowledgeCollections?: unknown[]; subAgentRuns?: unknown[]; usageDaily?: unknown[] } | undefined;
        // The usage JSON, already read and checked by `prepareUsageForExport` in its own action: the usage rows and the organization ledger.
        // It is spliced into the file as text, so this action does not read it against its own budget.
        const usageJson =
            args.usageKey === undefined
                ? undefined
                : await readStoredText(context.storage, args.usageKey, {
                      maxBytes: USAGE_EXPORT_BYTES + ORGANIZATION_REPLY_EXPORT_BYTES + USAGE_OBJECT_WRAPPER_BYTES,
                  });
        // Read here, a page per query, so no workflow step result or action argument carries the history.
        const acpSessions =
            args.acpSessions ??
            (await collectAcpSessionPages(
                async (cursor) => await context.runQuery(internal.acp.gdpr.collectAcpSessionsForExport, { cursor, userId: args.userId }),
                MAX_EXPORT_BYTES,
            ));
        // The project repositories share the action's read budget with the ACP sessions. Their rows cannot be cut short,
        // so a set too large for what is left fails with PAYLOAD_TOO_LARGE (a floor keeps a small set exportable even past
        // the ACP sessions); their projects' details past the budget are marked as left out. The trigger history, which
        // is cut oldest first, reads only from what is left after both.
        const readBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
        const earlierReadBytes = readBytes(acpSessions);
        // The user's repository rows with their projects' details (`projects/gdpr.ts`), read here a page per query.
        const repositories = await collectAllRepositories(
            async (cursor) => await context.runQuery(internal.projects.gdpr.collectProjectRepositoriesForExport, { cursor, userId: args.userId }),
            async (projectIds) =>
                await context.runQuery(internal.projects.gdpr.collectProjectDetailsForExport, {
                    projectIds: projectIds as Id<"projects">[],
                    userId: args.userId,
                }),
            repositoriesReadBudget(earlierReadBytes),
            // The rows have a floor, the details none: past what the ACP sessions left they are marked as left out.
            projectDetailsReadBudget(earlierReadBytes),
        );
        const projectRepositories = { projectRepositories: repositories.projectRepositories };
        // What the user sent through "Send feedback", read here a page per query within what the sections above left.
        const feedback = await collectAllFeedback(
            async (cursor) => await context.runQuery(internal.feedback.gdpr.collectFeedbackForExport, { cursor, userId: args.userId }),
            feedbackReadBudget(earlierReadBytes + repositories.readBytes),
        );
        // Every project the user owns, the ones without a repository too: an owner's computer and folder are their data.
        // It shares the read budget left after the repositories and the feedback; no floor, so past it a project loses its details (marked) and is never left out.
        const ownedProjects = await collectAllOwnedProjects(
            async (cursor) => await context.runQuery(internal.projects.gdpr.collectOwnedProjectsForExport, { cursor, userId: args.userId }),
            projectDetailsReadBudget(earlierReadBytes + repositories.readBytes + feedback.readBytes),
        );
        // The user's follow states, a page per query within what the sections above left; past it marked as cut.
        const threadFollows = await collectAllThreadFollows(
            async (cursor) => await context.runQuery(internal.chat.follows.functions.collectThreadFollowsForExport, { cursor, userId: args.userId }),
            threadFollowsReadBudget(earlierReadBytes + repositories.readBytes + feedback.readBytes + ownedProjects.readBytes),
        );
        // The projects read for their details count too: a row is read whole, however little of it is exported.
        const triggerReadBytes = triggerReadBudget(
            earlierReadBytes + repositories.readBytes + feedback.readBytes + ownedProjects.readBytes + threadFollows.readBytes,
        );
        // Triggers with their settings and their newest runs, read here within a byte budget (`triggers/gdpr.ts`).
        const triggers = await collectAllTriggers(
            async (cursor) => await context.runQuery(internal.triggers.gdpr.collectTriggersForExport, { cursor, userId: args.userId }),
            async (triggerId, cursor) =>
                await context.runQuery(internal.triggers.gdpr.collectTriggerRunsForExport, {
                    cursor,
                    triggerId: triggerId as Id<"triggers">,
                    userId: args.userId,
                }),
            TRIGGER_EXPORT_BYTES,
            triggerReadBytes,
        );
        // The projects' rule files, read last within what everything above leaves, counting what the triggers actually read.
        const ownedWithRules = await attachProjectRuleFiles(
            // Each is an object `collectOwnedProjectsForExport` returned.
            ownedProjects.projects as object[],
            ownedProjects.contexts,
            async (projectIds) =>
                await context.runQuery(internal.projects.gdpr.collectProjectRuleFilesForExport, {
                    // The ids of the owned projects' pages; the query re-checks each is still this user's before reading its rules.
                    projectIds: projectIds as Id<"projects">[],
                    userId: args.userId,
                }),
            projectDetailsReadBudget(
                earlierReadBytes + repositories.readBytes + feedback.readBytes + ownedProjects.readBytes + threadFollows.readBytes + triggers.readBytes,
            ),
            PROJECT_CONTEXT_EXPORT_BYTES,
        );
        // The browser pages, read from their objects, so neither this action's arguments nor its read budget carry them.
        // Held to its share of the file: past it the section is cut and says so, and the rest of the export is written.
        const { browserCut, browserPages, browserPrefix } = args;
        const grantRevisionPages = args.grantRevisionPages ?? 0;

        // The revisions of the grants the user held, every page the workflow stored under the run's prefix (`agent/export-pages.ts`),
        // read from their objects: none is cut, and neither this action's arguments nor its read budget carry them.
        // A count of pages with nowhere to read them from fails the export rather than writing it without them.
        if (browserPrefix === undefined && grantRevisionPages > 0) {
            throw new Error("The grant revisions' pages were stored without a prefix to read them from");
        }

        const grantRevisions =
            browserPrefix === undefined
                ? { revisions: [] }
                : await readAllGrantRevisionPages(
                      async (page) => await readStoredText(context.storage, grantRevisionsExportPageKey(browserPrefix, page), { maxBytes: MAX_EXPORT_BYTES }),
                      grantRevisionPages,
                  );
        const browser =
            browserPrefix === undefined || browserPages === undefined
                ? { actions: [], extensions: [], humanChecks: [], sessions: [] }
                : await readAllBrowserPages(
                      async (page) => await readStoredText(context.storage, browserExportPageKey(browserPrefix, page), { maxBytes: MAX_EXPORT_BYTES }),
                      browserPages,
                      BROWSER_EXPORT_BYTES,
                      browserCut === true,
                  );
        // The user's chat files (uploads and generated images), metadata only: the files behind their grants and the files their messages
        // name (`agent/export-pages.ts`), read here a page per query, as the sections above are. The walks and the metadata reads share
        // one budget of bytes and queries, what every section above left of the action's read budget (`read-budget.ts`); past it the
        // section is cut and flagged. The grants' metadata is read before the message walk, so a long history cannot leave them out.
        const chatFileRead = await collectAllChatFileMetadata(
            async (meter) =>
                await walkIds(
                    async (cursor) => await context.runQuery(internal.agent.gdpr.collectGrantedChatFileIdsForExport, { cursor, userId: args.userId }),
                    meter,
                ),
            async (meter) =>
                await collectAllMessageFileIds(
                    async (cursor) => await context.runQuery(internal.agent.gdpr.collectThreadIdsForExport, { cursor, userId: args.userId }),
                    async (threadId, cursor) =>
                        await context.runQuery(internal.agent.gdpr.collectMessageFileIdsForExport, { cursor, threadId: threadId as Id<"threads"> }),
                    meter,
                ),
            // A file with no metadata row (stored before it was written) is repaired here, from its file row (`agent/gdpr.ts`).
            async (fileIds, bytesLeft, queriesLeft) =>
                await readChunkMetadata(
                    fileIds,
                    bytesLeft,
                    queriesLeft,
                    async (ids) => await context.runQuery(internal.agent.gdpr.chatFileMetadataForExport, { fileIds: ids as Id<"chatFiles">[] }),
                    // One file per repair mutation (`readChunkMetadata`): each reads its file row whole.
                    async (id) => await context.runMutation(internal.agent.gdpr.repairChatFileMetadataForExport, { fileIds: [id as Id<"chatFiles">] }),
                ),
            CHAT_FILE_METADATA_CHUNK,
            chatFileMeter(
                chatFilesReadBudget(
                    earlierReadBytes +
                        repositories.readBytes +
                        feedback.readBytes +
                        ownedProjects.readBytes +
                        threadFollows.readBytes +
                        triggers.readBytes +
                        ownedWithRules.readBytes,
                ),
            ),
        );
        const exportData = {
            acpSessions,
            bots: args.bots ?? { bots: [] },
            browser,
            codingAgentRuns: args.codingAgentRuns ?? [],
            conversations: args.conversations,
            dataSubject: {
                email: args.userEmail,
                id: args.userId,
            },
            devices: args.devices ?? { calls: [], devices: [] },
            evals: args.evals ?? { datasets: [] },
            exportDate: new Date().toISOString(),
            exportVersion: "1.0",
            feedback: feedback.section,
            files: args.files,
            grantRevisions,
            knowledgeCollections: activity?.knowledgeCollections ?? [],
            mcpEvents: args.mcpEvents ?? { events: [] },
            memories: args.memories ?? { digests: [], memories: [] },
            notifications: args.notifications ?? { notifications: [], pushSubscriptions: [] },
            pages: args.pages ?? { comments: [], favorites: [], grants: [], pages: [] },
            profile: args.profile,
            projectRepositories,
            projects: ownedWithRules.projects,
            prompts: args.prompts,
            pullRequestGuides: args.pullRequestGuides ?? { guides: [] },
            pullRequestThreads: args.pullRequestThreads ?? { links: [] },
            reviewDrafts: args.reviewDrafts ?? { drafts: [] },
            runWebhooks: args.runWebhooks ?? { runWebhooks: [] },
            settings: args.settings,
            sharedThreadPins: args.sharedThreadPins ?? [],
            subAgentRuns: activity?.subAgentRuns ?? [],
            tasks: args.tasks ?? { goals: [], tasks: [] },
            threadFollows: threadFollows.section,
            threadTags: args.threadTags ?? [],
            triggers: { triggers: triggers.triggers },
            // An export from before the usage pieces existed carries its rows in `activity`, and no ledger; otherwise the usage JSON is spliced
            // in below, with the ledger.
            ...(usageJson === undefined && { organizationReplies: [], organizationRepliesCut: false, usageDaily: activity?.usageDaily ?? [] }),
            // A usage JSON stored before the ledger was in it holds the rows alone: the ledger is then empty, and nothing was cut.
            ...(usageJson?.startsWith("[") && { organizationReplies: [], organizationRepliesCut: false }),
            watchedRepositories: args.watchedRepositories ?? { watched: [] },
        };

        // The rest of the export, serialized without the chat-file section. The section takes what the rest leaves under the file's size
        // limit (usage JSON included, as it is spliced in), so the file is never written past it: a large history is cut and flagged.
        const rest = JSON.stringify(exportData, null, 2);
        const restBytes = textBytes(rest) + (usageJson === undefined ? 0 : textBytes(usageJson));
        const chatFileCapped = capChatFiles(chatFileRead.rows, chatFileSectionBudget(restBytes, MAX_EXPORT_BYTES));
        // Cut by the byte cap, by the file's size limit or by the read budget: each way the section says so.
        const chatFiles = { files: chatFileCapped.files, truncated: chatFileCapped.truncated || chatFileRead.truncated };
        const head = withChatFiles(rest, chatFiles);
        // The usage JSON is written as the file's last keys rather than parsed and serialized again.
        const jsonString = usageJson === undefined ? head : spliceUsageJson(head, usageJson);
        const blob = new Blob([jsonString], { type: "application/json" });

        // Lunora's `store(key, body, options?)` takes the key; a store that mints
        // its own key would leave the object unattributable. Keyed by request id, which is unique per export and makes the
        // object traceable back to the row that produced it — a stray blob in the
        // bucket is otherwise unattributable.
        const key = `gdpr-exports/${args.requestId}.json`;

        // The export is built in memory, so cap it: a user with an extreme history
        // fails here with a clear error instead of exhausting the Worker's memory.
        await withDependency("file storage", () =>
            context.storage.store(key, blob, {
                allowedContentTypes: ["application/json"],
                contentType: "application/json",
                maxSize: MAX_EXPORT_BYTES,
            }),
        );

        return key;
    });

/**
 * The user's usage history for the export, read from the run's pieces and stored as a JSON array (`usage-export-steps.ts`).
 * It has its own action so that its reads use their own read budget, apart from the coding-agent sessions' read. A membership
 * revoked since a title was read is checked here, from the primary, before the title is named.
 */
export const prepareUsageForExport = internalAction
    .input({ pass: v.number(), requestId: v.string(), userId: v.string() })
    // `null` when the usage is larger than its share of the file. The size check runs here, where the error is raised, and
    // the result crosses the action boundary as a value, not as a thrown error that loses its class.
    .output(v.union(v.string(), v.null()))
    .action(async ({ args: { pass, requestId, userId }, ctx: context }) => {
        const text = await buildUsageJson(
            async (kind, cursor) =>
                (await context.runQuery(internal.usage.gdpr.readUsageExportPieces, { cursor, kind, pass, requestId, userId })) as {
                    cursor: string | null;
                    payloads: string[];
                },
            async (organizationIds) => (await context.runQuery(internal.usage.activity.stillMemberOf, { organizationIds, userId })) as string[],
        );

        if (text === null) {
            return null;
        }

        // The organization ledger, read here in this action's own read budget, a page at a time on the member's shard: its newest rows that fit
        // the budget (`organizationRepliesCut` says whether older ones were left out). It is stored in the usage object, so its record, its
        // confirmation and its purge are the usage object's.
        const ledger = await collectOrganizationReplyPages(
            async (cursor) => await callOnShard(internal.usage.organization.collectOrganizationRepliesForExport, { cursor, userId }, { shardKey: userId }),
            ORGANIZATION_REPLY_EXPORT_BYTES,
        );

        const key = usageObjectKey(requestId);
        const blob = new Blob([`{"usageDaily":${text},"organizationReplies":${JSON.stringify(ledger.rows)},"organizationRepliesCut":${String(ledger.cut)}}`], {
            type: "application/json",
        });

        // Recorded before the object is written, so a run that dies after this is found by the sweep (`usage/gdpr.ts`).
        await context.runMutation(internal.usage.gdpr.recordUsageFile, { key, requestId, userId });

        await withDependency("file storage", () =>
            context.storage.store(key, blob, {
                allowedContentTypes: ["application/json"],
                contentType: "application/json",
                maxSize: MAX_EXPORT_BYTES,
            }),
        );

        // Confirmed after the write: if the record was purged, or a deletion has begun, the object is removed here, so nothing
        // the erasure has already passed over is left behind.
        const kept = await context.runQuery(internal.usage.gdpr.confirmUsageFile, { key, requestId, userId });

        if (!kept) {
            // The record was released, or a deletion began, after the object was written. The record names the object again until
            // its removal is confirmed, so a failed delete leaves the sweep something to find (`usage/gdpr.ts`).
            const runId = await context.runMutation(internal.usage.gdpr.keepUsageFileRecord, { key, requestId, userId });

            await context.storage.delete(key);
            await context.runMutation(internal.usage.gdpr.releaseUsageKey, { runId });
            throw new LunoraError("CONFLICT", "Account deletion is underway; the usage export stops");
        }

        return key;
    });

/**
 * Removes a run's usage JSON object. A missing object is not an error, so the export can call this on every terminal path,
 * including one whose usage step never wrote the object. A failed delete throws: the workflow's step is then retried, and
 * the record that names the object stays until it is gone.
 */
export const deleteUsageJson = internalAction
    .input({ key: v.string() })
    .output(v.null())
    .action(async ({ args: { key }, ctx: context }) => {
        if (await context.storage.getMetadata(key)) {
            await context.storage.delete(key);
        }

        return null;
    });

export const sendExportReadyEmail = internalAction
    .input({
        requestId: v.id("gdprRequests"),
        userEmail: v.string(),
    })
    .output(v.null())
    .action(async ({ args: { requestId, userEmail }, ctx: context }) => {
        const request = await context.runQuery(internal.gdpr.functions.getRequestById, { requestId });

        if (!request || !request.storageId) {
            throw new LunoraError("NOT_FOUND", "Export request not found or storage ID missing");
        }

        // Link to the app, never to storage: the privacy page's Download button signs a fresh short-lived URL.
        const downloadUrl = `${SITE_URL.replace(TRAILING_SLASH, "")}/dashboard/settings/privacy`;

        const { default: DataExportReadyEmail } = await import("../email/templates/data-export-ready");

        await withDependency("mail", () =>
            queueEmail({
                react: DataExportReadyEmail({
                    downloadUrl,
                    expiresAt: request.expiresAt ? new Date(request.expiresAt).toLocaleDateString() : "7 days",
                }),
                subject: "Your data export is ready",
                to: userEmail,
            }),
        );

        // Declared `.output(v.null())`; return it rather than falling off the
        // end, which yields `undefined` and does not match the contract.
        return null;
    });
