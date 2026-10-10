/**
 * Request and response shapes of the public v1 API.
 *
 * Request schemas are PARSED (zod) by the router; response schemas are only
 * rendered into the OpenAPI document — handlers build those objects by hand
 * from procedure results, and `openapi.test.ts` keeps route and spec in step.
 */
import z from "zod/v4";

/** Ids are opaque strings; this only keeps garbage out of procedure args. */
export const zIdSchema = z.string().regex(/^[\w-]{1,64}$/u, "Invalid id");

export const zPage = <T extends z.ZodType>(item: T) =>
    z.object({
        data: z.array(item),
        nextCursor: z.string().nullable().meta({ description: "Pass as `cursor` to fetch the next page; `null` on the last page." }),
    });

export const zListQuerySchema = z.object({
    cursor: z.string().optional().meta({ description: "Opaque cursor from a previous page's `nextCursor`." }),
    limit: z.string().optional().meta({ description: "Page size, 1-100. Default 20." }),
});

export const zErrorBodySchema = z.object({
    error: z.object({
        code: z.string().meta({ description: "Stable machine-readable code, e.g. `insufficient_scope`." }),
        details: z.record(z.string(), z.unknown()).optional(),
        message: z.string(),
        requestId: z.string().optional(),
    }),
});

// ─── Resources ──────────────────────────────────────────────────────────────

export const zModelSchema = z.object({
    chat: z.boolean().meta({ description: "Usable with POST /chat (text models)." }),
    description: z.string().nullable(),
    id: z.string(),
    mode: z.string(),
    name: z.string(),
    provider: z.string(),
    tier: z.string().nullable(),
});

export const zThreadSchema = z.object({
    createdAt: z.number(),
    id: z.string(),
    isPublic: z.boolean(),
    model: z.string().nullable(),
    pinned: z.boolean(),
    projectId: z.string().nullable(),
    status: z.string().nullable(),
    title: z.string().nullable(),
    updatedAt: z.number().nullable(),
});

export const zMessageSchema = z.object({
    createdAt: z.number(),
    id: z.string(),
    model: z.string().nullable(),
    parts: z.array(z.record(z.string(), z.unknown())).meta({ description: "AI SDK UI message parts (text, reasoning, tool calls, files)." }),
    role: z.string(),
    status: z.string().nullable(),
    text: z.string(),
});

export const zSkillSchema = z.object({
    category: z.string().nullable(),
    description: z.string(),
    enabled: z.boolean(),
    id: z.string(),
    name: z.string(),
    slug: z.string(),
});

export const zTaskSchema = z.object({
    attemptCount: z.number(),
    createdAt: z.number(),
    cronExpression: z.string().nullable(),
    dependsOn: z.array(z.string()),
    goalId: z.string().nullable(),
    id: z.string(),
    instructions: z.string(),
    lastError: z.string().nullable(),
    lastRunThreadId: z.string().nullable(),
    model: z.string().nullable(),
    nextRunAt: z.number().nullable(),
    resultSummary: z.string().nullable(),
    skillId: z.string().nullable(),
    status: z.string(),
    successCriteria: z.string().nullable(),
    title: z.string(),
    updatedAt: z.number(),
});

export const zTaskRunSchema = z.object({
    completedAt: z.number().nullable(),
    error: z.string().nullable(),
    finalAnswer: z.string().nullable(),
    id: z.string(),
    origin: z.string(),
    round: z.number(),
    startedAt: z.number(),
    status: z.string(),
    threadId: z.string().nullable(),
});

export const zKnowledgeFileSchema = z.object({
    chunkCount: z.number().nullable(),
    createdAt: z.number(),
    error: z.string().nullable(),
    id: z.string(),
    mimeType: z.string(),
    name: z.string(),
    size: z.number(),
    status: z.string().meta({ description: "pending | processing | indexed | failed" }),
});

export const zKnowledgeHitSchema = z.object({
    chunkIndex: z.number(),
    content: z.string(),
    fileName: z.string(),
    score: z.number().meta({ description: "Reciprocal-rank-fusion score; comparable within one response only." }),
});

export const zMemorySchema = z.object({
    confidence: z.number().nullable(),
    createdAt: z.number(),
    id: z.string(),
    importance: z.number().nullable(),
    memory: z.string(),
    pinned: z.boolean(),
    type: z.string().meta({ description: "identity | preference | context | activity | experience" }),
    updatedAt: z.number().nullable(),
});

// ─── Requests ───────────────────────────────────────────────────────────────

export const zChatRequestSchema = z.object({
    model: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .meta({ description: "A model id from GET /models with `chat: true`. Defaults to the first catalogue text model." }),
    prompt: z.string().min(1).max(100_000),
    stream: z
        .boolean()
        .optional()
        .meta({ description: "true (default): return immediately with a stream token. false: block until the reply is complete and return its text." }),
    threadId: zIdSchema.optional().meta({ description: "Continue this thread. Omit to start a new one." }),
});

export const zSkillRunRequestSchema = z.object({
    input: z.string().max(100_000).optional().meta({ description: "Text passed to the skill, as if typed after `/<slug>`." }),
    model: zChatRequestSchema.shape.model,
    stream: zChatRequestSchema.shape.stream,
    threadId: zChatRequestSchema.shape.threadId,
});

export const zChatStartedSchema = z.object({
    messageId: z.string(),
    streamId: z.string(),
    streamToken: z.string().meta({ description: "Pass to POST /chat/stream. Valid for 30 minutes." }),
    threadId: z.string(),
});

export const zChatCompletedSchema = z.object({
    messageId: z.string(),
    reasoning: z.string(),
    status: z.string().meta({ description: "`done` on success; otherwise why the generation stopped." }),
    text: z.string(),
    threadId: z.string(),
});

export const zStreamRequestSchema = z.object({
    lastChunkIndex: z.int().min(0).optional().meta({ description: "Continue after this many chunks — the `lastChunkIndex` of a `resume` event." }),
    resumable: z.boolean().optional().meta({ description: "End a long stream with a `resume` event instead of a `relay_budget` error." }),
    streamToken: z.string().min(1).max(1000),
});

export const zTaskCreateRequestSchema = z.object({
    cronExpression: z.string().max(200).optional().meta({ description: "Five-field cron expression for a recurring task." }),
    dependsOn: z.array(zIdSchema).max(50).optional(),
    goalId: zIdSchema.optional(),
    instructions: z.string().min(1).max(20_000),
    maxRepairRounds: z.int().min(0).max(10).optional(),
    model: z.string().max(200).optional(),
    skillId: zIdSchema.optional(),
    successCriteria: z.string().max(5000).optional(),
    title: z.string().min(1).max(200),
});

export const zKnowledgeFileCreateRequestSchema = z.object({
    name: z.string().min(1).max(255),
    uploadId: z.string().min(1).max(200).meta({ description: "The id of a finished upload to /api/v1/uploads: the last segment of its `Location`." }),
});

export const zSearchQuerySchema = z.object({
    q: z.string().meta({ description: "Search text, 1-2000 characters." }),
});

export const zMeSchema = z.object({
    apiKeyId: z.string(),
    scopes: z.array(z.string()),
    userId: z.string(),
});
