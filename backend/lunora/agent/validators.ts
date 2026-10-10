import type { Infer, Validator } from "lunorash/server";
import { v } from "lunorash/server";

import { vGroupChat } from "../chat/group/validators";
import { vVectorDimension } from "./vector/tables";

export const vProviderOptions = v.record(v.string(), v.record(v.string(), v.any()));
const providerOptions = v.optional(vProviderOptions);

export type ProviderOptions = Infer<typeof providerOptions>;

export const vProviderMetadata = vProviderOptions;
const providerMetadata = providerOptions;

export type ProviderMetadata = Infer<typeof providerMetadata>;

export const vThreadStatus = v.union(
    v.literal("active"),
    v.literal("archived"), // unused
    v.literal("running"), // Thread is currently streaming
    v.literal("abort"), // Stream was aborted
    v.literal("error"), // Stream encountered an error
    v.literal("finish"), // Stream finished successfully
);
export const vMessageStatus = v.union(v.literal("pending"), v.literal("success"), v.literal("failed"));
export type MessageStatus = Infer<typeof vMessageStatus>;

export const vRole = v.union(v.literal("system"), v.literal("user"), v.literal("assistant"), v.literal("tool"));

export const vTextPart = v.object({
    providerMetadata,
    providerOptions,
    text: v.string(),
    type: v.literal("text"),
});

export const vImagePart = v.object({
    image: v.union(v.string(), v.bytes()),
    mediaType: v.optional(v.string()),
    providerOptions,
    type: v.literal("image"),
});

export const vFilePart = v.object({
    data: v.union(v.string(), v.bytes()),
    filename: v.optional(v.string()),
    mediaType: v.optional(v.string()),
    providerMetadata,
    providerOptions,
    type: v.literal("file"),
});

export const vUserContent = v.union(v.string(), v.array(v.union(vTextPart, vImagePart, vFilePart)));

export const vReasoningPart = v.object({
    providerMetadata,
    providerOptions,
    signature: v.optional(v.string()),
    text: v.string(),
    type: v.literal("reasoning"),
});

export const vRedactedReasoningPart = v.object({
    data: v.string(),
    providerMetadata,
    providerOptions,
    type: v.literal("redacted-reasoning"),
});

export const vReasoningDetails = v.array(
    v.union(
        vReasoningPart,
        v.object({
            signature: v.optional(v.string()),
            text: v.string(),
            type: v.literal("text"),
        }),
        v.object({ data: v.string(), type: v.literal("redacted") }),
    ),
);

export const vSourcePart = v.union(
    v.object({
        id: v.string(),
        providerMetadata,
        providerOptions,
        sourceType: v.literal("url"),
        title: v.optional(v.string()),
        type: v.literal("source"),
        url: v.string(),
    }),
    v.object({
        filename: v.optional(v.string()),
        id: v.string(),
        mediaType: v.string(),
        providerMetadata,
        providerOptions,
        sourceType: v.literal("document"),
        title: v.string(),
        type: v.literal("source"),
    }),
);
export type SourcePart = Infer<typeof vSourcePart>;

export const vToolCallPart = v.object({
    input: v.any(),
    providerExecuted: v.optional(v.boolean()),
    providerMetadata,
    providerOptions,
    toolCallId: v.string(),
    toolName: v.string(),
    type: v.literal("tool-call"),
});

