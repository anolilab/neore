/**
 * The public v1 API's route table.
 *
 * One entry per endpoint, read by BOTH the router (which mounts it behind auth,
 * scope, rate-limit and idempotency handling) and the OpenAPI builder — so the
 * documented surface and the served surface cannot drift.
 *
 * Every handler is a thin adapter over an EXISTING procedure called through
 * `ctx.runQuery/runMutation/runAction(api.…)`. The request identity is the API
 * key's owner (`identity.ts`), so those procedures run their own auth checks,
 * access helpers (`resolveThreadReadAccess`, `requireOwnedTask`, …), per-user
 * rate limits and daily limits unchanged. No handler reads or writes a table
 * directly except the stream relay, which reads chunks after verifying the
 * HMAC stream token names the caller.
 */
import { MODEL_LOOKUP, MODEL_REGISTRY } from "@neore/ai/models";
import type { HttpActionCtx } from "lunorash/server";
import z from "zod/v4";

import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { runChatStart } from "../chat/http";
import { verifyStreamToken } from "../chat/streaming/persistent/stream-token";
import { isSelectableTextModel } from "../skills/builder-logic";
import { PublicApiError } from "./errors";
import type { ApiKeyIdentity } from "./identity";
import { decodeNativeCursor, encodeNativeCursor, paginateArray, parseLimit } from "./pagination";
import {
    zChatCompletedSchema,
    zChatRequestSchema,
    zChatStartedSchema,
    zKnowledgeFileSchema,
    zKnowledgeFileCreateRequestSchema,
    zKnowledgeHitSchema,
    zListQuerySchema,
    zMeSchema,
    zMemorySchema,
    zMessageSchema,
    zModelSchema,
    zPage,
    zSearchQuerySchema,
    zSkillSchema,
    zSkillRunRequestSchema,
    zStreamRequestSchema,
    zTaskSchema,
    zTaskCreateRequestSchema,
    zTaskRunSchema,
    zThreadSchema,
} from "./schemas";
import type { ApiAction, ApiResource } from "./scopes";
import { scopesToStrings } from "./scopes";
import type { StreamSource } from "./stream";
import { collectStream, pollStream, toNdjsonStream } from "./stream";
import { shardContext } from "../lib/http-shard";
import { threadShardFor } from "../lib/thread-shard";

export interface RouteInput {
    body: unknown;
    ctx: HttpActionCtx;
    identity: ApiKeyIdentity;
    params: Record<string, string>;
    query: Record<string, string | undefined>;
    signal: AbortSignal;
}

/** A handler answers data (serialised as JSON with `status`) or a finished `Response` (streams). */
export type RouteResult = Response | { data: unknown; status?: number };

