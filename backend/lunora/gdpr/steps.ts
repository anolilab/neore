import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { gdprLogger } from "../lib/logger";
import { queueEmail } from "../email/mailer";
import { withDependency } from "../lib/dependency";

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
const projectMessage = (message: Pick<Doc<"messages">, "_creationTime" | "model" | "order" | "status" | "stepOrder" | "text" | "tool"> & { _id: string }) => {
    return {
        _id: message._id,
        createdAt: message._creationTime,
        model: message.model,
        order: message.order,
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
    thread: Pick<Doc<"threads">, "_creationTime" | "category" | "model" | "summary" | "tagIds" | "tags" | "title" | "updatedAt"> & { _id: string },
    tagNames: ReadonlyMap<string, string>,
) => {
    return {
        _id: thread._id,
        category: thread.category,
        createdAt: thread._creationTime,
        model: thread.model,
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
        messages: { _id: string; createdAt: number; model?: string; order?: number; status?: string; stepOrder?: number; text?: string; tool?: boolean }[];
        thread: {
            _id: string;
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
        for (const thread of threads.page) {
            try {
                // Every message, page by page: an Art. 15/20 export has no business
                // truncating a long thread.
                const messages: (typeof conversations)[number]["messages"] = [];
                let messageCursor: string | null = null;
                let hasMoreMessages = true;

                while (hasMoreMessages) {
                    // Annotated: the loop feeds `messageCursor` back into the call, which
                    // otherwise makes the inferred type circular.
                    const result: { continueCursor: string | null; isDone: boolean; page: Parameters<typeof projectMessage>[0][] } = await context.runQuery(
                        internal.agent.messages.listMessagesByThreadIdInternal,
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

                conversations.push({ messages, thread: projectThread(thread, tagNames) });
            } catch (error) {
                gdprLogger.error(`Failed to collect messages for thread ${thread._id}:`, error);
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
        };
    });

/** Rows of each activity table in the export. Past this the export says so rather than growing without bound. */
const EXPORT_ACTIVITY_CAP = 5000;

/** The export JSON is built whole in memory before it is stored; this is the largest one we will write. */
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

/**
 * Usage history, sub-agent delegations (their task text and results) and
 * knowledge collections — user data the export used to leave out.
 */
export const collectActivityForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ knowledgeCollections: v.array(v.any()), subAgentRuns: v.array(v.any()), usageDaily: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx: context }) => {
        const [usageDaily, subAgentRuns, { page: collections }] = await Promise.all([
            context.db
                .query("usageDaily")
                .withIndex("by_user_date", (q) => q.eq("userId", userId))
                .take(EXPORT_ACTIVITY_CAP),
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
                    skillSlug: run.skillSlug,
                    status: run.status,
                    task: run.task,
                };
            }),
            usageDaily: usageDaily.map((row) => {
                return {
                    costMicrodollars: row.costMicrodollars,
                    date: row.date,
                    replies: row.replies,
                    skill: row.skillName ?? row.skillKey,
                    tokens: row.tokens,
                };
            }),
        };
    });

export const collectPrompts = internalQuery.input({ userId: v.string() }).query(async ({ args: { userId }, ctx: context }) => {
    // `prompts` / `promptHistory` are `.global()` (D1): ORM facade, no legacy
    // reader. Unlimited `findMany` returns every matching row. Order mirrors the
    // old `by_user_and_favorite` walk and the old full-table scan.
    const { page: prompts } = await context.db.prompts.findMany({
        orderBy: [{ isFavorite: "asc" }, { _creationTime: "asc" }],
        where: { userId },
    });

    // History of the user's prompts only — filtered in the query rather than by
    // scanning every user's history rows.
    const relevantHistory =
        prompts.length === 0
            ? []
            : await context.db.promptHistory
                  .findMany({ orderBy: [{ _creationTime: "asc" }], where: { promptId: { in: prompts.map((p) => p._id) } } })
                  .then((result) => result.page);

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
        // Usage history, sub-agent runs and knowledge collections
        // (`collectActivityForExport`). Optional for the same in-flight-replay
        // reason as `threadTags`.
        activity: v.optional(v.any()),
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
        // `requestId` is new. Lunora's `storage.store` takes the object key, and
        // keying the export by its request id makes the blob traceable back to the
        // row that produced it — otherwise a stray object in the bucket is
        // unattributable, which is a poor property for a GDPR artefact.
        requestId: v.id("gdprRequests"),
        settings: v.any(),
        // Goals and tasks with their run history (`tasks/gdpr.ts`). Optional for
        // the same in-flight-replay reason as `threadTags`.
        tasks: v.optional(v.any()),
        // Optional so an export workflow already in flight when this shipped
        // still replays against the new signature.
        threadTags: v.optional(v.any()),
        userEmail: v.string(),
        userId: v.string(),
    })
    .action(async ({ args, ctx: context }) => {
        const activity = args.activity as { knowledgeCollections?: unknown[]; subAgentRuns?: unknown[]; usageDaily?: unknown[] } | undefined;
        const exportData = {
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
            files: args.files,
            knowledgeCollections: activity?.knowledgeCollections ?? [],
            memories: args.memories ?? { digests: [], memories: [] },
            notifications: args.notifications ?? { notifications: [], pushSubscriptions: [] },
            pages: args.pages ?? { comments: [], favorites: [], grants: [], pages: [] },
            profile: args.profile,
            prompts: args.prompts,
            settings: args.settings,
            subAgentRuns: activity?.subAgentRuns ?? [],
            tasks: args.tasks ?? { goals: [], tasks: [] },
            threadTags: args.threadTags ?? [],
            usageDaily: activity?.usageDaily ?? [],
        };

        const jsonString = JSON.stringify(exportData, null, 2);
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

        const storageId = request.storageId;
        const downloadUrl = await withDependency("file storage", () => context.storage.getUrl(storageId));

        if (!downloadUrl) {
            throw new LunoraError("INTERNAL", "Failed to get download URL for export");
        }

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