export const vToolResultOutput = v.union(
    v.object({ providerOptions, type: v.literal("text"), value: v.string() }),
    v.object({ providerOptions, type: v.literal("json"), value: v.any() }),
    v.object({
        providerOptions,
        type: v.literal("error-text"),
        value: v.string(),
    }),
    v.object({ providerOptions, type: v.literal("error-json"), value: v.any() }),
    v.object({
        providerOptions,
        reason: v.optional(v.string()),
        type: v.literal("execution-denied"),
    }),
    v.object({
        type: v.literal("content"),
        value: v.array(
            v.union(
                v.object({
                    providerOptions,
                    text: v.string(),
                    type: v.literal("text"),
                }),
                v.object({
                    /** Base-64 encoded */
                    data: v.string(),
                    filename: v.optional(v.string()),

                    /**
                     * IANA media type.
                     * @see https://www.iana.org/assignments/media-types/media-types.xhtml
                     */
                    mediaType: v.string(),
                    providerOptions,
                    type: v.literal("file-data"),
                }),
                v.object({
                    providerOptions,
                    type: v.literal("file-url"),
                    url: v.string(),
                }),
                v.object({
                    /**
                     * ID of the file.
                     *
                     * If you use multiple providers, you need to
                     * specify the provider specific ids using
                     * the Record option. The key is the provider
                     * name, e.g. 'openai' or 'anthropic'.
                     */
                    fileId: v.union(v.string(), v.record(v.string(), v.string())),
                    providerOptions,
                    type: v.literal("file-id"),
                }),
                v.object({
                    data: v.string(),

                    /**
                     * IANA media type.
                     * @see https://www.iana.org/assignments/media-types/media-types.xhtml
                     */
                    mediaType: v.string(),
                    providerOptions,
                    type: v.literal("image-data"),
                }),
                v.object({
                    providerOptions,
                    type: v.literal("image-url"),
                    url: v.string(),
                }),
                v.object({
                    /**
                     * Image that is referenced using a provider file id.
                     *
                     * If you use multiple providers, you need to
                     * specify the provider specific ids using
                     * the Record option. The key is the provider
                     * name, e.g. 'openai' or 'anthropic'.
                     */
                    fileId: v.union(v.string(), v.record(v.string(), v.string())),
                    providerOptions,

                    /**
                     * Images that are referenced using a provider file id.
                     */
                    type: v.literal("image-file-id"),
                }),
                v.object({
                    providerOptions,

                    /**
                     * Custom content part. This can be used to implement
                     * provider-specific content parts.
                     */
                    type: v.literal("custom"),
                }),
            ),
        ),
    }),
);

/**
 * Tool approval request prompt part.
 */
export const vToolApprovalRequest = v.object({
    /**
     * ID of the tool approval.
     */
    approvalId: v.string(),
    /** @todo Should we continue to include? */
    providerMetadata,
    /** @todo Should we continue to include? */
    providerOptions,

    /**
     * ID of the tool call that the approval request is for.
     */
    toolCallId: v.string(),
    type: v.literal("tool-approval-request"),
});

/**
 * Tool approval response prompt part.
 */
export const vToolApprovalResponse = v.object({
    /**
     * ID of the tool approval.
     */
    approvalId: v.string(),

    /**
     * Flag indicating whether the approval was granted or denied.
     */
    approved: v.boolean(),

    /**
     * Flag indicating whether the tool call is provider-executed.
     * Only provider-executed tool approval responses should be sent to the model.
     */
    providerExecuted: v.optional(v.boolean()),
    /** @todo Should we continue to include? */
    providerMetadata,
    /** @todo Should we continue to include? */
    providerOptions,

    /**
     * Optional reason for the approval or denial.
     */
    reason: v.optional(v.string()),
    type: v.literal("tool-approval-response"),
});

export const vToolResultPart = v.object({
    dynamic: v.optional(v.boolean()),
    input: v.optional(v.any()),
    output: v.optional(vToolResultOutput),
    preliminary: v.optional(v.boolean()),
    providerExecuted: v.optional(v.boolean()),
    providerMetadata,
    providerOptions,
    toolCallId: v.string(),
    toolName: v.string(),
    type: v.literal("tool-result"),
});

export const vToolContent = v.array(v.union(vToolResultPart, vToolApprovalResponse));

export const vAssistantContent = v.union(
    v.string(),
    v.array(v.union(vTextPart, vFilePart, vReasoningPart, vRedactedReasoningPart, vToolCallPart, vToolResultPart, vSourcePart, vToolApprovalRequest)),
);

export const vContent = v.union(vUserContent, vAssistantContent, vToolContent);
export type Content = Infer<typeof vContent>;

export const vUserMessage = v.object({
    content: vUserContent,
    providerOptions,
    role: v.literal("user"),
});