export interface RouteDefinition {
    /** Request body schema (parsed before the handler runs). */
    body?: z.ZodType;
    description?: string;
    handler: (input: RouteInput) => Promise<RouteResult>;
    method: "delete" | "get" | "post";
    operationId: string;
    /** OpenAPI-style path below `/api/v1`, e.g. `/threads/{threadId}`. */
    path: string;
    /** Query-string schema (documented; parsed by the handler that needs it). */
    query?: z.ZodObject;
    /** `ndjson` for streaming routes; otherwise the JSON body schema. */
    response: z.ZodType | "ndjson";
    /** Every listed scope is required. Empty = any valid key. */
    scopes: ReadonlyArray<readonly [ApiResource, ApiAction]>;
    successStatus?: number;
    summary: string;
    tag: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[\w-]{1,64}$/u;

const idParameter = (input: RouteInput, name: string): string => {
    const value = input.params[name] ?? "";

    if (!ID_PATTERN.test(value)) {
        throw new PublicApiError("invalid_request", `\`${name}\` is not a valid id.`);
    }

    return value;
};

const nullable = <T>(value: T | null | undefined): T | null => value ?? null;

/** The model a chat runs on: the caller's choice if it is a catalogue text model, else the catalogue's first. */
export const resolveChatModel = (requested: string | undefined): string => {
    if (requested) {
        const definition = MODEL_LOOKUP.get(requested);

        if (!definition || definition.enabled === false || definition.provider === "external" || (definition.mode ?? "text") !== "text") {
            throw new PublicApiError("invalid_request", `Unknown or non-chat model "${requested}". See GET /api/v1/models.`);
        }

        return requested;
    }

    const fallback = MODEL_REGISTRY.find((definition) => isSelectableTextModel(definition));

    if (!fallback) {
        throw new PublicApiError("service_unavailable", "No chat model is available.");
    }

    return fallback.id;
};

/**
 * Translate `runChatStart`'s bespoke error bodies — written for the web client —
 * into the public error shape.
 */
const chatStartError = (status: number, body: { error?: string; message?: string; retryAfter?: number }): PublicApiError => {
    if (status === 403 && body.error?.startsWith("DAILY_")) {
        return new PublicApiError("daily_limit_reached", body.message ?? "Daily limit reached.", {
            limit: body.error,
            ...(typeof body.retryAfter === "number" && { retryAfterSeconds: body.retryAfter / 1000 }),
        });
    }

    if (status === 401) {
        return new PublicApiError("unauthenticated", "The API key's user could not be resolved.");
    }

    if (status === 404) {
        return new PublicApiError("not_found", "Thread not found.");
    }

    if (status === 400) {
        return new PublicApiError("invalid_request", body.error ?? "Invalid request.");
    }

    return new PublicApiError("internal_error", "The chat could not be started.");
};

const streamSourceFor = (ctx: HttpActionCtx, streamId: string): StreamSource => {
    const id = streamId as Id<"persistentStreams">;

    return {
        read: async (afterIndex) => {
            const { chunks, status } = await ctx.runQuery(internal.chat.streaming.persistent.library.getChunksAfter, { afterIndex, streamId: id });

            return { chunks, status };
        },
    };
};

/** How long a blocking (`stream: false`) chat may hold the request before answering with what it has. */
export const BLOCKING_CHAT_MAX_MS = 5 * 60 * 1000;

const startChat = async (input: RouteInput, request: { model?: string; prompt: string; stream?: boolean; threadId?: string }): Promise<RouteResult> => {
    const signingSecret = process.env.LLM_GATEWAY_SIGNING_SECRET;

    if (!signingSecret) {
        throw new PublicApiError("service_unavailable", "Chat is not configured on this deployment.");
    }

    const response = await runChatStart(
        input.ctx,
        { mode: "text", model: resolveChatModel(request.model), prompt: request.prompt, ...(request.threadId && { threadId: request.threadId }) },
        signingSecret,
    );
    const body = (await response.json()) as {
        error?: string;
        message?: string;
        messageId?: string;
        retryAfter?: number;
        streamId?: string | null;
        streamToken?: string;
        threadId?: string;
    };

    if (!response.ok || !body.threadId || !body.messageId || !body.streamId || !body.streamToken) {
        throw chatStartError(response.ok ? 500 : response.status, body);
    }

    if (request.stream === false) {
        // The stream lives where `runChatStart` put it: the thread OWNER's shard,
        // which for a thread shared with the key owner is not the caller's. A new
        // thread is the caller's own; an existing one's answer is still cached
        // from `runChatStart`, so neither costs a subrequest of the read budget.
        const shardKey = request.threadId ? await threadShardFor(input.ctx, input.identity.userId, request.threadId) : input.identity.userId;
        const collected = await collectStream(streamSourceFor(shardContext(input.ctx, shardKey), body.streamId), {
            maxDurationMs: BLOCKING_CHAT_MAX_MS,
            signal: input.signal,
        });

        return { data: { messageId: body.messageId, reasoning: collected.reasoning, status: collected.status, text: collected.text, threadId: body.threadId } };
    }

    return { data: { messageId: body.messageId, streamId: body.streamId, streamToken: body.streamToken, threadId: body.threadId }, status: 202 };
};

const toThread = (thread: {
    _creationTime: number;
    _id: string;
    isPublic?: boolean;
    model?: string;
    pinnedAt?: number;
    projectId?: string;
    status?: string;
    title?: string;
    updatedAt?: number;
}) => {
    return {
        createdAt: thread._creationTime,
        id: thread._id,
        isPublic: thread.isPublic === true,
        model: nullable(thread.model),
        pinned: thread.pinnedAt !== undefined,
        projectId: nullable(thread.projectId),
        status: nullable(thread.status),
        title: nullable(thread.title),
        updatedAt: nullable(thread.updatedAt),
    };
};

interface BoardTask {
    _id: unknown;
    attemptCount: number;
    createdAt: number;
    cronExpression: string | null;
    dependsOn: unknown[];
    goalId: unknown;
    instructions: string;
    lastError: string | null;
    lastRunThreadId: unknown;
    model: string | null;
    nextRunAt: number | null;
    resultSummary: string | null;
    skillId: unknown;
    status: string;
    successCriteria: string | null;
    title: string;
    updatedAt: number;
}

/** The public task shape: the board row minus internals (repair budget, review note, parent). */
const toPublicTask = (task: BoardTask) => {
    return {
        attemptCount: task.attemptCount,
        createdAt: task.createdAt,
        cronExpression: task.cronExpression,
        dependsOn: task.dependsOn as string[],
        goalId: task.goalId as string | null,
        id: task._id as string,
        instructions: task.instructions,
        lastError: task.lastError,
        lastRunThreadId: task.lastRunThreadId as string | null,
        model: task.model,
        nextRunAt: task.nextRunAt,
        resultSummary: task.resultSummary,
        skillId: task.skillId as string | null,
        status: task.status,
        successCriteria: task.successCriteria,
        title: task.title,
        updatedAt: task.updatedAt,
    };
};

const listSkills = async (ctx: HttpActionCtx) => {
    const skills = (await ctx.runAction(api.skills.functions.getSkills, { sortBy: "alphabetical" })) as ReadonlyArray<{
        _id: string;
        category?: string;
        description: string;
        enabled?: boolean;
        name: string;
        slug: string;
    }>;

    return skills.map((skill) => {
        return {
            category: nullable(skill.category),
            description: skill.description,
            enabled: skill.enabled === true,
            id: skill._id,
            name: skill.name,
            slug: skill.slug,
        };
    });
};

// ─── Routes ─────────────────────────────────────────────────────────────────

export const ROUTES: ReadonlyArray<RouteDefinition> = [
    {
        handler: async ({ identity }) => {
            return { data: { apiKeyId: identity.apiKeyId, scopes: scopesToStrings(identity.apiKeyScopes), userId: identity.userId } };
        },
        method: "get",
        operationId: "getMe",
        path: "/me",
        response: zMeSchema,
        scopes: [],
        summary: "Describe the calling API key",
        tag: "Account",
    },
    {
        handler: async () => {
            const models = MODEL_REGISTRY.filter(
                (definition) => definition.enabled !== false && definition.provider !== "external" && !definition.featureFlag && definition.listed === true,
            ).map((definition) => {
                return {
                    chat: isSelectableTextModel(definition),
                    description: nullable(definition.desc),
                    id: definition.id,
                    mode: definition.mode ?? "text",
                    name: definition.name ?? definition.id,
                    provider: definition.displayProvider ?? definition.provider,
                    tier: nullable(definition.tier),
                };
            });

            return { data: { data: models, nextCursor: null } };
        },
        method: "get",
        operationId: "listModels",
        path: "/models",
        response: zPage(zModelSchema),
        scopes: [["models", "read"]],
        summary: "List available models",
        tag: "Models",
    },
    {
        body: zChatRequestSchema,
        description:
            "Sends a prompt, creating a thread unless `threadId` is given. Counts against the same daily message limit as the app. With `stream: true` (default) answers 202 with a `streamToken` for POST /chat/stream; with `stream: false` blocks until the reply is complete (up to 5 minutes).",
        handler: async (input) => await startChat(input, input.body as z.infer<typeof zChatRequestSchema>),
        method: "post",
        operationId: "createChat",
        path: "/chat",
        response: z.union([zChatStartedSchema, zChatCompletedSchema]),
        scopes: [["chat", "write"]],
        successStatus: 202,
        summary: "Send a message",
        tag: "Chat",
    },
    {
        body: zStreamRequestSchema,
        description:
            'Streams the reply as NDJSON: `{"type":"text","text":…}`, `{"type":"reasoning",…}`, `{"type":"speaker",…}`, then exactly one `{"type":"done","status":…}` or `{"type":"error","error":{…}}`. One request reads a bounded number of times; send `resumable: true` and a long reply ends with `{"type":"resume","lastChunkIndex":n}` instead — request again with that `lastChunkIndex` to continue.',
        handler: async (input) => {
            const signingSecret = process.env.LLM_GATEWAY_SIGNING_SECRET;

            if (!signingSecret) {
                throw new PublicApiError("service_unavailable", "Chat is not configured on this deployment.");
            }

            const request = input.body as z.infer<typeof zStreamRequestSchema>;
            const token = await verifyStreamToken(request.streamToken, signingSecret);

            // A token for someone else's stream is indistinguishable from a bad one.
            if (!token || token.userId !== input.identity.userId) {
                throw new PublicApiError("not_found", "Stream not found or expired.");
            }

            // The stream lives on the thread's shard — the key owner's own, or the
            // owner of a thread shared with them.
            const shardKey = await threadShardFor(input.ctx, token.userId, token.threadId);

            const events = pollStream(streamSourceFor(shardContext(input.ctx, shardKey), token.streamId), {
                afterIndex: request.lastChunkIndex,
                resumable: request.resumable === true,
                signal: input.signal,
            });

            return new Response(toNdjsonStream(events), {
                headers: { "Cache-Control": "no-cache", "Content-Type": "application/x-ndjson; charset=utf-8" },
            });
        },
        method: "post",
        operationId: "streamChat",
        path: "/chat/stream",
        response: "ndjson",
        scopes: [["chat", "read"]],
        summary: "Stream a reply",
        tag: "Chat",
    },
    {
        handler: async ({ ctx, query }) => {
            const page = await ctx.runQuery(api.chat.functions.getThreads, {
                excludeTemporary: true,
                paginationOpts: { cursor: decodeNativeCursor(query["cursor"]), numItems: parseLimit(query["limit"]) },
            });

            return { data: { data: page.page.map((thread) => toThread(thread)), nextCursor: encodeNativeCursor(page.continueCursor, page.isDone) } };
        },
        method: "get",
        operationId: "listThreads",
        path: "/threads",
        query: zListQuerySchema,
        response: zPage(zThreadSchema),
        scopes: [["threads", "read"]],
        summary: "List threads",
        tag: "Threads",
    },
    {
        handler: async (input) => {
            const thread = await input.ctx.runQuery(api.chat.functions.getThread, { threadId: idParameter(input, "threadId") as Id<"threads"> });

            // `getThread` answers null for missing AND for not-yours; so does this.
            // A redacted (public, someone else's) thread carries no `userId`.
            if (!thread?.userId || thread.userId !== input.identity.userId) {
                throw new PublicApiError("not_found", "Thread not found.");
            }

            return { data: toThread(thread) };
        },
        method: "get",
        operationId: "getThread",
        path: "/threads/{threadId}",
        response: zThreadSchema,
        scopes: [["threads", "read"]],
        summary: "Get a thread",
        tag: "Threads",
    },
    {
        handler: async (input) => {
            await input.ctx.runMutation(api.chat.functions.deleteThread, { threadId: idParameter(input, "threadId") as Id<"threads"> });

            return { data: { deleted: true, id: input.params["threadId"] } };
        },
        method: "delete",
        operationId: "deleteThread",
        path: "/threads/{threadId}",
        response: z.object({ deleted: z.boolean(), id: z.string() }),
        scopes: [["threads", "write"]],
        summary: "Delete a thread",
        tag: "Threads",
    },
    {
        description: "Newest first. A branched thread lists only its active path, as in the app.",
        handler: async (input) => {
            const page = await input.ctx.runQuery(api.chat.functions.getThreadUIMessages, {
                paginationOpts: { cursor: decodeNativeCursor(input.query["cursor"]), numItems: parseLimit(input.query["limit"]) },
                threadId: idParameter(input, "threadId") as Id<"threads">,
            });

            return {
                data: {
                    // Pages are fetched newest-first but `toUIMessages` returns each
                    // page oldest-first; sort so the whole list reads newest-first.
                    data: page.page
                        .toSorted((a, b) => b.order - a.order || b.stepOrder - a.stepOrder)
                        .map((message) => {
                            return {
                                createdAt: message._creationTime,
                                id: message.id,
                                model: nullable(message.model),
                                parts: message.parts as unknown as Record<string, unknown>[],
                                role: message.role,
                                status: nullable(message.status),
                                text: message.text,
                            };
                        }),
                    nextCursor: encodeNativeCursor(page.continueCursor, page.isDone),
                },
            };
        },
        method: "get",
        operationId: "listMessages",
        path: "/threads/{threadId}/messages",
        query: zListQuerySchema,
        response: zPage(zMessageSchema),
        scopes: [["threads", "read"]],
        summary: "List a thread's messages",
        tag: "Threads",
    },
    {
        handler: async ({ ctx, query }) => {
            return { data: paginateArray(await listSkills(ctx), query["cursor"], parseLimit(query["limit"])) };
        },
        method: "get",
        operationId: "listSkills",
        path: "/skills",
        query: zListQuerySchema,
        response: zPage(zSkillSchema),
        scopes: [["skills", "read"]],
        summary: "List skills",
        tag: "Skills",
    },
    {
        body: zSkillRunRequestSchema,
        description: "Runs a skill by slug or id — the same as typing `/<slug> <input>` in the app. Answers like POST /chat.",
        handler: async (input) => {
            const reference = input.params["skill"] ?? "";
            const skills = await listSkills(input.ctx);
            const skill = skills.find((candidate) => candidate.slug === reference || candidate.id === reference);

            if (!skill) {
                throw new PublicApiError("not_found", "Skill not found.");
            }

            const body = input.body as z.infer<typeof zSkillRunRequestSchema>;
            const prompt = body.input?.trim() ? `/${skill.slug} ${body.input.trim()}` : `/${skill.slug}`;

            return await startChat(input, { model: body.model, prompt, stream: body.stream, threadId: body.threadId });
        },
        method: "post",
        operationId: "runSkill",
        path: "/skills/{skill}/run",
        response: z.union([zChatStartedSchema, zChatCompletedSchema]),
        scopes: [
            ["skills", "read"],
            ["chat", "write"],
        ],
        successStatus: 202,
        summary: "Run a skill",
        tag: "Skills",
    },
    {
        handler: async ({ ctx, query }) => {
            const board = await ctx.runQuery(api.tasks.functions.getTaskBoard, {});
            const tasks = board.tasks.map((task) => toPublicTask(task));

            return { data: paginateArray(tasks, query["cursor"], parseLimit(query["limit"])) };
        },
        method: "get",
        operationId: "listTasks",
        path: "/tasks",
        query: zListQuerySchema,
        response: zPage(zTaskSchema),
        scopes: [["tasks", "read"]],
        summary: "List tasks",
        tag: "Tasks",
    },
    {
        body: zTaskCreateRequestSchema,
        handler: async ({ body, ctx }) => {
            const request = body as z.infer<typeof zTaskCreateRequestSchema>;
            const { taskId } = await ctx.runMutation(api.tasks.functions.createTask, {
                ...request,
                dependsOn: (request.dependsOn ?? []) as Id<"tasks">[],
                goalId: request.goalId as Id<"goals"> | undefined,
                skillId: request.skillId as Id<"skills"> | undefined,
            });

            return { data: { id: taskId as string }, status: 201 };
        },
        method: "post",
        operationId: "createTask",
        path: "/tasks",
        response: z.object({ id: z.string() }),
        scopes: [["tasks", "write"]],
        successStatus: 201,
        summary: "Create a task",
        tag: "Tasks",
    },
    {
        handler: async (input) => {
            const taskId = idParameter(input, "taskId");
            // `getTaskRuns` runs `requireOwnedTask` — it is the access check.
            const runs = await input.ctx.runQuery(api.tasks.functions.getTaskRuns, { limit: 20, taskId: taskId as Id<"tasks"> });
            const board = await input.ctx.runQuery(api.tasks.functions.getTaskBoard, {});
            const task = board.tasks.find((candidate) => candidate._id === taskId);

            if (!task) {
                throw new PublicApiError("not_found", "Task not found.");
            }

            return {
                data: {
                    ...toPublicTask(task),
                    runs: runs.map((run) => {
                        return {
                            completedAt: run.completedAt,
                            error: run.error,
                            finalAnswer: run.finalAnswer,
                            id: run._id as string,
                            origin: run.origin,
                            round: run.round,
                            startedAt: run.startedAt,
                            status: run.status,
                            threadId: run.threadId as string | null,
                        };
                    }),
                },
            };
        },
        method: "get",
        operationId: "getTask",
        path: "/tasks/{taskId}",
        response: zTaskSchema.extend({ runs: z.array(zTaskRunSchema) }),
        scopes: [["tasks", "read"]],
        summary: "Get a task and its recent runs",
        tag: "Tasks",
    },
    {
        handler: async (input) => {
            const result = await input.ctx.runMutation(api.tasks.functions.runTask, { taskId: idParameter(input, "taskId") as Id<"tasks"> });

            return { data: { status: result.status }, status: 202 };
        },
        method: "post",
        operationId: "runTask",
        path: "/tasks/{taskId}/run",
        response: z.object({ status: z.string().meta({ description: "queued, blocked, or the status it already had when started earlier." }) }),
        scopes: [["tasks", "write"]],
        successStatus: 202,
        summary: "Run a task",
        tag: "Tasks",
    },
    {
        body: zKnowledgeFileCreateRequestSchema,
        description:
            "Upload the file first over TUS (https://tus.io) to POST /api/v1/uploads with the same API key (`knowledge:write`); the upload id is the last segment of the returned `Location`. Then call this to register the file and start indexing. Poll GET /knowledge/files for `status: indexed`.",
        handler: async ({ body, ctx }) => {
            const request = body as z.infer<typeof zKnowledgeFileCreateRequestSchema>;
            const vaultFile = await ctx.runAction(api.vault.functions.saveVaultFile, { fileName: request.name, uploadId: request.uploadId });
            const knowledgeFileId = await ctx.runMutation(api.knowledge.functions.addFile, {
                mimeType: vaultFile.fileType,
                name: request.name,
                size: vaultFile.fileSize,
                vaultFileId: vaultFile.fileId,
            });

            return { data: { id: knowledgeFileId as string, status: "pending" }, status: 201 };
        },
        method: "post",
        operationId: "createKnowledgeFile",
        path: "/knowledge/files",
        response: z.object({ id: z.string(), status: z.string() }),
        scopes: [["knowledge", "write"]],
        successStatus: 201,
        summary: "Add an uploaded file to the knowledge base",
        tag: "Knowledge",
    },
    {
        handler: async ({ ctx, query }) => {
            const files = (await ctx.runQuery(api.knowledge.functions.listFiles, {})) as ReadonlyArray<{
                _id: string;
                chunkCount?: number;
                createdAt: number;
                error?: string;
                mimeType: string;
                name: string;
                size: number;
                status: string;
            }>;
            const mapped = files
                .map((file) => {
                    return {
                        chunkCount: nullable(file.chunkCount),
                        createdAt: file.createdAt,
                        error: nullable(file.error),
                        id: file._id,
                        mimeType: file.mimeType,
                        name: file.name,
                        size: file.size,
                        status: file.status,
                    };
                })
                .toSorted((a, b) => b.createdAt - a.createdAt);

            return { data: paginateArray(mapped, query["cursor"], parseLimit(query["limit"])) };
        },
        method: "get",
        operationId: "listKnowledgeFiles",
        path: "/knowledge/files",
        query: zListQuerySchema,
        response: zPage(zKnowledgeFileSchema),
        scopes: [["knowledge", "read"]],
        summary: "List knowledge-base files",
        tag: "Knowledge",
    },
    {
        handler: async ({ ctx, query }) => {
            const q = query["q"]?.trim();

            if (!q) {
                throw new PublicApiError("invalid_request", "`q` is required.");
            }

            const hits = await ctx.runAction(api.knowledge.retrieve.searchKnowledge, { query: q });

            return { data: { data: hits, nextCursor: null } };
        },
        method: "get",
        operationId: "searchKnowledge",
        path: "/knowledge/search",
        query: zSearchQuerySchema,
        response: zPage(zKnowledgeHitSchema),
        scopes: [["knowledge", "read"]],
        summary: "Search the knowledge base",
        tag: "Knowledge",
    },
    {
        handler: async ({ ctx, query }) => {
            const memories = await ctx.runQuery(api.memory.functions.listUserMemories, {});
            const mapped = memories.map((memory) => {
                return {
                    confidence: nullable(memory.confidence),
                    createdAt: memory.createdAt,
                    id: memory._id,
                    importance: nullable(memory.importance),
                    memory: memory.memory,
                    pinned: memory.pinned,
                    type: memory.type,
                    updatedAt: nullable(memory.updatedAt),
                };
            });

            return { data: paginateArray(mapped, query["cursor"], parseLimit(query["limit"])) };
        },
        method: "get",
        operationId: "listMemories",
        path: "/memories",
        query: zListQuerySchema,
        response: zPage(zMemorySchema),
        scopes: [["memories", "read"]],
        summary: "List memories",
        tag: "Memories",
    },
];

/** `/threads/{threadId}` → `/threads/:threadId`, for hono. */
export const toHonoPath = (path: string): string => path.replaceAll(/\{(\w+)\}/gu, ":$1");