export const vAssistantMessage = v.object({
    content: vAssistantContent,
    providerOptions,
    role: v.literal("assistant"),
});

export const vToolMessage = v.object({
    content: vToolContent,
    providerOptions,
    role: v.literal("tool"),
});

export const vSystemMessage = v.object({
    content: v.string(),
    providerOptions,
    role: v.literal("system"),
});

export const vMessage = v.union(vUserMessage, vAssistantMessage, vToolMessage, vSystemMessage);
export type Message = Infer<typeof vMessage>;

export type MessageContentParts =
    | Infer<typeof vTextPart>
    | Infer<typeof vImagePart>
    | Infer<typeof vFilePart>
    | Infer<typeof vReasoningPart>
    | Infer<typeof vRedactedReasoningPart>
    | Infer<typeof vToolCallPart>
    | Infer<typeof vToolResultPart>
    | Infer<typeof vSourcePart>;

export const vSource = v.union(
    v.object({
        id: v.string(),
        providerMetadata,
        providerOptions,
        sourceType: v.literal("url"),
        title: v.optional(v.string()),
        type: v.optional(v.literal("source")),
        url: v.string(),
    }),
    v.object({
        filename: v.optional(v.string()),
        id: v.string(),
        mediaType: v.string(),
        providerMetadata,
        providerOptions,
        sourceType: v.literal("document"),
        title: v.string(),
        type: v.literal("source"),
    }),
);

export const vRequest = v.object({
    body: v.optional(v.any()),
    // These are not usually present
    headers: v.optional(v.record(v.string(), v.string())),
    method: v.optional(v.string()),
    url: v.optional(v.string()),
});

export const vFinishReason = v.union(
    v.literal("stop"),
    v.literal("length"),
    v.literal("content-filter"),
    v.literal("tool-calls"),
    v.literal("error"),
    v.literal("other"),
    v.literal("unknown"),
);

export const vUsage = v.object({
    cachedInputTokens: v.optional(v.number()),
    // Cache token details from AI SDK (Anthropic's cacheCreationInputTokens maps to cacheWriteTokens)
    cacheReadTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    completionTokens: v.number(),
    // Timing metrics patched in after stream completes
    durationMs: v.optional(v.number()),
    promptTokens: v.number(),
    reasoningTokens: v.optional(v.number()),
    totalTokens: v.number(),
    ttftMs: v.optional(v.number()),
});
export type Usage = Infer<typeof vUsage>;

export const vLanguageModelCallWarning = v.union(
    v.object({
        details: v.optional(v.string()),
        setting: v.string(),
        type: v.literal("unsupported-setting"),
    }),
    v.object({
        details: v.optional(v.string()),
        tool: v.any(),
        type: v.literal("unsupported-tool"),
    }),
    v.object({ message: v.string(), type: v.literal("other") }),
);

export const vMessageWithMetadataInternalFields = {
    error: v.optional(v.string()),
    fileIds: v.optional(v.array(v.id("chatFiles"))),
    // metadata
    finishReason: v.optional(vFinishReason),
    message: vMessage,
    model: v.optional(v.string()),
    // Generation prompt — stored for display purposes (image/audio/video generation)
    prompt: v.optional(v.string()),
    provider: v.optional(v.string()),
    providerMetadata,
    reasoning: v.optional(v.string()),
    reasoningDetails: v.optional(vReasoningDetails),
    sources: v.optional(v.array(vSource)),
    status: v.optional(vMessageStatus),
    text: v.optional(v.string()),
    usage: v.optional(vUsage),
    warnings: v.optional(v.array(vLanguageModelCallWarning)),
};

export const vMessageWithMetadataInternal = v.object(vMessageWithMetadataInternalFields);
export type MessageWithMetadataInternal = Infer<typeof vMessageWithMetadataInternal>;
export const vMessageWithMetadata = v.object({
    ...vMessageWithMetadataInternalFields,
    fileIds: v.optional(v.array(v.string())),
});
export type MessageWithMetadata = Infer<typeof vMessageWithMetadata>;

export const vMessageEmbeddingsWithDimension = v.object({
    dimension: vVectorDimension,
    model: v.string(),
    vectors: v.array(v.union(v.array(v.number()), v.null())),
});
export type MessageEmbeddingsWithDimension = Infer<typeof vMessageEmbeddingsWithDimension>;

export const vMessageEmbeddings = v.object({
    model: v.string(),
    vectors: v.array(v.union(v.array(v.number()), v.null())),
});
export type MessageEmbeddings = Infer<typeof vMessageEmbeddings>;

export const vContextOptionsSearchOptions = v.object({
    limit: v.number(),
    messageRange: v.optional(v.object({ after: v.number(), before: v.number() })),
    textSearch: v.optional(v.boolean()),
    vectorScoreThreshold: v.optional(v.number()),
    vectorSearch: v.optional(v.boolean()),
});

export const vContextOptions = v.object({
    excludeToolMessages: v.optional(v.boolean()),
    recentMessages: v.optional(v.number()),
    searchOptions: v.optional(vContextOptionsSearchOptions),
    searchOtherThreads: v.optional(v.boolean()),
});

export const vStorageOptions = v.object({
    saveMessages: v.optional(v.union(v.literal("all"), v.literal("none"), v.literal("promptAndOutput"))),
});

const vPromptFields = {
    messages: v.optional(v.array(vMessage)),
    prompt: v.optional(v.string()),
    promptMessageId: v.optional(v.string()),
    system: v.optional(v.string()),
};

export const vCallSettings = v.object({
    frequencyPenalty: v.optional(v.number()),
    headers: v.optional(v.record(v.string(), v.string())),
    maxOutputTokens: v.optional(v.number()),
    maxRetries: v.optional(v.number()),
    presencePenalty: v.optional(v.number()),
    seed: v.optional(v.number()),
    stopSequences: v.optional(v.array(v.string())),
    temperature: v.optional(v.number()),
    topK: v.optional(v.number()),
    topP: v.optional(v.number()),
});
export type CallSettings = Infer<typeof vCallSettings>;

const vCommonArgs = {
    callSettings: v.optional(vCallSettings),
    contextOptions: v.optional(vContextOptions),
    providerOptions,
    storageOptions: v.optional(vStorageOptions),
    threadId: v.optional(v.string()),
    userId: v.optional(v.string()),
    ...vPromptFields,
};

/**
 * The field RECORD, so `.input()` can take it directly. `.input()` wants a record
 * of validators; `Infer` wants an object validator — both are derived from this
 * one shape so they cannot drift.
 */
export const vTextArgsFields = {
    ...vCommonArgs,
    // `experimental_continueSteps` is gone: ai removed it, and multi-step
    // continuation is `stopWhen` / `maxSteps` now. Nothing in the repo ever sent
    // or read it — it was validated and then dropped on the floor.
    maxSteps: v.optional(v.number()),
    stream: v.optional(v.boolean()),
    toolChoice: v.optional(v.union(v.literal("auto"), v.literal("none"), v.literal("required"), v.object({ toolName: v.string(), type: v.literal("tool") }))),
};

export const vTextArgs = v.object(vTextArgsFields);
export type TextArgs = Infer<typeof vTextArgs>;

export const vSafeObjectArgsFields = vCommonArgs;
export const vSafeObjectArgs = v.object(vSafeObjectArgsFields);
export type SafeObjectArgs = Infer<typeof vSafeObjectArgs>;

export const vEmbeddingsWithMetadata = v.object({
    dimension: vVectorDimension,
    model: v.string(),
    vectors: v.array(v.union(v.array(v.number()), v.null())),
});
export type EmbeddingsWithMetadata = Infer<typeof vEmbeddingsWithMetadata>;

/**
 * The page shape as a FIELD RECORD, plus a `v.object` of it.
 *
 * Two changes from the earlier version. The constraint was
 * `Validator<Value, "required", string>` — Lunora's `Validator` takes at most one
 * type argument, so the extra two were an error rather than a tighter bound. And
 * `streaming.ts` spread `vPaginationResult(vMessageDoc).fields`, which Lunora's
 * object validator does not expose; returning the record is the same idiom
 * `vTextArgsFields` / `vEmbeddingsWithoutDenormalizedFieldsFields` already use
 * here, and it keeps the two derived from one shape so they cannot drift.
 */
export const vPaginationResultFields = <T extends Validator>(itemValidator: T) => {
    return {
        continueCursor: v.union(v.string(), v.null()),
        isDone: v.boolean(),
        page: v.array(itemValidator),
        pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
        splitCursor: v.optional(v.union(v.string(), v.null())),
    };
};

export const vPaginationResult = <T extends Validator>(itemValidator: T) => v.object(vPaginationResultFields(itemValidator));

export const vStreamCursor = v.object({
    cursor: v.number(),
    streamId: v.string(),
});
export type StreamCursor = Infer<typeof vStreamCursor>;

export const vStreamArgs = v.optional(
    v.union(
        v.object({ kind: v.literal("list"), startOrder: v.optional(v.number()) }),
        v.object({ cursors: v.array(vStreamCursor), kind: v.literal("deltas") }),
    ),
);
export type StreamArgs = Infer<typeof vStreamArgs>;

export const vStreamMessage = v.object({
    agentName: v.optional(v.string()),
    format: v.optional(v.union(v.literal("UIMessageChunk"), v.literal("TextStreamPart"))),
    model: v.optional(v.string()),
    order: v.number(),
    provider: v.optional(v.string()),
    providerOptions, // Sent to model
    status: v.union(v.literal("streaming"), v.literal("finished"), v.literal("aborted")),
    stepOrder: v.number(),
    streamId: v.string(),
    // metadata
    userId: v.optional(v.string()),
});
export type StreamMessage = Infer<typeof vStreamMessage>;

export const vStreamDelta = v.object({
    end: v.number(), // exclusive
    parts: v.array(v.any()),
    start: v.number(), // inclusive
    streamId: v.string(),
});
export type StreamDelta = Infer<typeof vStreamDelta>;

export const vMessageDocFields = {
    _creationTime: v.number(),
    _id: v.string(),
    // Context on how it was generated
    agentName: v.optional(v.string()),
    embeddingId: v.optional(v.string()),
    error: v.optional(v.string()),
    fileIds: v.optional(v.array(v.string())),
    finishReason: v.optional(vFinishReason),
    // The result
    message: v.optional(vMessage),
    model: v.optional(v.string()),
    order: v.number(),
    // In-thread branching — see `agent/branch-tree.ts`.
    parentMessageId: v.optional(v.string()),

    provider: v.optional(v.string()),
    providerMetadata: v.optional(vProviderMetadata), // Received from model
    providerOptions, // Sent to model
    reasoning: v.optional(v.string()),

    reasoningDetails: v.optional(vReasoningDetails),
    // Memories injected into this reply's prompt — `memory/functions.ts#getMessageMemoryUsage`.
    retrievedMemories: v.optional(v.array(v.object({ memoryId: v.string(), score: v.number() }))),
    sources: v.optional(v.array(vSource)),
    // Group chat participant that wrote the row — `chat/group/`.
    speakerSkillId: v.optional(v.string()),
    status: vMessageStatus,

    stepOrder: v.number(),
    text: v.optional(v.string()),
    threadId: v.string(),
    // Convenience fields extracted from the message
    tool: v.boolean(), // either tool call (assistant) or tool result (tool)
    // Result metadata
    usage: v.optional(vUsage),
    userId: v.optional(v.string()), // useful for searching across threads
    warnings: v.optional(v.array(vLanguageModelCallWarning)),
};

export const vMessageDoc = v.object(vMessageDocFields);
export type MessageDoc = Infer<typeof vMessageDoc>; // Public

/**
 * Everything a caller may supply when CREATING a thread — `vThreadDocFields`
 * minus the four the database owns (`_id`, `_creationTime`, `order`, `status`).
 *
 * Spelled out as an object literal and spread into the doc fields below, rather
 * than the reverse (`omit(vThreadDocFields, [...])`), because Lunora's codegen
 * resolves `.input()` only from an object literal or a `const` object literal
 * the chain names — **never from a call**. `.input(omit(…))` type-checks and
 * then generates `FunctionReference<"mutation", {}, …>`, so every caller's
 * arguments go unchecked at the client boundary. Reported as
 * `WARN procedure_arguments_unreadable`; same family as anolilab/lunora#651,
 * and out of scope upstream for the same reason.
 */
export const vThreadCreateFields = {
    category: v.optional(v.string()), // Auto-categorized thread topic
    createdBy: v.optional(v.string()),
    customSystemPrompt: v.optional(v.string()),
    deleted: v.optional(v.boolean()),

    deletedAt: v.optional(v.number()),
    dictationLanguage: v.optional(v.string()),
    enabledFeatures: v.optional(v.array(v.string())),
    externalThreadId: v.optional(v.string()), // External platform thread/chat ID
    isPublic: v.optional(v.boolean()),
    isTemporary: v.optional(v.boolean()),
    language: v.optional(v.string()),
    lastCompressionStartedAt: v.optional(v.number()),
    messengerConnectionId: v.optional(v.string()), // Messenger connection ID
    mode: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("video"))),
    model: v.optional(v.string()),
    multiChat: v.optional(v.boolean()), // Marks comparison parent hub thread
    organizationId: v.optional(v.string()), // Organization ID (null = personal space)
    parentThreadIds: v.optional(v.array(v.string())),
    pinnedAt: v.optional(v.number()),
    projectId: v.optional(v.string()), // Project ID (stringified)
    publicAccessToken: v.optional(v.string()),
    reasoningEffort: v.optional(v.number()),
    source: v.optional(v.string()), // "telegram" | "slack" | "discord" | null (web)
    statelessMode: v.optional(v.boolean()),
    summary: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    teamId: v.optional(v.string()), // Team ID within organization
    title: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
    userId: v.optional(v.string()), // Unset for anonymous
};

export const vThreadDocFields = {
    ...vThreadCreateFields,
    _creationTime: v.number(),
    _id: v.string(),
    // Written only by `agent/branches.ts` (the switcher, regenerate, edit), so
    // deliberately not a create field.
    activeLeafMessageId: v.optional(v.string()),
    // Written only by `chat/group/functions.ts`, which checks every participant
    // is a skill the owner may use — so it is deliberately not a create field.
    groupChat: v.optional(vGroupChat),
    order: v.optional(v.number()),
    status: vThreadStatus,
    // Written only by `chat/tags/functions.ts`, which checks the ids belong to
    // the caller — so it is deliberately not a create field.
    tagIds: v.optional(v.array(v.string())),
};

export const vThreadDoc = v.object(vThreadDocFields);
export type ThreadDoc = Infer<typeof vThreadDoc>;

export const vThreadRelationship = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    branchPoint: v.optional(v.number()),
    branchType: v.optional(v.union(v.literal("branch"), v.literal("continuation"))),
    createdAt: v.number(),
    parentThreadId: v.string(),
    threadId: v.string(),
});
export type ThreadRelationship = Infer<typeof vThreadRelationship>;

export const vThreadTag = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    createdAt: v.number(),
    name: v.string(),
    usageCount: v.optional(v.number()),
    userId: v.string(),
});
export type ThreadTag = Infer<typeof vThreadTag>;

// Workflow content validators
export const vWorkflowNode = v.object({
    // Optional because a node may carry no data. (It was also the workaround for
    // codegen emitting a bare `v.any()` as REQUIRED, anolilab/lunora#688, since
    // fixed: both spellings now emit `data?: unknown`.)
    data: v.optional(v.any()),
    id: v.string(),
    position: v.object({ x: v.number(), y: v.number() }),
    type: v.string(),
});
export type WorkflowNode = Infer<typeof vWorkflowNode>;

/**
 * `sourceHandle`/`targetHandle` admit null: React Flow types them
 * `string | null | undefined` and the client stores its edges verbatim, so the
 * column has to hold what the API accepts. `workflow/functions.ts` kept a
 * widened local copy of this validator for exactly that reason while the stored
 * shape stayed narrow — a mismatch that only typechecked because
 * `createProject` generated `{}` arguments and hid it. One validator now.
 */
export const vWorkflowEdge = v.object({
    id: v.string(),
    source: v.string(),
    sourceHandle: v.optional(v.union(v.string(), v.null())),
    target: v.string(),
    targetHandle: v.optional(v.union(v.string(), v.null())),
    type: v.optional(v.string()),
});
export type WorkflowEdge = Infer<typeof vWorkflowEdge>;

export const vWorkflowViewport = v.object({
    x: v.number(),
    y: v.number(),
    zoom: v.number(),
});
export type WorkflowViewport = Infer<typeof vWorkflowViewport>;

export const vWorkflowContent = v.object({
    edges: v.array(vWorkflowEdge),
    nodes: v.array(vWorkflowNode),
    viewport: v.optional(vWorkflowViewport),
});
export type WorkflowContent = Infer<typeof vWorkflowContent>;

/**
 * Everything a caller may supply when CREATING a project — `vProjectDocFields`
 * minus the four the database owns. Literal-and-spread rather than
 * `omit(vProjectDocFields, [...])` for the reason documented on
 * `vThreadCreateFields` above: codegen cannot read a call, and silently
 * generates `{}` arguments if you hand it one.
 */
export const vProjectCreateFields = {
    color: v.optional(v.string()),
    context: v.optional(v.string()),
    defaultEnabledFeatures: v.optional(v.array(v.string())),
    defaultModel: v.optional(v.string()),
    defaultReasoningEffort: v.optional(v.number()),
    description: v.optional(v.string()),
    forkedFromId: v.optional(v.string()),
    galleryCategory: v.optional(v.string()),
    galleryFeatured: v.optional(v.boolean()),
    galleryForkCount: v.optional(v.number()),
    galleryPublishedAt: v.optional(v.number()),
    galleryTags: v.optional(v.array(v.string())),
    galleryViewCount: v.optional(v.number()),
    icon: v.optional(v.string()),
    // Gallery fields
    isPublic: v.optional(v.boolean()),
    order: v.optional(v.number()),
    organizationId: v.optional(v.string()),
    pinnedAt: v.optional(v.number()),
    // Workflow fields
    projectType: v.optional(v.union(v.literal("chat"), v.literal("workflow"))),
    publicAccessToken: v.optional(v.string()),
    title: v.string(),
    userId: v.optional(v.string()),
    workflowContent: v.optional(vWorkflowContent),
};

export const vProjectDocFields = {
    ...vProjectCreateFields,
    _creationTime: v.number(),
    _id: v.string(),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
};

export const vProjectDoc = v.object(vProjectDocFields);
export type ProjectDoc = Infer<typeof vProjectDoc>;

// Workflow execution validators
export const vWorkflowExecutionStatus = v.union(
    v.literal("pending"),
    v.literal("running"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("cancelled"),
);
export type WorkflowExecutionStatus = Infer<typeof vWorkflowExecutionStatus>;

export const vNodeExecutionStatus = v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("skipped"));
export type NodeExecutionStatus = Infer<typeof vNodeExecutionStatus>;

export const vTokenUsage = v.object({
    completionTokens: v.number(),
    promptTokens: v.number(),
    totalTokens: v.number(),
});
export type TokenUsage = Infer<typeof vTokenUsage>;

export const vWorkflowExecutionDoc = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    completedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    projectId: v.string(),
    startedAt: v.optional(v.number()),
    status: vWorkflowExecutionStatus,
    totalUsage: v.optional(vTokenUsage),
    userId: v.string(),
    workflowSnapshot: v.optional(v.any()),
});
export type WorkflowExecutionDoc = Infer<typeof vWorkflowExecutionDoc>;

export const vNodeExecutionDoc = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    completedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    executionId: v.string(),
    input: v.optional(v.any()),
    nodeId: v.string(),
    nodeType: v.string(),
    output: v.optional(v.any()),
    startedAt: v.optional(v.number()),
    status: vNodeExecutionStatus,
    usage: v.optional(vTokenUsage),
});
export type NodeExecutionDoc = Infer<typeof vNodeExecutionDoc>;
