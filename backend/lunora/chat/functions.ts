import type { ImageModelV2, JSONValue, LanguageModelV3 } from "@ai-sdk/provider";
import { signDocsForDisplay } from "../agent/display-media";
import {
    DEFAULT_FOLLOWUP_SUGGESTIONS_MODEL,
    DEFAULT_PROMPT_IMPROVEMENT_MODEL,
    DEFAULT_PROMPT_ITERATION_MODEL,
    DEFAULT_SUMMARIZATION_MODEL,
    DEFAULT_SYSTEM_PROMPT_OPTIMIZATION_MODEL,
    DEFAULT_THREAD_TITLE,
    DEFAULT_TITLE_GENERATION_MODEL,
    DEFAULT_USER_PROMPT_OPTIMIZATION_MODEL,
} from "@neore/ai/constants";
import type { ImageSize, ModelDefinition } from "@neore/ai/models";
import { MODEL_LOOKUP } from "@neore/ai/models";
import { getFollowupSuggestionsPrompt, getThreadTitlePrompt } from "@neore/ai/prompts";
import { buildCinemaPrompt } from "@neore/ai/prompts/cinema";
import {
    buildIteratePrompt,
    buildSystemOptimizerPrompt,
    buildUserOptimizerPrompt,
    isSystemOptimizerStyle,
    isUserOptimizerStyle,
    type SystemOptimizerStyle,
    type UserOptimizerStyle,
} from "@neore/ai/prompts/optimizer";
import type { LanguageModel, ModelMessage, SpeechModel } from "ai";
import { experimental_generateSpeech, generateImage as aiGenerateImage, generateText, Output, wrapLanguageModel } from "ai";
import type { PaginationResult } from "lunorash/server";
import { LunoraError } from "lunorash/server";
import { v } from "lunorash/server";
import z from "zod/v4";

import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx as ActionContext } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
// Types from their declaring modules rather than the `agent/client` barrel —
// see the note in `chat/composite.ts` (since fixed; kept because it decouples
// generated output from the barrel's re-exports).
import type { MessageDoc, ThreadDoc } from "../agent/validators";
import type { UIMessage } from "../agent/ui-messages";
import { docsToModelMessages, listMessagesByThreadIdHandler, storeFile, toUIMessages } from "../agent/client";
import { autoRepairJsonMiddleware } from "../agent/client/middleware";
import { listActivePathPage, withBranchInfo } from "../agent/branches";
import {
    redactThreadForPublicViewer,
    requireOwnedThread,
    requireThreadPermissionInAction,
    resolveThreadReadAccess,
    admitOwnedThread,
} from "../agent/thread-read-access";
import { publicThread } from "../agent/threads";
import { vMessageDoc, vThreadDoc, vThreadDocFields as vThreadDocumentFields } from "../agent/validators";
import { paginatedOf } from "../lib/output-validators";
import { getAuthUserIdentity } from "../auth";
import { assertOwnOrganizationId } from "../auth/lib/organization-helpers";
import { saveAiUserPreferences } from "../auth/lib/preference-writes";
import { patchBrowserSession } from "../browser/session-writes";
import { authAction, authMutation, authQuery, liteAuthQuery, optionalAuthQuery, publicQuery, rateLimit } from "../lib/crpc";
import { throwBadRequest, throwForbidden, throwThreadNotFound, throwUnauthorized } from "../lib/error-helpers";
import { paginationOptionsValidator, MAX_LENGTH } from "../lib/validators";
import { chatLogger, streamLogger } from "../lib/logger";
import type { RateLimitContext } from "../lib/rate-limiter";
import { checkRateLimit, createRatelimit, getRateLimitKey, getUserTier } from "../lib/rate-limiter";
import { mediaJobStamp } from "./media-abandon";
import type { FalAudioResponse } from "./lib/fal-media-parsing";
import { extractFalAudioUrl, resolveFalVideoUrl } from "./lib/fal-media-parsing";
import { INTERNAL_PREFIX_RE } from "./lib/agent-run";
import { gatewayFetch, NO_SERVICE_FETCH } from "../lib/services";
import getAgent from "./lib/get-agent";
import { getMessageFileIds, loadNsfwStatuses, redactUIMessagesForPublicViewer } from "./lib/public-thread";
import { buildReasoningProviderOptions } from "./lib/reasoning-options";
import { buildFalReferenceImageInput } from "./lib/reference-image-mapping";
import { getAgentForUser, validateThreadAccess, validateThreadAccessWithData } from "./lib/thread-helpers";
import { FETCH_TIMEOUT_LONG_MS, fetchWithDeadline } from "../lib/fetch-timeout";
import { systemDb } from "../lib/rls/scope";

const DATA_URL_BASE64_RE = /^data:[^;]+;base64,/;
const DATA_URL_IMAGE_RE = /^data:image\/(\w+);base64,(.+)$/;
const MIN_SUGGESTION_COUNT = 3;
const MAX_SUGGESTION_COUNT = 5;
const MAX_CHARACTERS_PER_SUGGESTION = 80;

// Pagination limits to keep each query small
// These values are tuned aggressively for worst-case scenarios
// Note: Better UX achieved by fetching fewer messages quickly, then loading more on demand
const MAX_MESSAGES_PER_PAGE = 20; // Conservative page size

// Cap mirrors the picker UI (`z.array(z.url()).max(4)` on the AI tool and the
// gateway). Highest per-model cap in MODEL_REGISTRY is 4 today.
const MAX_REFERENCE_IMAGES = 4;

/**
 * Extracts plain data from generateText Output API result, stripping any $schema metadata.
 * This is necessary because the runtime cannot serialize objects with $ prefixed keys.
 */
const extractPlainSuggestions = (object: unknown): string[] => {
    if (typeof object === "object" && object !== null) {
        const replacer = (key: string, value: unknown): unknown => {
            if (key.startsWith("$")) {
                return undefined;
            }

            return value;
        };

        const cleaned = JSON.parse(JSON.stringify(object, replacer)) as { suggestions?: unknown };

        if (Array.isArray(cleaned.suggestions)) {
            return cleaned.suggestions.filter((item): item is string => typeof item === "string");
        }
    }

    return [];
};

/**
 * Formats conversation history into a prompt string for the AI model.
 */
const formatConversationHistory = (messages: ModelMessage[]): string =>
    messages
        .map((message) => {
            const content =
                typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

            return `${message.role}: ${content}`;
        })
        .join("\n\n");

/**
 * Internal helper function to generate follow-up suggestions from model messages.
 * Uses AI SDK's generateObject directly to avoid serialization issues with $schema metadata.
 * Wraps the model with autoRepairJsonMiddleware to handle malformed JSON responses.
 */
const generateFollowupSuggestionsInternal = async (
    modelMessages: ModelMessage[],
    model: LanguageModel,
    language?: string,
    timezone?: string,
    location?: string,
): Promise<{
    suggestions: string[];
}> => {
    const conversationHistory = formatConversationHistory(modelMessages);
    const prompt = getFollowupSuggestionsPrompt(
        conversationHistory,
        MIN_SUGGESTION_COUNT,
        MAX_SUGGESTION_COUNT,
        MAX_CHARACTERS_PER_SUGGESTION,
        timezone,
        location,
        language,
    );

    // Wrap model with JSON repair middleware to handle malformed responses
    // Cast to LanguageModelV3 for AI SDK v6 compatibility
    const wrappedModel = wrapLanguageModel({
        middleware: [autoRepairJsonMiddleware],
        model: model as LanguageModelV3,
    });

    const result = await generateText({
        model: wrappedModel,
        output: Output.object({
            schema: z
                .object({
                    suggestions: z.array(z.string()).max(MAX_SUGGESTION_COUNT),
                })
                .strict(),
        }),
        prompt,
    });

    // Handle case where model doesn't generate valid output
    if (!result.output) {
        chatLogger.warn("[generateFollowupSuggestionsInternal] No output generated by model");

        return {
            suggestions: [],
        };
    }

    return {
        suggestions: extractPlainSuggestions(result.output),
    };
};

interface ContentTypeLimit {
    capacity: number;
    remaining: number;
}

interface ContentTypeLimits {
    audio: ContentTypeLimit;
    image: ContentTypeLimit;
    text: ContentTypeLimit;
    tier: "anonymous" | "free" | "premium";
    video: ContentTypeLimit;
}

// Content type capacities per tier
const CONTENT_CAPACITIES = {
    anonymous: { audio: 1, image: 1, text: 100, video: 0 },
    free: { audio: 5, image: 5, text: 20, video: 5 },
    premium: { audio: 100, image: 100, text: 1000, video: 100 },
} as const;

/**
 * Generate an image using an image model and store it in R2.
 * Returns the image URL and saves it as an assistant message.
 */
const normalizeImageSize = (imageSize: string, modelDefinition: ModelDefinition): ImageSize => {
    // `supportedImageSizes` is NOT part of `ModelDefinition` and no registry row
    // declares it, so this clamp is inert today (every requested size passes
    // through). Read it structurally so the guard starts working the moment the
    // field is reintroduced, rather than asserting a shape that does not exist.
    const supportedSizes = (modelDefinition as { supportedImageSizes?: ImageSize[] }).supportedImageSizes;
    const requestedSize = imageSize as ImageSize;

    if (!supportedSizes || supportedSizes.includes(requestedSize)) {
        return requestedSize;
    }

    const fallbackSize = supportedSizes[0];

    if (!fallbackSize) {
        throw new LunoraError("BAD_REQUEST", `Model ${modelDefinition.id} has no supported image sizes configured`);
    }

    return fallbackSize;
};

const parseImageSizeParams = (imageSize: ImageSize): { aspectRatio?: `${number}:${number}`; size?: `${number}x${number}` } => {
    if (imageSize.includes("x")) {
        return { size: imageSize as `${number}x${number}` };
    }

    const aspectRatio = imageSize.replace("-hd", "") as `${number}:${number}`;

    return { aspectRatio };
};

const extractBase64Data = (data: string): string => (data.startsWith("data:") ? data.replace(DATA_URL_BASE64_RE, "") : data);

const decodeBase64ToUint8Array = (base64Data: string): Uint8Array => Uint8Array.from(atob(base64Data), (c) => c.codePointAt(0) ?? 0);

const convertToUint8Array = (data: string | ArrayBuffer | Uint8Array, mimeType: string): { mimeType: string; uint8Array: Uint8Array } => {
    if (typeof data === "string") {
        const base64Data = extractBase64Data(data);
        const uint8Array = decodeBase64ToUint8Array(base64Data);

        return { mimeType, uint8Array };
    }

    if (data instanceof ArrayBuffer) {
        return { mimeType, uint8Array: new Uint8Array(data) };
    }

    return { mimeType, uint8Array: data };
};

const extractImagesFromOpenRouterResponse = (assistantContent: unknown): { mimeType: string; uint8Array: Uint8Array }[] => {
    const images: { mimeType: string; uint8Array: Uint8Array }[] = [];

    if (!Array.isArray(assistantContent)) {
        chatLogger.debug("[image_extraction] Content is not an array:", typeof assistantContent);

        return images;
    }

    chatLogger.debug("[image_extraction] Processing", assistantContent.length, "content parts");

    for (const part of assistantContent) {
        chatLogger.debug("[image_extraction] Part type:", part?.type, "keys:", part ? Object.keys(part) : "null");

        // Handle type: "file" format (OpenRouter/some models)
        if (part?.type === "file" && part?.data) {
            const mimeType = part.mimeType || "image/png";
            const imageData = convertToUint8Array(part.data, mimeType);

            images.push(imageData);
            chatLogger.debug("[image_extraction] Extracted file type image");
        }
        // Handle type: "image" with data URL format
        else if (part?.type === "image" && part?.image && typeof part.image === "string") {
            const base64Match = part.image.match(DATA_URL_IMAGE_RE);

            if (base64Match) {
                const mimeType = `image/${base64Match[1]}`;
                const base64Data = base64Match[2];
                const uint8Array = decodeBase64ToUint8Array(base64Data);

                images.push({ mimeType, uint8Array });
                chatLogger.debug("[image_extraction] Extracted image type with data URL");
            }
        }
        // Handle inline_data format (Gemini)
        else if (part?.type === "inline_data" || part?.inlineData) {
            const inlineData = part.inlineData || part;
            const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
            const base64Data = inlineData.data;

            if (base64Data && typeof base64Data === "string") {
                const uint8Array = decodeBase64ToUint8Array(base64Data);

                images.push({ mimeType, uint8Array });
                chatLogger.debug("[image_extraction] Extracted inline_data image");
            }
        }
        // Handle direct base64 data in the part
        else if (part?.data && part.mimeType && part.mimeType.startsWith("image/")) {
            const imageData = convertToUint8Array(part.data, part.mimeType);

            images.push(imageData);
            chatLogger.debug("[image_extraction] Extracted direct data image");
        }
    }

    chatLogger.debug("[image_extraction] Total images extracted:", images.length);

    return images;
};

const createBlobFromImage = (imageData: Uint8Array, mimeType: string): Blob => {
    const buffer = new ArrayBuffer(imageData.byteLength);

    new Uint8Array(buffer).set(imageData);

    return new Blob([buffer], { type: mimeType });
};

/**
 * `CinemaSettings` from `@neore/ai`, as a Lunora validator.
 *
 * It was `v.optional(v.any())`, so `cinemaSettings` reached
 * `buildCinemaPrompt(prompt, cinemaSettings)` as `unknown` — the argument the
 * function exists to read. Spelled out here rather than imported because the
 * validator has to be a runtime value in this module and `@neore/ai` ships the
 * TYPE only; the two are pinned together by the compile error that appears here
 * the moment they diverge.
 */
/** Flux Pro Redux mode per reference mode; anything else composes. */
const REDUX_MODE_BY_REFERENCE_MODE: Record<string, "composition" | "high_fidelity" | "style_transfer"> = {
    face: "high_fidelity",
    style: "style_transfer",
};

/**
 * A JSON request body for one of FAL's REST endpoints.
 *
 * The KEYS are per-endpoint (`image_url`, `seconds_total`, `controlnet_type`, …)
 * and are chosen a few lines above each call, so there is no single key set to
 * name here. What every one of them has in common is the VALUE type: these
 * objects go straight into `JSON.stringify`, so anything JSON can carry is
 * valid and anything else is a bug. `undefined` is allowed because
 * `JSON.stringify` drops those keys.
 */
type FalRequestInput = Record<string, JSONValue | undefined>;

const vCinemaSettings = v.object({
    aperture: v.optional(v.union(v.literal(1.4), v.literal(2), v.literal(2.8), v.literal(4), v.literal(5.6), v.literal(8), v.literal(11), v.literal(16))),
    camera: v.optional(
        v.union(
            v.literal("red-v-raptor"),
            v.literal("sony-venice"),
            v.literal("imax"),
            v.literal("arriflex-16sr"),
            v.literal("panavision-dxl2"),
            v.literal("arri-alexa"),
            v.literal("blackmagic"),
            v.literal("red-epic"),
            v.literal("70mm-film"),
            v.literal("8k-digital"),
        ),
    ),
    enabled: v.boolean(),
    focalLength: v.optional(
        v.union(v.literal(8), v.literal(14), v.literal(24), v.literal(35), v.literal(50), v.literal(85), v.literal(100), v.literal(135), v.literal(200)),
    ),
    lens: v.optional(
        v.union(
            v.literal("cooke-s4"),
            v.literal("panavision-anamorphic"),
            v.literal("canon-k35"),
            v.literal("hawk-anamorphic"),
            v.literal("lensbaby"),
            v.literal("petzval"),
            v.literal("zeiss-ultra"),
            v.literal("anamorphic"),
            v.literal("prime"),
            v.literal("vintage-lens"),
            v.literal("zoom"),
            v.literal("macro"),
            v.literal("wide-angle"),
            v.literal("telephoto"),
            v.literal("fisheye"),
            v.literal("tilt-shift"),
            v.literal("cine-lens"),
            v.literal("bokeh-master"),
        ),
    ),
});

export const createThread = authMutation
    .use(rateLimit("chat/create"))
    .input({
        branchName: v.optional(v.string().max(MAX_LENGTH.short)),
        customSystemPrompt: v.optional(v.string().max(MAX_LENGTH.document)),
        enabledFeatures: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
        language: v.optional(v.string().max(MAX_LENGTH.short)),
        model: v.string().max(MAX_LENGTH.short),
        multiChat: v.optional(v.boolean()),
        organizationId: v.optional(v.union(v.string().max(MAX_LENGTH.id), v.null())),
        projectId: v.optional(v.id("projects")),
        reasoningEffort: v.optional(v.number()),
        retentionHours: v.optional(v.number()),
        statelessMode: v.optional(v.boolean()),
        teamId: v.optional(v.string().max(MAX_LENGTH.id)),
        temporary: v.optional(v.boolean()),
        title: v.optional(v.string().max(MAX_LENGTH.long)),
    })
    .output(v.string())
    .mutation(
        async ({
            args: {
                branchName,
                customSystemPrompt,
                enabledFeatures,
                language,
                model,
                multiChat,
                organizationId,
                projectId,
                reasoningEffort,
                retentionHours,
                statelessMode,
                teamId,
                temporary,
                title,
            },
            ctx: context,
        }) => {
            const { userId } = context.user;

            // The org tag lands on the thread and its audit rows — the caller's own
            // active organization or none.
            assertOwnOrganizationId(context.user, organizationId);

            let projectDefaults: {
                defaultEnabledFeatures?: string[];
                defaultModel?: string;
                defaultReasoningEffort?: number;
            } = {};

            if (projectId) {
                const project = await context.runQuery(api.agent.projects.getProject, {
                    projectId: projectId as Id<"projects">,
                });

                if (project) {
                    if (project.userId && project.userId !== userId) {
                        throw new LunoraError("FORBIDDEN", "Project not found or access denied");
                    }

                    projectDefaults = {
                        defaultEnabledFeatures: project.defaultEnabledFeatures,
                        defaultModel: project.defaultModel,
                        defaultReasoningEffort: project.defaultReasoningEffort,
                    };
                }
            }

            const effectiveModel = model || projectDefaults.defaultModel || "gemini-1.5-flash";
            const effectiveReasoningEffort = reasoningEffort ?? projectDefaults.defaultReasoningEffort;
            const effectiveEnabledFeatures = enabledFeatures || projectDefaults.defaultEnabledFeatures || [];

            const agent = await getAgentForUser(context, userId, effectiveModel);

            const threadTitle = title || branchName || DEFAULT_THREAD_TITLE;

            // Validate team membership BEFORE creating thread to prevent orphaned records on failure
            if (teamId && organizationId) {
                const teamMembership = await context.db.teamMember.findFirst({ where: { teamId, userId } });

                if (!teamMembership) {
                    throw new LunoraError("FORBIDDEN", "You are not a member of this team");
                }
            }

            const { threadId } = await agent.createThread(context, {
                title: threadTitle,
                userId,
            });

            await context.runMutation(internal.agent.threads.updateThread, {
                patch: {
                    createdBy: userId,
                    customSystemPrompt: temporary ? undefined : customSystemPrompt,
                    enabledFeatures: temporary ? [] : effectiveEnabledFeatures,
                    language,
                    model: effectiveModel,
                    multiChat: multiChat ?? undefined,
                    organizationId: temporary ? undefined : (organizationId ?? undefined),
                    projectId: temporary ? undefined : projectId,
                    reasoningEffort: temporary ? undefined : effectiveReasoningEffort,
                    statelessMode: temporary ? undefined : statelessMode,
                    tags: ["chat"],
                    teamId: temporary ? undefined : (teamId ?? undefined),
                    updatedAt: context.now,
                },
                threadId: threadId as Id<"threads">,
            });

            // Create temporary thread record if requested
            if (temporary) {
                let retentionHoursToUse = retentionHours;

                if (retentionHoursToUse === undefined) {
                    const userSettings = await context.db
                        .query("userSettings")
                        .withIndex("by_userId", (q) => q.eq("userId", userId))
                        .unique();

                    retentionHoursToUse = userSettings?.temporaryChatRetentionHours ?? 24;
                }

                const expiresAt = context.now + retentionHoursToUse! * 60 * 60 * 1000;

                await context.runMutation(internal.agent.threads.createTemporaryThread, {
                    expiresAt,
                    retentionHours: retentionHoursToUse!,
                    threadId: threadId as Id<"threads">,
                });
            }

            // Record audit history for thread creation (component tables need manual tracking)
            const createdThread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

            if (createdThread) {
                await context.runMutation(internal.lib.document_history.recordHistory, {
                    attribution: { action: "insert", source: "manual" },
                    doc: createdThread,
                    documentId: threadId,
                    isDeleted: false,
                    organizationId: createdThread.organizationId ?? undefined,
                    tableName: "threads",
                    userId,
                });
            }

            context.log.event("chat.create_thread", {
                enabledFeatureCount: effectiveEnabledFeatures.length,
                model: effectiveModel,
                projectScoped: projectId !== undefined,
                statelessMode: statelessMode === true,
                teamScoped: Boolean(teamId && organizationId),
                temporary: temporary === true,
            });

            return threadId;
        },
    );

export const createThreadWithInitialMessage = internalMutation
    .input({
        customSystemPrompt: v.optional(v.string()),
        enabledFeatures: v.optional(v.array(v.string())),
        fileIds: v.optional(v.array(v.string())),
        language: v.optional(v.string()),
        messageContent: v.array(v.record(v.string(), v.any())),
        mode: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("video"))),
        model: v.string(),
        reasoningEffort: v.optional(v.number()),
        statelessMode: v.optional(v.boolean()),
        /** A title known up front (a media prompt's); otherwise the default, replaced by `createTitleChat`. */
        title: v.optional(v.string()),
        userId: v.string(),
    })
    .mutation(
        async ({
            args: { customSystemPrompt, enabledFeatures, fileIds, language, messageContent, mode, model, reasoningEffort, statelessMode, title, userId },
            ctx: context,
        }) => {
            const agent = await getAgentForUser(context, userId, model);

            // Create thread with minimal required fields
            const { threadId } = await agent.createThread(context, {
                title: title ?? DEFAULT_THREAD_TITLE,
                userId,
            });

            // Batch all settings + status update in one mutation (much faster than separate calls)
            await context.runMutation(internal.agent.threads.updateThread, {
                patch: {
                    customSystemPrompt,
                    enabledFeatures,
                    language,
                    mode,
                    model,
                    reasoningEffort,
                    statelessMode,
                    status: "running", // Set running status immediately - no separate mutation needed
                    tags: ["chat"],
                    updatedAt: context.now,
                },
                threadId: threadId as Id<"threads">,
            });

            // Save user message
            const messageMetadata = fileIds && fileIds.length > 0 ? { fileIds } : {};
            const result = await agent.saveMessage(context, {
                message: {
                    // Wire boundary: `messageContent` is declared as untyped records
                    // (`v.array(v.record(v.string(), v.any()))`) because the caller sends
                    // AI SDK content parts the validator cannot express.
                    content: messageContent as unknown as Extract<ModelMessage, { role: "user" }>["content"],
                    role: "user",
                },
                threadId,
                ...(Object.keys(messageMetadata).length > 0 && { metadata: messageMetadata }),
            });

            return {
                messageId: result.messageId,
                threadId,
            };
        },
    );

export const getThreadTemporaryStatus = liteAuthQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(v.union(v.object({ expiresAt: v.number(), isTemporary: v.literal(true), retentionHours: v.number() }), v.null()))
    .query(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;

        // Direct DB access - bypasses runQuery validator overhead (200ms+ savings)
        const [thread, temporaryThread] = await Promise.all([
            context.db.get(threadId as Id<"threads">),
            context.db
                .query("temporaryThreads")
                .withIndex("by_thread", (q: any) => q.eq("threadId", threadId as Id<"threads">))
                .first(),
        ]);

        if (!thread || thread.userId !== userId || !temporaryThread) {
            return null;
        }

        return {
            expiresAt: temporaryThread.expiresAt,
            isTemporary: true as const,
            retentionHours: temporaryThread.retentionHours ?? 24,
        };
    });

export const makeThreadTemporary = authMutation
    .use(rateLimit("chat/update"))
    .input({
        retentionHours: v.optional(v.number()),
        threadId: v.id("threads"),
    })
    .output(v.object({ expiresAt: v.number(), retentionHours: v.number(), updated: v.boolean() }))
    .mutation(async ({ args: { retentionHours, threadId }, ctx: context }) => {
        const { userId } = context.user;

        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

        if (!thread) {
            return throwThreadNotFound();
        }

        if (thread.userId !== userId) {
            throwForbidden("Cannot modify another user's thread");
        }

        // Check if already temporary
        const existingTemporaryThread = await context.runQuery(api.agent.threads.getTemporaryThread, {
            threadId: threadId as Id<"threads">,
        });

        if (existingTemporaryThread) {
            // Update the expiration time if already temporary
            const retentionHoursToUse = retentionHours ?? existingTemporaryThread.retentionHours ?? 24;
            const expiresAt = context.now + retentionHoursToUse * 60 * 60 * 1000;

            await context.runMutation(internal.agent.threads.updateTemporaryThread, {
                expiresAt,
                retentionHours: retentionHoursToUse,
                threadId: threadId as Id<"threads">,
            });

            context.log.event("chat.make_thread_temporary", { created: false, retentionHours: retentionHoursToUse });

            return { expiresAt, retentionHours: retentionHoursToUse, updated: true };
        }

        // Get retention hours from user settings if not provided
        let retentionHoursToUse = retentionHours;

        if (retentionHoursToUse === undefined) {
            const userSettings = await context.db
                .query("userSettings")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .unique();

            retentionHoursToUse = userSettings?.temporaryChatRetentionHours ?? 24;
        }

        const expiresAt = context.now + retentionHoursToUse! * 60 * 60 * 1000;

        await context.runMutation(internal.agent.threads.createTemporaryThread, {
            expiresAt,
            retentionHours: retentionHoursToUse!,
            threadId: threadId as Id<"threads">,
        });

        context.log.event("chat.make_thread_temporary", { created: true, retentionHours: retentionHoursToUse! });

        return { expiresAt, retentionHours: retentionHoursToUse!, updated: false };
    });

export const getThreadMessages = authQuery
    .input({
        model: v.string().max(MAX_LENGTH.short),
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number(),
        }),
        threadId: v.id("threads"),
    })
    .output(paginatedOf(vMessageDoc))
    .query(async ({ args: { model, paginationOpts, threadId }, ctx: context }): Promise<PaginationResult<MessageDoc>> => {
        const { userId } = context.user;

        // Run independent queries in parallel
        // Note: Messages are now copied on branch creation, so no need for dynamic merging
        const [, thread] = await Promise.all([
            validateThreadAccess(context, threadId, userId, "read"),
            context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> }),
        ]);

        const threadLanguage = thread?.language;
        const agent = await getAgentForUser(context, userId, model, threadLanguage);

        // Fetch messages directly from the thread (branch messages are copied on branch creation)
        return await agent.listMessages(context, {
            paginationOpts,
            threadId,
        });
    });

/**
 * Get thread messages as UIMessages (for use with the useUIMessages hook)
 * Returns UIMessage[] instead of MessageDoc[] for better compatibility with assistant-ui
 *
 * Performance: Uses lightweight auth (JWT-only, zero DB reads) + inlines access check
 * (direct DB reads) instead of sub-query, fast-paths for thread owner (skips threadAccess lookup).
 * Stream syncing removed to avoid timeout - handle streaming separately on the app side.
 */
export const getThreadUIMessages = liteAuthQuery
    .input({
        model: v.optional(v.string().max(MAX_LENGTH.short)),
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number(),
        }),
        threadId: v.id("threads"),
    })
    .query(async ({ args: { paginationOpts, threadId }, ctx: context }): Promise<PaginationResult<UIMessage>> => {
        const { userId } = context.user;

        // Cap numItems to prevent large fetches, ensure at least 1 (paginate rejects 0)
        const cappedNumberItems = Math.max(1, Math.min(paginationOpts.numItems, MAX_MESSAGES_PER_PAGE));

        // Owner or live grantee: the full messages. A PUBLIC thread without a
        // grant: the share page's allow-list (`chat/lib/public-thread.ts`).
        const access = await resolveThreadReadAccess(context, threadId, userId);

        if (!access) {
            // Existence only — past row-level security, which hides it either way.
            const exists = await systemDb(context).get(threadId);

            return exists ? throwUnauthorized("Access denied to this thread") : throwThreadNotFound(threadId);
        }

        const { thread } = access;

        // A branched thread lists only its active path (`agent/branches.ts`);
        // `null` keeps every other thread on the direct index scan below.
        // `usePaginatedQuery` sends `endCursor: null` for an unbounded first page.
        const pathPage = await listActivePathPage(context, thread, {
            ...paginationOpts,
            endCursor: paginationOpts.endCursor ?? undefined,
            numItems: cappedNumberItems,
        });

        // Fetch messages directly (bypasses all runQuery validator overhead)
        const rawMessages = pathPage
            ? { continueCursor: pathPage.continueCursor, isDone: pathPage.isDone, page: pathPage.page }
            : await listMessagesByThreadIdHandler(context, {
                  order: "desc" as const,
                  paginationOpts: { ...paginationOpts, numItems: cappedNumberItems },
                  statuses: ["success", "pending", "failed"],
                  threadId: threadId as Id<"threads">,
              });

        // Transform to UIMessages (same as listUIMessages but without runQuery overhead)
        // `listMessagesByThreadIdHandler` returns raw `Doc<"messages">` rows, whose
        // `message`/`usage`/`sources` columns are `unknown` in the generated data
        // model; `MessageDoc` is the same row with those columns typed by the agent
        // validators. Same runtime value, so re-brand rather than re-validate.
        // Stored media is persisted as references; sign it for display now.
        const displayDocs = await signDocsForDisplay(context, rawMessages.page as unknown as MessageDoc[]);
        const uiMessages = withBranchInfo(toUIMessages(displayDocs), pathPage?.branches);

        const fileMap = await loadNsfwStatuses(context, uiMessages);

        if (access.kind === "redacted") {
            return { ...rawMessages, page: redactUIMessagesForPublicViewer(uiMessages, fileMap) };
        }

        // Attach nsfwStatus to file/image parts in messages that have fileIds
        if (fileMap.size > 0) {
            for (const message of uiMessages) {
                const fileIds = getMessageFileIds(message);

                if (fileIds.length === 0) {
                    continue;
                }

                // Get a combined nsfwStatus: if any file in this message is blocked, mark all parts
                // (messages with multiple images share the same fileIds array)
                let fileIndex = 0;

                for (const part of message.parts) {
                    // The AI SDK's UI part union has no `"image"` member and no
                    // `nsfwStatus` field — both are this app's own extensions carried
                    // on file parts for the client to render a block state.
                    const mediaPart = part as { nsfwStatus?: string; type: string };

                    if ((mediaPart.type === "file" || mediaPart.type === "image") && fileIndex < fileIds.length) {
                        const status = fileMap.get(fileIds[fileIndex]!);

                        if (status) {
                            mediaPart.nsfwStatus = status;
                        }

                        fileIndex += 1;
                    }
                }
            }
        }

        return {
            ...rawMessages,
            page: uiMessages,
        };
    });

/**
 * Output cap for `continueThread`, which streams a reply into an existing thread.
 * Generation bills per output token, so this bounds one reply the way
 * `pages/agent.ts` caps its own generation.
 */
const CONTINUE_THREAD_MAX_OUTPUT_TOKENS = 16_000;

export const continueThread = authAction
    .use(rateLimit("chat/stream"))
    .input({
        model: v.string().max(MAX_LENGTH.short),
        prompt: v.string().max(MAX_LENGTH.text),
        threadId: v.id("threads"),
    })
    // The handler returns a `Response`, whose inferred type drags DOM WebSocket
    // types into `_generated/` (which then fails to compile). Codegen renders a
    // `v.any()` output from the handler's return type, hence `Promise<unknown>`.
    .output(v.any())
    .action(async ({ args: { model, prompt, threadId }, ctx: context }): Promise<unknown> => {
        const { userId } = context.user;

        // Use combined access check to get thread data in one call
        // Using validateThreadAccessWithData eliminates a duplicate thread fetch
        const { thread: threadData } = await validateThreadAccessWithData(context, threadId, userId, "write");
        const threadLanguage = threadData?.language;

        const agent = await getAgentForUser(context, userId, model, threadLanguage);

        const { thread } = await agent.continueThread(context, {
            threadId,
            userId,
        });

        const result = await thread.streamText({ maxOutputTokens: CONTINUE_THREAD_MAX_OUTPUT_TOKENS, prompt });

        context.log.event("chat.continue_thread", { model });

        return result.toUIMessageStreamResponse();
    });

export const getThreads = authQuery
    .input({
        excludeTemporary: v.optional(v.boolean()),
        organizationId: v.optional(v.union(v.string().max(MAX_LENGTH.id), v.null())),
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number(),
        }),
        status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
        teamId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(paginatedOf(vThreadDoc))
    .query(
        async ({ args: { excludeTemporary = true, organizationId, paginationOpts, status, teamId }, ctx: context }): Promise<PaginationResult<ThreadDoc>> => {
            const { userId } = context.user;

            try {
                // Use consolidated internal query to get threads and filter temporary threads in one call
                const results = await context.runQuery(internal.chat.functions.getThreadsWithTemporaryFilter, {
                    excludeTemporary,
                    organizationId,
                    paginationOpts,
                    status,
                    teamId,
                    userId,
                });

                return results as PaginationResult<ThreadDoc>;
            } catch (error: any) {
                if (error.message?.includes("does not export")) {
                    chatLogger.error("Component API not available yet - component needs rebuild");

                    return { continueCursor: "", isDone: true, page: [] };
                }

                throw error;
            }
        },
    );

export const getTemporaryThreads = authQuery
    .input({
        now: v.number(),
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number(),
        }),
    })
    .output(paginatedOf(v.object({ ...vThreadDocumentFields, expiresAt: v.optional(v.number()) })))
    .query(async ({ args: { now, paginationOpts }, ctx: context }): Promise<PaginationResult<ThreadDoc & { expiresAt?: number }>> => {
        const { userId } = context.user;

        try {
            const results = await context.runQuery(api.agent.threads.getTemporaryThreads, {
                now,
                paginationOpts,
                userId,
            });

            // Batch fetch expiresAt for all threads
            const threadIds = results.page.map((thread) => thread._id as Id<"threads">);
            const expiresAtRecord = await context.runQuery(api.agent.threads.getTemporaryThreadsByThreadIds, {
                threadIds,
            });
            const expiresAtMap = new Map<string, number>(Object.entries(expiresAtRecord));

            const threadsWithExpiresAt: (ThreadDoc & { expiresAt?: number })[] = results.page.map((thread) => {
                const expiresAt = expiresAtMap.get(thread._id);

                return {
                    ...thread,
                    expiresAt,
                };
            });

            return {
                ...results,
                page: threadsWithExpiresAt,
            };
        } catch (error: any) {
            if (error.message?.includes("does not export")) {
                chatLogger.error("Component API not available yet - component needs rebuild");

                return { continueCursor: "", isDone: true, page: [] };
            }

            throw error;
        }
    });

/**
 * Get a thread by ID.
 * This is a public query that doesn't require authentication, allowing it to work during auth initialization.
 * Returns null if the thread doesn't exist or the user doesn't have access.
 * Public threads are accessible without authentication.
 * Inlined access check logic - bypasses runQuery validator overhead (200ms+ savings).
 * Uses lightweight auth to avoid session lookup overhead (200-400ms savings).
 */
export const getThread = optionalAuthQuery
    .input({
        threadId: v.id("threads"),
    })
    // `vThreadDoc` already carries every field but `_id`/`_creationTime`/`status`
    // as optional, so the redacted shape below fits it without a cast — and its
    // missing `userId` is what the thread page reads as "send this viewer to
    // /thread/$token".
    .output(v.from(v.union(vThreadDoc, v.null())))
    .query(async ({ args: { threadId }, ctx: context }) => {
        const access = await resolveThreadReadAccess(context, threadId, context.user?.userId);

        if (!access || access.thread.deleted) {
            return null;
        }

        // Anyone but the owner or a grantee sees a public thread only redacted —
        // no owner id, system prompt or org/team ids.
        return access.kind === "full" ? publicThread(access.thread) : redactThreadForPublicViewer(publicThread(access.thread));
    });

export const getThreadsWithTemporaryFilter = internalQuery
    .input({
        excludeTemporary: v.boolean(),
        organizationId: v.optional(v.union(v.string(), v.null())), // null = personal space, undefined = all
        paginationOpts: v.optional(paginationOptionsValidator),
        status: v.optional(v.string()),
        teamId: v.optional(v.string()), // Filter by team within organization
        userId: v.string(),
    })
    .output(
        v.object({
            continueCursor: v.union(v.string(), v.null()),
            isDone: v.boolean(),
            page: v.array(
                v.object({
                    _creationTime: v.number(),
                    _id: v.string(),
                    createdBy: v.optional(v.string()),
                    customSystemPrompt: v.optional(v.string()),
                    deleted: v.optional(v.boolean()),
                    deletedAt: v.optional(v.number()),
                    dictationLanguage: v.optional(v.string()),
                    enabledFeatures: v.optional(v.array(v.string())),
                    isPublic: v.optional(v.boolean()),
                    isTemporary: v.optional(v.boolean()),
                    language: v.optional(v.string()),
                    mode: v.optional(v.string()),
                    model: v.optional(v.string()),
                    multiChat: v.optional(v.boolean()),
                    order: v.optional(v.number()),
                    organizationId: v.optional(v.string()),
                    pinnedAt: v.optional(v.number()),
                    projectId: v.optional(v.string()),
                    publicAccessToken: v.optional(v.string()),
                    reasoningEffort: v.optional(v.number()),
                    statelessMode: v.optional(v.boolean()),
                    status: v.string(),
                    summary: v.optional(v.string()),
                    tags: v.optional(v.array(v.string())),
                    teamId: v.optional(v.string()),
                    title: v.optional(v.string()),
                    updatedAt: v.optional(v.number()),
                    userId: v.optional(v.string()),
                }),
            ),
        }),
    )
    .query(
        async ({ args, ctx: context }) =>
            // Pass excludeTemporary directly — listThreadsByUserId now filters
            // isTemporary in its JS filter, eliminating the second runQuery call
            await context.runQuery(api.agent.threads.listThreadsByUserId, {
                excludeTemporary: args.excludeTemporary || undefined,
                organizationId: args.organizationId,
                paginationOpts: args.paginationOpts,
                status: args.status as "error" | "abort" | "active" | "archived" | "running" | "finish" | undefined,
                teamId: args.teamId,
                userId: args.userId,
            }),
    );

/**
 * Get all threads that currently have active streams
 * Returns an array of thread IDs that are currently streaming
 * Now checks thread.status directly instead of querying streams
 */
export const getStreamingThreadIds = authQuery
    .input({})
    .output(v.array(v.string()))
    .query(async ({ ctx: context }): Promise<string[]> => {
        const { userId } = context.user;

        const runningThreads = await context.runQuery(api.agent.threads.listThreadsByUserId, {
            paginationOpts: { cursor: null, numItems: 50 },
            status: "running",
            userId,
        });

        return runningThreads.page.map((t) => t._id);
    });

export const getThreadSettings = internalQuery
    .input({ threadId: v.string() })
    .output(
        v.union(
            v.object({
                customSystemPrompt: v.optional(v.string()),
                dictationLanguage: v.optional(v.string()),
                enabledFeatures: v.optional(v.array(v.string())),
                language: v.optional(v.string()),
                mode: v.optional(v.string()),
                model: v.optional(v.string()),
                projectId: v.optional(v.string()),
                reasoningEffort: v.optional(v.number()),
                statelessMode: v.optional(v.boolean()),
            }),
            v.null(),
        ),
    )
    .query(async ({ args: { threadId }, ctx: context }) => {
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread) {
            return null;
        }

        return {
            customSystemPrompt: thread.customSystemPrompt,
            dictationLanguage: thread.dictationLanguage,
            enabledFeatures: thread.enabledFeatures,
            language: thread.language,
            mode: thread.mode,
            model: thread.model,
            projectId: thread.projectId,
            reasoningEffort: thread.reasoningEffort,
            statelessMode: thread.statelessMode,
        };
    });

export const updateThreadModel = internalMutation
    .input({
        customSystemPrompt: v.optional(v.string()),
        dictationLanguage: v.optional(v.string()),
        enabledFeatures: v.optional(v.array(v.string())),
        model: v.string(),
        order: v.optional(v.number()),
        reasoningEffort: v.optional(v.number()),
        statelessMode: v.optional(v.boolean()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(
        async ({ args: { customSystemPrompt, dictationLanguage, enabledFeatures, model, order, reasoningEffort, statelessMode, threadId }, ctx: context }) => {
            const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
                threadId: threadId as Id<"threads">,
            });

            if (!thread) {
                throwThreadNotFound(`Thread ${threadId} not found`);
            }

            // Update settings (model, enabledFeatures, reasoningEffort, statelessMode, customSystemPrompt)
            // Note: We call updateThreadSettings first, then updateThreadOrder if order is provided.
            // These run in separate transactions, but since they're component functions we can't combine them.
            // The operations are logically independent (settings vs order), so this is acceptable.
            await context.runMutation(internal.agent.threads.updateThreadSettings, {
                patch: {
                    customSystemPrompt,
                    dictationLanguage,
                    enabledFeatures,
                    model,
                    reasoningEffort,
                    statelessMode,
                } as never,
                threadId: threadId as Id<"threads">,
            });

            // Update order separately if provided
            if (order !== undefined) {
                await context.runMutation(internal.agent.threads.updateThreadOrder, {
                    order,
                    threadId: threadId as Id<"threads">,
                });
            }

            return null;
        },
    );

export const updateThread = authAction
    .use(rateLimit("chat/update"))
    .input({
        customSystemPrompt: v.optional(v.string().max(MAX_LENGTH.document)),
        enabledFeatures: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
        model: v.optional(v.string().max(MAX_LENGTH.short)),
        order: v.optional(v.number()),
        reasoningEffort: v.optional(v.number()),
        statelessMode: v.optional(v.boolean()),
        status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
        summary: v.optional(v.string().max(MAX_LENGTH.text)),
        threadId: v.id("threads"),
        title: v.optional(v.string().max(MAX_LENGTH.long)),
    })
    .output(v.string())
    .action(
        async ({
            args: { customSystemPrompt, enabledFeatures, model, order, reasoningEffort, statelessMode, status, summary, threadId, title },
            ctx: context,
        }) => {
            const { userId } = context.user;

            // Use validateThreadAccessWithData to combine access check + thread fetch in one call
            const { thread: threadData } = await validateThreadAccessWithData(context, threadId, userId, "admin");
            const threadLanguage = threadData?.language;

            // Use provided model or fall back to thread's existing model
            const effectiveModel = model ?? threadData?.model;

            if (!effectiveModel) {
                throw new LunoraError("BAD_REQUEST", "Model is required when thread has no existing model");
            }

            const agent = await getAgentForUser(context, userId, effectiveModel, threadLanguage);

            const { thread } = await agent.continueThread(context, {
                threadId,
                userId,
            });

            // Update status using archive/unarchive functions if status is being changed
            if (status === "archived") {
                await context.runMutation(internal.agent.threads.archiveThread, {
                    threadId: threadId as Id<"threads">,
                });
            } else if (status === "active") {
                await context.runMutation(internal.agent.threads.unarchiveThread, {
                    threadId: threadId as Id<"threads">,
                });
            }

            if (title !== undefined || summary !== undefined) {
                await context.runMutation(internal.agent.threads.updateThread, {
                    patch: {
                        ...(title !== undefined && { title }),
                        ...(summary !== undefined && { summary }),
                    },
                    threadId: threadId as Id<"threads">,
                });
            }

            await context.runMutation(internal.chat.functions.updateThreadModel, {
                customSystemPrompt,
                enabledFeatures,
                model: effectiveModel,
                order,
                reasoningEffort,
                statelessMode,
                threadId,
                userId,
            });

            // Record audit history for thread update (component tables need manual tracking)
            const updatedThread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

            if (updatedThread) {
                await context.runMutation(internal.lib.document_history.recordHistory, {
                    attribution: { action: "update", source: "manual" },
                    doc: updatedThread,
                    documentId: threadId,
                    isDeleted: false,
                    oldDoc: threadData,
                    organizationId: updatedThread.organizationId ?? undefined,
                    tableName: "threads",
                    userId,
                });
            }

            context.log.event("chat.update_thread", {
                modelChanged: model !== undefined,
                statusChanged: status ?? null,
                summaryChanged: summary !== undefined,
                titleChanged: title !== undefined,
            });

            return thread.threadId;
        },
    );

export const convertTemporaryToPermanent = authMutation
    .use(rateLimit("chat/update"))
    .input({
        threadId: v.id("threads"),
    })
    .output(v.string())
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;

        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread) {
            return throwThreadNotFound();
        }

        if (thread.userId !== userId) {
            throwForbidden("Cannot convert another user's thread");
        }

        const temporaryThread = await context.runQuery(api.agent.threads.getTemporaryThread, {
            threadId: threadId as Id<"threads">,
        });

        if (!temporaryThread) {
            throw new LunoraError("BAD_REQUEST", "Thread is not temporary");
        }

        await context.runMutation(internal.agent.threads.convertTemporaryToPermanent, {
            threadId: threadId as Id<"threads">,
        });

        context.log.event("chat.convert_temporary_to_permanent", { converted: true });

        return threadId;
    });

export const createTitleChat = internalAction.input({ prompt: v.string(), threadId: v.string() }).action(async ({ args: arguments_, ctx: context }) => {
    const model = DEFAULT_TITLE_GENERATION_MODEL;

    const threadData = await context.runQuery(internal.agent.threads.getThreadInternal, {
        threadId: arguments_.threadId as Id<"threads">,
    });

    // Scheduled at /chat/start: the thread can be gone by the time this runs
    // (deleted, or its start never committed). Retrying cannot bring it back.
    if (!threadData) {
        console.warn(`[createTitleChat] thread ${arguments_.threadId} not found; skipping`);

        return;
    }

    const threadLanguage = threadData.language;

    // Use thread.userId if available
    const { userId } = threadData;

    // Get user preferences if userId is available
    let language: string | undefined;
    let location: string | undefined;
    let timezone: string | undefined;

    if (userId) {
        const userPreferences = await context.runQuery(internal.auth.functions.getUserPreferencesQuery, { userId });

        language = threadLanguage || userPreferences.language;
        location = userPreferences.location;
        timezone = userPreferences.timezone;
    } else {
        language = threadLanguage;
    }

    const agent = await getAgent(model, { gateway: gatewayFetch(context) });

    const { thread } = await agent.continueThread(context, {
        threadId: arguments_.threadId,
    });

    const metadata = await thread.getMetadata();

    // Only generate title if thread doesn't have a title or has the default title
    // This allows users to set custom titles that won't be overwritten
    if (metadata.title && metadata.title !== DEFAULT_THREAD_TITLE) {
        return;
    }

    // Pass timezone/location/language to getThreadTitlePrompt for context (date/time formatting, language)
    const threadTitlePrompt = getThreadTitlePrompt(timezone, location, language);
    const textResult = await thread.generateText(
        {
            prompt: `${threadTitlePrompt}\nHere is the user's prompt:\n"${arguments_.prompt}"\nGenerate a title that accurately represents what this conversation is about based on the prompt provided.`,
        },
        {
            storageOptions: {
                saveMessages: "none",
            },
        },
    );

    await thread.updateMetadata({
        title: textResult.text,
    });

    context.log.event("chat.thread_title", { inputTokens: textResult.usage.inputTokens, model, outputTokens: textResult.usage.outputTokens });
});

/**
 * Thread categories for auto-categorization.
 * The AI assigns one of these based on the user's initial prompt.
 */
const THREAD_CATEGORIES = ["coding", "writing", "research", "analysis", "brainstorming", "math", "learning", "business", "creative", "general"] as const;

export const createCategoryChat = internalAction.input({ prompt: v.string(), threadId: v.string() }).action(async ({ args: arguments_, ctx: context }) => {
    const model = DEFAULT_TITLE_GENERATION_MODEL;

    // As in `createTitleChat`: a thread that is gone is skipped, not retried.
    const threadData = await context.runQuery(internal.agent.threads.getThreadInternal, {
        threadId: arguments_.threadId as Id<"threads">,
    });

    if (!threadData) {
        console.warn(`[createCategoryChat] thread ${arguments_.threadId} not found; skipping`);

        return;
    }

    const agent = await getAgent(model, { gateway: gatewayFetch(context) });

    const { thread } = await agent.continueThread(context, {
        threadId: arguments_.threadId,
    });

    const metadata = await thread.getMetadata();

    // Don't re-categorize if already set
    if (metadata.category) {
        return;
    }

    const categoryList = THREAD_CATEGORIES.join(", ");
    const textResult = await thread.generateText(
        {
            prompt: `Classify this user message into exactly ONE category. Reply with ONLY the category name, nothing else.\n\nCategories: ${categoryList}\n\nUser message: "${arguments_.prompt}"\n\nCategory:`,
        },
        {
            storageOptions: {
                saveMessages: "none",
            },
        },
    );

    // Parse and validate the category
    const rawCategory = textResult.text.trim().toLowerCase();
    const category = (THREAD_CATEGORIES as ReadonlyArray<string>).includes(rawCategory) ? rawCategory : "general";

    await thread.updateMetadata({
        category,
    });

    context.log.event("chat.thread_category", { category, inputTokens: textResult.usage.inputTokens, model, outputTokens: textResult.usage.outputTokens });
});

export const createSummarizeChat = internalAction.input({ threadId: v.string(), userId: v.string() }).action(async ({ args: arguments_, ctx: context }) => {
    const model = DEFAULT_SUMMARIZATION_MODEL;

    const threadData = await context.runQuery(internal.agent.threads.getThreadInternal, {
        threadId: arguments_.threadId as Id<"threads">,
    });

    // Use provided userId, or fallback to thread.userId if available
    const userId = arguments_.userId || threadData?.userId;

    if (!userId) {
        throwBadRequest("userId is required for createSummarizeChat");
    }

    const agent = await getAgent(model, { gateway: gatewayFetch(context) });

    const { thread } = await agent.continueThread(context, {
        threadId: arguments_.threadId as Id<"threads">,
    });

    const messageDocs = await agent.fetchContextMessages(context, {
        contextOptions: {},
        threadId: thread.threadId,
        userId,
    });

    // Limit messages for summarization to avoid memory issues
    // Take the last 50 messages (or fewer if the conversation is shorter)
    const maxMessagesForSummary = 50;
    const messagesToSummarize = messageDocs.slice(-maxMessagesForSummary);

    // Extract only essential content to reduce payload size
    // Filter out messages without content (e.g., pending or failed messages)
    const conversationText = messagesToSummarize
        .filter((m) => m.message !== undefined)
        .map((m) => {
            const message = m.message!;
            const { role } = message;
            const content = Array.isArray(message.content)
                ? message.content
                      .filter((c: any) => c.type === "text")
                      .map((c: any) => c.text)
                      .join(" ")
                : String(message.content);
            // Truncate very long individual messages
            const truncatedContent = content.length > 1000 ? `${content.slice(0, 1000)}...` : content;

            return `${role}: ${truncatedContent}`;
        })
        .join("\n");

    const textResult = await thread.generateText(
        {
            prompt: `Summarize the key points of the following conversation in a single, concise sentence:\n\n${conversationText}`,
        },
        {
            storageOptions: {
                saveMessages: "none",
            },
        },
    );

    await thread.updateMetadata({ summary: textResult.text });

    context.log.event("chat.thread_summary", { inputTokens: textResult.usage.inputTokens, model, outputTokens: textResult.usage.outputTokens });
});

/**
 * Public action to manually generate a thread summary.
 * Only works for text models - image, video, and speech-to-text models are not supported.
 */
export const generateSummary = authAction
    .use(rateLimit("chat/update"))
    .input({
        threadId: v.id("threads"),
    })
    .output(v.object({ success: v.boolean() }))
    .action(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;

        // The summary is WRITTEN onto the thread, so reading is not enough. Checked
        // before the thread is read, so a stranger learns nothing about it.
        await requireThreadPermissionInAction(context, threadId, userId, "write");

        // Get thread data to check the model
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread) {
            return throwThreadNotFound("Thread not found");
        }

        // Get the model mode from the thread's model
        const threadModel = thread.model;

        if (threadModel) {
            const modelDefinition = MODEL_LOOKUP.get(threadModel);
            const modelMode = modelDefinition?.mode || "text";

            // Only allow summarization for text models
            if (modelMode !== "text") {
                throw new LunoraError("BAD_REQUEST", "Summary generation is only available for text models. Image, video, and audio models are not supported.");
            }
        }

        // Schedule the summarization
        await context.scheduler.runAfter(0, internal.chat.functions.createSummarizeChat, {
            threadId,
            userId,
        });

        context.log.event("chat.generate_summary", { scheduled: true });

        return { success: true };
    });

export const createThreadRelationship = internalMutation
    .input({
        branchPoint: v.optional(v.number()),
        branchType: v.optional(v.union(v.literal("branch"), v.literal("continuation"), v.literal("comparison"))),
        parentThreadId: v.string(),
        threadId: v.string(),
    })
    .mutation(async ({ args: arguments_, ctx: context }) => {
        await context.runMutation(internal.agent.threads.createThreadRelationship, {
            branchPoint: arguments_.branchPoint,
            branchType: arguments_.branchType,
            parentThreadId: arguments_.parentThreadId as Id<"threads">,
            threadId: arguments_.threadId as Id<"threads">,
        });
    });

/** Public auth mutation — called from the browser during comparison thread creation */
export const createThreadRelationshipPublic = authMutation
    .use(rateLimit("chat/create"))
    .input({
        branchPoint: v.optional(v.number()),
        branchType: v.optional(v.union(v.literal("branch"), v.literal("continuation"), v.literal("comparison"))),
        parentThreadId: v.id("threads"),
        threadId: v.id("threads"),
    })
    .mutation(async ({ args, ctx: context }) => {
        // Both ends must be the caller's: readers (`getFullThreadForExport`,
        // `getChildThreads`) follow a relationship into the OTHER thread, so a
        // link to a stranger's thread would be a read grant on it.
        await Promise.all([
            requireOwnedThread(context, args.parentThreadId, context.user.userId),
            requireOwnedThread(context, args.threadId, context.user.userId),
        ]);

        await context.runMutation(internal.chat.functions.createThreadRelationship, {
            branchPoint: args.branchPoint,
            branchType: args.branchType,
            parentThreadId: args.parentThreadId,
            threadId: args.threadId,
        });

        context.log.event("chat.create_thread_relationship", {
            branchType: args.branchType ?? null,
            hasBranchPoint: args.branchPoint !== undefined,
        });
    });

export const getThreadRelationship = internalQuery
    .input({
        threadId: v.string(),
    })
    .query(async ({ args: arguments_, ctx: context }) => {
        const relationship = await context.runQuery(api.agent.threads.getThreadRelationship, {
            threadId: arguments_.threadId as Id<"threads">,
        });

        return relationship;
    });

// A child thread is the thread document merged with the branch metadata carried
// on the `threadRelationships` row that links it to its parent.
export const getChildThreads = authQuery
    .input({
        parentThreadId: v.id("threads"),
    })
    .output(
        v.array(
            v.object({
                ...vThreadDocumentFields,
                branchPoint: v.optional(v.number()),
                branchType: v.optional(v.union(v.literal("branch"), v.literal("continuation"), v.literal("comparison"), v.literal("subagent"))),
                createdAt: v.number(),
            }),
        ),
    )
    .query(async ({ args: input, ctx }) => {
        const { parentThreadId } = input;
        const { userId } = ctx.user;

        const thread = await ctx.runQuery(internal.agent.threads.getThreadInternal, { threadId: parentThreadId as Id<"threads"> });

        if (thread && thread.userId && thread.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Access denied");
        }

        const relationships = await ctx.runQuery(api.agent.threads.getChildThreads, {
            parentThreadId: parentThreadId as Id<"threads">,
        });

        const relationshipsArray = relationships;

        const threadPromises = relationshipsArray.map((relationship) =>
            ctx.runQuery(internal.agent.threads.getThreadInternal, {
                threadId: relationship.threadId,
            }),
        );
        const threads = await Promise.all(threadPromises);

        const childThreads = relationshipsArray
            .map((relationship, index) => {
                const innerThread = threads[index];

                // A relationship row is not a read grant: only the caller's own children.
                if (!innerThread || innerThread.userId !== userId) {
                    return null;
                }

                return {
                    ...innerThread,
                    branchPoint: relationship.branchPoint,
                    branchType: relationship.branchType,
                    createdAt: relationship.createdAt,
                };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);

        return childThreads;
    });

export const deleteThreadRelationship = internalMutation
    .input({
        threadId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args: arguments_, ctx: context }) => {
        await context.runMutation(internal.agent.threads.deleteThreadRelationship, {
            threadId: arguments_.threadId as Id<"threads">,
        });

        return null;
    });

export const deleteThread = authMutation
    .use(rateLimit("chat/delete"))
    .input({
        threadId: v.id("threads"),
    })
    .output(v.object({ isDone: v.boolean() }))
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;

        // Get thread data before deletion for audit history
        const threadBeforeDelete = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

        // Owner only, like `softDeleteThread` / `deleteThreads`. This check was
        // missing: any signed-in caller holding a thread id could delete it.
        if (!threadBeforeDelete) {
            return throwThreadNotFound();
        }

        if (threadBeforeDelete.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Cannot delete another user's thread");
        }

        await context.runMutation(internal.chat.functions.deleteThreadRelationship, { threadId });

        const result = await context.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, { threadId: threadId as Id<"threads"> });

        // Record audit history for thread deletion
        if (threadBeforeDelete) {
            await context.runMutation(internal.lib.document_history.recordHistory, {
                attribution: { action: "delete", source: "manual" },
                doc: null,
                documentId: threadId,
                isDeleted: true,
                oldDoc: threadBeforeDelete,
                organizationId: threadBeforeDelete.organizationId ?? undefined,
                tableName: "threads",
                userId,
            });
        }

        context.log.event("chat.delete_thread", { isDone: result.isDone });

        return result;
    });

export const deleteThreads = authMutation
    .use(rateLimit("chat/delete"))
    .input({
        threadIds: v.array(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.object({ deletedCount: v.number(), success: v.boolean() }))
    .mutation(async ({ args: { threadIds }, ctx: context }) => {
        if (threadIds.length === 0) {
            return { deletedCount: 0, success: true };
        }

        const { userId } = context.user;

        // Parallelize thread fetches to avoid N+1 sequential queries
        const threads = await Promise.all(
            threadIds.map((threadId) =>
                context.runQuery(internal.agent.threads.getThreadInternal, {
                    threadId: threadId as Id<"threads">,
                }),
            ),
        );

        // Parallelize all deletions for 10-100x speedup on batch deletes
        const deletionResults = await Promise.allSettled(
            threadIds.map(async (threadId, i) => {
                const thread = threads[i];

                if (!thread || thread.userId !== userId) {
                    return null;
                }

                try {
                    // Run all operations in parallel for this thread
                    await Promise.all([
                        context.runMutation(internal.chat.functions.deleteThreadRelationship, { threadId }),
                        context.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, { threadId: threadId as Id<"threads"> }),
                        context.runMutation(internal.lib.document_history.recordHistory, {
                            attribution: { action: "delete", source: "manual" },
                            doc: null,
                            documentId: threadId,
                            isDeleted: true,
                            oldDoc: thread,
                            organizationId: thread.organizationId ?? undefined,
                            tableName: "threads",
                            userId,
                        }),
                    ]);

                    return threadId;
                } catch (error) {
                    chatLogger.error(`Failed to delete thread ${threadId}:`, error);

                    return null;
                }
            }),
        );

        // Count successful deletions
        const deletedCount = deletionResults.filter((result) => result.status === "fulfilled" && result.value !== null).length;

        context.log.event("chat.delete_threads", { deletedCount, requested: threadIds.length });

        return { deletedCount, success: true };
    });

export const getAllThreadRelationships = authQuery.input({}).query(async ({ ctx: context }) => {
    const { userId } = context.user;

    // Fetch user threads and all relationships in parallel (only 2 component calls)
    // This is more efficient than making individual queries per thread
    const [userThreads, allRelationships] = await Promise.all([
        context.runQuery(api.agent.threads.listThreadsByUserId, {
            paginationOpts: { cursor: null, numItems: 100 },
            userId,
        }),
        context.runQuery(internal.agent.threads.listAllThreadRelationships, { userId }),
    ]);

    if (!userThreads.page || userThreads.page.length === 0) {
        return [];
    }

    // Filter relationships to only those relevant to user's threads
    const userThreadIds = new Set(userThreads.page.map((t) => t._id));

    return allRelationships.filter((relation) => userThreadIds.has(relation.threadId) || userThreadIds.has(relation.parentThreadId));
});

/**
 * Validate that a thread exists and the current user (if authenticated) has access to it.
 * This is a public query that can be called without authentication, but will check
 * access permissions if a user is authenticated. Handles race conditions during
 * authentication initialization.
 * @param args.threadId The ID of the thread to validate
 * @returns True if the thread exists and is accessible, false otherwise
 */
export const validateThreadExists = optionalAuthQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(v.boolean())
    .query(async ({ args: { threadId }, ctx: context }) => {
        try {
            const thread = await context.runQuery(api.agent.threads.getThread, {
                threadId: threadId as Id<"threads">,
            });

            if (thread === null) {
                return false;
            }

            const { user } = context;

            // Fast path: public threads are accessible to everyone
            if (thread.isPublic === true) {
                return true;
            }

            // Fast path: legacy/anonymous threads without owner
            if (!thread.userId) {
                return true;
            }

            if (user) {
                if (thread.userId === user.userId) {
                    return true;
                }

                const access = await context.runQuery(internal.agent.sharing.getThreadAccess, {
                    threadId: threadId as Id<"threads">,
                    userId: user.userId,
                });

                return !!(access && access.permission);
            }

            return false;
        } catch {
            // Every failed check returns false, so access fails closed on any throw.
            return false;
        }
    });

export const pinThread = authMutation
    .use(rateLimit("chat/update"))
    .input({
        threadId: v.id("threads"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread) {
            return throwThreadNotFound();
        }

        if (thread.userId && thread.userId !== userId) {
            return throwForbidden("Cannot pin thread for another user");
        }

        await context.runMutation(internal.agent.threads.pinThread, {
            threadId: threadId as Id<"threads">,
        });

        context.log.event("chat.pin_thread", { pinned: true });

        return { success: true };
    });

export const unpinThread = authMutation
    .use(rateLimit("chat/update"))
    .input({
        threadId: v.id("threads"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread) {
            return throwThreadNotFound();
        }

        if (thread.userId && thread.userId !== userId) {
            return throwForbidden("Cannot unpin thread for another user");
        }

        await context.runMutation(internal.agent.threads.unpinThread, {
            threadId: threadId as Id<"threads">,
        });

        context.log.event("chat.unpin_thread", { pinned: false });

        return { success: true };
    });

export const getPinnedThreads = authQuery
    .input({})
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.string(),
                createdBy: v.optional(v.string()),
                customSystemPrompt: v.optional(v.string()),
                deleted: v.optional(v.boolean()),
                deletedAt: v.optional(v.number()),
                enabledFeatures: v.optional(v.array(v.string())),
                isPublic: v.optional(v.boolean()),
                model: v.optional(v.string()),
                order: v.optional(v.number()),
                pinnedAt: v.optional(v.number()),
                projectId: v.optional(v.string()),
                publicAccessToken: v.optional(v.string()),
                reasoningEffort: v.optional(v.number()),
                statelessMode: v.optional(v.boolean()),
                status: v.string(),
                summary: v.optional(v.string()),
                tags: v.optional(v.array(v.string())),
                title: v.optional(v.string()),
                updatedAt: v.optional(v.number()),
                userId: v.optional(v.string()),
            }),
        ),
    )
    .query(async ({ ctx: context }) => {
        const { userId } = context.user;

        return await context.runQuery(api.agent.threads.listPinnedThreads, {
            userId,
        });
    });

export const updateThreadOrder = authMutation
    .use(rateLimit("chat/update"))
    .input({
        threadOrders: v.array(v.object({ order: v.number(), threadId: v.string().max(MAX_LENGTH.id) })),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { threadOrders }, ctx: context }) => {
        const { userId } = context.user;

        const threadVerificationPromises = threadOrders.map(({ threadId }) =>
            context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> }),
        );
        const threads = await Promise.all(threadVerificationPromises);

        const updatePromises = threadOrders
            .map(({ order, threadId }, index) => {
                const thread = threads[index];

                if (thread && thread.userId === userId) {
                    return context.runMutation(internal.agent.threads.updateThreadOrder, {
                        order,
                        threadId: threadId as Id<"threads">,
                    });
                }

                return null;
            })
            .filter((promise): promise is Promise<any> => promise !== null);

        await Promise.all(updatePromises);

        context.log.event("chat.update_thread_order", { requested: threadOrders.length });

        return { success: true };
    });

export const getThreadOrders = authQuery
    .input({})
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.string(),
                createdBy: v.optional(v.string()),
                customSystemPrompt: v.optional(v.string()),
                deleted: v.optional(v.boolean()),
                deletedAt: v.optional(v.number()),
                enabledFeatures: v.optional(v.array(v.string())),
                isPublic: v.optional(v.boolean()),
                model: v.optional(v.string()),
                order: v.optional(v.number()),
                pinnedAt: v.optional(v.number()),
                projectId: v.optional(v.string()),
                publicAccessToken: v.optional(v.string()),
                reasoningEffort: v.optional(v.number()),
                statelessMode: v.optional(v.boolean()),
                status: v.string(),
                summary: v.optional(v.string()),
                tags: v.optional(v.array(v.string())),
                title: v.optional(v.string()),
                updatedAt: v.optional(v.number()),
                userId: v.optional(v.string()),
            }),
        ),
    )
    .query(async ({ ctx: context }) => {
        const { userId } = context.user;

        try {
            const threadsWithOrder = await context.runQuery(api.agent.threads.listThreadOrders, {
                userId,
            });

            return threadsWithOrder;
        } catch (error) {
            chatLogger.error("Error in getThreadOrders:", error);

            return [];
        }
    });

export const updateThreadVisibility = authMutation
    .use(rateLimit("chat/update"))
    .input({
        isPublic: v.optional(v.boolean()),
        threadId: v.id("threads"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { isPublic, threadId }, ctx: context }) => {
        const { userId } = context.user;
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread) {
            return throwThreadNotFound();
        }

        if (thread.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Cannot update visibility for another user's thread");
        }

        // The share token is minted here, as `chat_sharing.toggleThreadVisibility`
        // does. It used to be caller-chosen: guessable, or equal to another
        // thread's token so `getPublicThread`'s `.first()` could shadow that share.
        await context.runMutation(internal.agent.threads.updateThreadVisibility, {
            isPublic,
            publicAccessToken: isPublic ? crypto.randomUUID() : undefined,
            threadId: threadId as Id<"threads">,
        });

        context.log.event("chat.update_thread_visibility", { isPublic: isPublic === true });

        return { success: true };
    });

export const searchThreads = liteAuthQuery
    .input({
        excludeTemporary: v.optional(v.boolean()),
        organizationId: v.optional(v.union(v.string().max(MAX_LENGTH.id), v.null())),
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number(),
        }),
        searchQuery: v.string().max(MAX_LENGTH.long),
    })
    .output(paginatedOf(vThreadDoc))
    .query(async ({ args: { excludeTemporary = true, organizationId, paginationOpts, searchQuery }, ctx: context }): Promise<PaginationResult<ThreadDoc>> => {
        const { userId } = context.user;

        try {
            // Empty search: fall back to regular thread list
            if (!searchQuery.trim()) {
                return (await context.runQuery(internal.chat.functions.getThreadsWithTemporaryFilter, {
                    excludeTemporary,
                    organizationId,
                    paginationOpts,
                    userId,
                })) as PaginationResult<ThreadDoc>;
            }

            // Short queries (<3 chars) can't use search indexes — fall back to list+filter
            if (searchQuery.trim().length < 3) {
                const allThreads = await context.runQuery(api.agent.threads.listThreadsByUserId, {
                    excludeTemporary,
                    organizationId,
                    paginationOpts: { cursor: null, numItems: 50 },
                    userId,
                });

                const query = searchQuery.toLowerCase();
                const filteredThreads = allThreads.page.filter((thread) => {
                    const titleMatch = thread.title?.toLowerCase().includes(query);
                    const summaryMatch = thread.summary?.toLowerCase().includes(query);

                    return titleMatch || summaryMatch;
                });

                const startIndex = paginationOpts.cursor ? filteredThreads.findIndex((t) => t._id === paginationOpts.cursor) + 1 : 0;
                const endIndex = Math.min(startIndex + paginationOpts.numItems, filteredThreads.length);

                return {
                    continueCursor: filteredThreads[endIndex - 1]?._id ?? null,
                    isDone: endIndex >= filteredThreads.length,
                    page: filteredThreads.slice(startIndex, endIndex),
                };
            }

            // Use search indexes — single query, no temporary thread lookup needed (isTemporary filtered in agent)
            const searchResults = await context.runQuery(api.agent.threads.searchThreadsByTitleAndSummary, {
                limit: paginationOpts.numItems * 2,
                query: searchQuery,
                userId,
            });

            // Apply cursor-based pagination over results
            const startIndex = paginationOpts.cursor ? searchResults.findIndex((t) => t._id === paginationOpts.cursor) + 1 : 0;
            const endIndex = Math.min(startIndex + paginationOpts.numItems, searchResults.length);
            const page = searchResults.slice(startIndex, endIndex);

            return {
                continueCursor: page[page.length - 1]?._id ?? null,
                isDone: endIndex >= searchResults.length,
                page,
            };
        } catch (error: any) {
            if (error.message?.includes("does not export")) {
                chatLogger.error("Component API not available yet - component needs rebuild");

                return { continueCursor: "", isDone: true, page: [] };
            }

            throw error;
        }
    });

export const searchMessages = authQuery
    .input({
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number(),
        }),
        searchQuery: v.string().max(MAX_LENGTH.long),
    })
    .output(paginatedOf(v.object({ ...vThreadDocumentFields, relevantMessages: v.optional(v.array(vMessageDoc)) })))
    .query(async ({ args: { paginationOpts, searchQuery }, ctx: context }): Promise<PaginationResult<ThreadDoc & { relevantMessages?: MessageDoc[] }>> => {
        const { userId } = context.user;

        if (!searchQuery.trim()) {
            return {
                continueCursor: "",
                isDone: true,
                page: [],
            };
        }

        const searchResults = await context.runQuery(internal.agent.messages.textSearch, {
            limit: 100,
            searchAllMessagesForUserId: userId,
            text: searchQuery.trim(),
        });

        const threadIds = [...new Set(searchResults.map((message) => message.threadId))];

        // Batch fetch all threads in parallel to avoid N+1 queries
        const threadPromises = threadIds.map(
            (threadId) => context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> }).catch(() => null), // Return null for threads that don't exist or can't be accessed
        );
        const threads = await Promise.all(threadPromises);

        const threadsWithMessages: (ThreadDoc & {
            relevantMessages?: MessageDoc[];
        })[] = [];

        for (const [i, threadId] of threadIds.entries()) {
            const thread = threads[i];

            if (thread && thread.userId === userId) {
                const relevantMessages = searchResults.filter((message) => message.threadId === threadId);

                threadsWithMessages.push({
                    ...thread,
                    relevantMessages,
                });
            }
        }

        // Sort by relevance (threads with more matching messages first, then by creation time)
        threadsWithMessages.sort((a, b) => {
            const aRelevance = a.relevantMessages?.length || 0;
            const bRelevance = b.relevantMessages?.length || 0;

            if (aRelevance !== bRelevance) {
                return bRelevance - aRelevance;
            }

            return b._creationTime - a._creationTime;
        });

        const startIndex = paginationOpts.cursor ? threadsWithMessages.findIndex((t) => t._id === paginationOpts.cursor) + 1 : 0;
        const endIndex = Math.min(startIndex + paginationOpts.numItems, threadsWithMessages.length);
        const paginatedThreads = threadsWithMessages.slice(startIndex, endIndex);

        return {
            continueCursor: endIndex < threadsWithMessages.length ? threadsWithMessages[endIndex - 1]?._id || "" : "",
            isDone: endIndex >= threadsWithMessages.length,
            page: paginatedThreads,
        };
    });

/**
 * Shared rate-limit check used by all prompt-optimizer actions.
 * Reuses the existing `chat/promptImprovement` family so the per-user budget
 * is shared across user, system, and iterate optimization.
 */
const checkPromptOptimizerRateLimit = async (context: RateLimitContext, userId: string, userPlan?: "free" | "premium"): Promise<void> => {
    const tier = getUserTier({ plan: userPlan === "premium" ? "premium" : undefined });
    const rateLimitKey = getRateLimitKey("chat/promptImprovement", tier);
    const rateLimitResult = await checkRateLimit(context, rateLimitKey, {
        count: 1,
        key: userId,
    });

    if (!rateLimitResult.ok) {
        const retryAfterSeconds = Math.ceil((rateLimitResult.retryAfter || 60_000) / 1000);

        // The payload rides on `data`, not just the message: `respondWithUserError`
        // in `chat/http.ts` reads `kind`/`retryAfter` off it to answer 429 instead
        // of 500. Stringifying it here would silently downgrade every rate limit.
        throw new LunoraError("TOO_MANY_REQUESTS", `Rate limit exceeded. Please try again in ${retryAfterSeconds} seconds.`, {
            data: {
                kind: "RateLimitError",
                message: `Rate limit exceeded. Please try again in ${retryAfterSeconds} seconds.`,
                name: rateLimitKey,
                retryAfter: rateLimitResult.retryAfter,
            },
        });
    }

    const globalRateLimitResult = await checkRateLimit(context, "chat/globalPromptImprovement", {
        count: 1,
        key: "global",
    });

    if (!globalRateLimitResult.ok) {
        throw new LunoraError("TOO_MANY_REQUESTS", "System is currently busy. Please try again in a moment.", {
            data: {
                kind: "RateLimitError",
                message: "System is currently busy. Please try again in a moment.",
                name: "chat/globalPromptImprovement",
                retryAfter: globalRateLimitResult.retryAfter,
            },
        });
    }
};

/**
 * Run a prompt-optimizer template through the chosen model and return the
 * resulting text. We concatenate the rendered system + user messages into a
 * single `prompt` because the agent thread API doesn't expose a roles array.
 *
 * The templates themselves carry the JSON-evidence prompt-injection guard, so
 * concatenation preserves the safety pattern.
 *
 * When `threadId` is provided we continue that thread (used by the in-chat
 * composer). When it is omitted (settings/preset/iterate flows that may not
 * have a real thread) we create a temporary thread bound to the user —
 * mirroring `prompts/functions.ts:optimizePrompt`. `saveMessages: "none"`
 * keeps the optimization out of the agent's persisted message log either way.
 */
const runOptimizer = async (
    // `ActionCtx`, not `Parameters<typeof checkRateLimit>[0]`. It borrowed that
    // type to avoid naming one, and while `checkRateLimit` took `any` this
    // parameter WAS `any` — so the context handed to `agent.continueThread` /
    // `agent.createThread` was unchecked on all three optimizer actions.
    context: ActionContext,
    { modelId, systemPrompt, threadId, userId, userPrompt }: { modelId: string; systemPrompt: string; threadId?: string; userId: string; userPrompt: string },
): Promise<string> => {
    // `threadId` arrives from an HTTP body, and continuing a thread loads its recent
    // messages into the prompt — whose rewrite goes back to the caller. So it must
    // be a thread the caller can read (owner or live grantee), else a stranger's
    // conversation leaks through the "improved prompt".
    if (threadId) {
        await requireThreadPermissionInAction(context, threadId as Id<"threads">, userId, "read");
    }

    const agent = await getAgent(modelId, { gateway: gatewayFetch(context) });
    const { thread } = threadId
        ? await agent.continueThread(context, { threadId })
        : await agent.createThread(context, { title: "Prompt Optimization", userId });

    const { object } = await thread.generateObject(
        {
            prompt: `${systemPrompt}\n\n${userPrompt}`,
            schema: z.object({ improvedPrompt: z.string() }).strict(),
        },
        {
            storageOptions: { saveMessages: "none" },
        },
    );

    return object.improvedPrompt;
};

const DEFAULT_USER_OPTIMIZER_STYLE: UserOptimizerStyle = "basic";
const DEFAULT_SYSTEM_OPTIMIZER_STYLE: SystemOptimizerStyle = "general";

export const improvePrompt = internalAction
    .input({
        improvementInstructions: v.optional(v.string()),
        prompt: v.string(),
        /** Optimizer style. Defaults to "basic" for backwards compatibility. */
        style: v.optional(v.string()),
        /** Existing thread to attach the optimizer call to. Omit for a fresh temp thread. */
        threadId: v.optional(v.string()),
        userId: v.string(),
        userPlan: v.optional(v.union(v.literal("free"), v.literal("premium"))),
    })
    .action(async ({ args: { improvementInstructions, prompt, style, threadId, userId, userPlan }, ctx: context }) => {
        if (!prompt.trim()) {
            throw new LunoraError("BAD_REQUEST", "Prompt cannot be empty");
        }

        await checkPromptOptimizerRateLimit(context, userId, userPlan);

        const resolvedStyle: UserOptimizerStyle = style && isUserOptimizerStyle(style) ? style : DEFAULT_USER_OPTIMIZER_STYLE;
        const { systemPrompt, userPrompt } = buildUserOptimizerPrompt(resolvedStyle, prompt.trim(), { improvementInstructions });

        const modelId = DEFAULT_USER_PROMPT_OPTIMIZATION_MODEL || DEFAULT_PROMPT_IMPROVEMENT_MODEL;
        const improvedPrompt = await runOptimizer(context, { modelId, systemPrompt, threadId, userId, userPrompt });

        return { improvedPrompt };
    });

export const optimizeSystemPrompt = internalAction
    .input({
        improvementInstructions: v.optional(v.string()),
        /** Target model the optimized system prompt will be used with (optional context for the optimizer). */
        modelId: v.optional(v.string()),
        prompt: v.string(),
        /** Optimizer style. Defaults to "general". */
        style: v.optional(v.string()),
        threadId: v.optional(v.string()),
        userId: v.string(),
        userPlan: v.optional(v.union(v.literal("free"), v.literal("premium"))),
    })
    .action(async ({ args: { improvementInstructions, modelId, prompt, style, threadId, userId, userPlan }, ctx: context }) => {
        if (!prompt.trim()) {
            throw new LunoraError("BAD_REQUEST", "Prompt cannot be empty");
        }

        await checkPromptOptimizerRateLimit(context, userId, userPlan);

        const resolvedStyle: SystemOptimizerStyle = style && isSystemOptimizerStyle(style) ? style : DEFAULT_SYSTEM_OPTIMIZER_STYLE;
        const { systemPrompt, userPrompt } = buildSystemOptimizerPrompt(resolvedStyle, prompt.trim(), { improvementInstructions, modelId });

        const optimizerModelId = DEFAULT_SYSTEM_PROMPT_OPTIMIZATION_MODEL || DEFAULT_PROMPT_IMPROVEMENT_MODEL;
        const improvedPrompt = await runOptimizer(context, { modelId: optimizerModelId, systemPrompt, threadId, userId, userPrompt });

        return { improvedPrompt };
    });

export const iteratePrompt = internalAction
    .input({
        iterateInput: v.string(),
        lastOptimizedPrompt: v.string(),
        /** "user" or "system" — currently only used for telemetry; rendering is identical. */
        mode: v.optional(v.union(v.literal("user"), v.literal("system"))),
        threadId: v.optional(v.string()),
        userId: v.string(),
        userPlan: v.optional(v.union(v.literal("free"), v.literal("premium"))),
    })
    .action(async ({ args: { iterateInput, lastOptimizedPrompt, threadId, userId, userPlan }, ctx: context }) => {
        if (!lastOptimizedPrompt.trim()) {
            throw new LunoraError("BAD_REQUEST", "lastOptimizedPrompt cannot be empty");
        }

        if (!iterateInput.trim()) {
            throw new LunoraError("BAD_REQUEST", "iterateInput cannot be empty");
        }

        await checkPromptOptimizerRateLimit(context, userId, userPlan);

        const { systemPrompt, userPrompt } = buildIteratePrompt(lastOptimizedPrompt.trim(), iterateInput.trim());

        const modelId = DEFAULT_PROMPT_ITERATION_MODEL || DEFAULT_PROMPT_IMPROVEMENT_MODEL;
        const improvedPrompt = await runOptimizer(context, { modelId, systemPrompt, threadId, userId, userPrompt });

        return { improvedPrompt };
    });

export const getFullThreadForExport = authQuery
    .input({
        model: v.string().max(MAX_LENGTH.short),
        threadId: v.id("threads"),
    })
    .query(async ({ args: { model, threadId }, ctx: context }) => {
        const { userId } = context.user;

        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

        if (!thread) {
            return throwThreadNotFound();
        }

        if (thread.userId !== userId) {
            throwUnauthorized("Unauthorized access to thread");
        }

        admitOwnedThread(context, thread, userId);

        // A query: the agent only reads the thread here, it never generates.
        const agent = await getAgent(model as string, { gateway: NO_SERVICE_FETCH });

        const threadRelationship = await context.runQuery(internal.chat.functions.getThreadRelationship, {
            threadId,
        });

        let allMessages: MessageDoc[];

        // The parent's messages are read only when the caller owns the parent too:
        // a relationship row is not a read grant on the other thread.
        const parentThread = threadRelationship
            ? await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadRelationship.parentThreadId as Id<"threads"> })
            : null;

        if (threadRelationship && parentThread?.userId === userId) {
            const parentMessages = await agent.listMessages(context, {
                paginationOpts: { cursor: null, numItems: 10_000 },
                threadId: threadRelationship.parentThreadId,
            });

            const currentMessages = await agent.listMessages(context, {
                paginationOpts: { cursor: null, numItems: 10_000 },
                threadId,
            });

            // `branchPoint` is a DISPLAY position on the parent's active path
            // (`branchThread`), so cut there, not at a raw row index that would
            // also count off-path siblings and tool rows.
            const forkContextIds = new Set<string>(
                await context.runQuery(internal.agent.branches.getForkContextIds, {
                    index: threadRelationship.branchPoint ?? 0,
                    threadId: threadRelationship.parentThreadId as Id<"threads">,
                }),
            );
            const parentMessagesUpToBranch = parentMessages.page
                .filter((message) => forkContextIds.has(message._id))
                .toSorted((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);

            allMessages = [...parentMessagesUpToBranch, ...currentMessages.page];
        } else {
            const messages = await agent.listMessages(context, {
                paginationOpts: { cursor: null, numItems: 10_000 }, // Fetch all
                threadId,
            });

            allMessages = messages.page;
        }

        return { messages: allMessages, thread };
    });

export const branchThread = authAction
    .use(rateLimit("chat/create"))
    .input({
        branchName: v.optional(v.string().max(MAX_LENGTH.short)),
        /** Legacy: display position of the fork point, used only without `messageId`. Neither forks the whole active path. */
        branchPoint: v.optional(v.number()),
        /** The message to fork at, as the UI shows it: an assistant reply keeps all of its steps. */
        messageId: v.optional(v.string().max(MAX_LENGTH.id)),
        threadId: v.id("threads"),
    })
    .output(v.string())
    .action(async ({ args: { branchName, branchPoint, messageId, threadId }, ctx: context }) => {
        const { userId } = context.user;

        const parentThread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!parentThread) {
            return throwThreadNotFound("Parent thread not found");
        }

        // Security: verify the current user owns the parent thread
        if (parentThread.userId && parentThread.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "You don't have access to branch this thread");
        }

        const { language, model, organizationId } = parentThread;

        if (!model) {
            throw new LunoraError("BAD_REQUEST", "Parent thread is missing model");
        }

        // Resolved along the ACTIVE path: a branched thread also stores
        // off-path siblings, which a raw row index would count.
        const forkEnd = await context.runQuery(internal.agent.branches.resolveForkEnd, {
            index: messageId === undefined ? branchPoint : undefined,
            messageId,
            threadId: threadId as Id<"threads">,
        });

        // Validate branch point before creating thread
        if ((messageId !== undefined || branchPoint !== undefined) && !forkEnd) {
            throw new LunoraError("BAD_REQUEST", "Branch point is not on the thread's current path");
        }

        // Create the new thread
        const newThread = await context.runMutation(internal.agent.threads.createThread, {
            language,
            model,
            organizationId,
            title: branchName || "",
            userId,
        });
        const newThreadId: string = newThread._id;

        if (branchName) {
            await context.runMutation(internal.agent.threads.updateThread, {
                patch: { title: branchName },
                threadId: newThreadId as Id<"threads">,
            });
        }

        // Create the relationship record (for UI display of branch hierarchy)
        await context.runMutation(internal.chat.functions.createThreadRelationship, {
            // The fork's DISPLAY position on the parent's active path, which
            // `getForkContextIds` resolves back to exactly the copied rows.
            branchPoint: forkEnd?.index ?? 0,
            branchType: "branch",
            parentThreadId: threadId,
            threadId: newThreadId,
        });

        // Copy messages from parent thread up to (and including) the branch point
        // This implements copy-on-branch instead of dynamic merge at query time
        if (forkEnd) {
            try {
                await context.runAction(internal.agent.messages.cloneThread, {
                    copyUserIdForVectorSearch: true,
                    sourceThreadId: threadId as Id<"threads">,
                    statuses: ["success"], // Only copy successful messages
                    targetThreadId: newThreadId as Id<"threads">,
                    upToAndIncludingMessageId: forkEnd.endId,
                });
            } catch (error) {
                // If cloning fails, clean up the thread
                chatLogger.error("Failed to clone messages for branch:", error);

                await context.runMutation(internal.chat.functions.deleteThreadRelationship, {
                    threadId: newThreadId,
                });
                await context.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, { threadId: newThreadId as Id<"threads"> });
                throw new LunoraError("INTERNAL_SERVER_ERROR", "Failed to copy messages to branch");
            }
        }

        // Record audit history for branched thread creation
        const createdThread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: newThreadId as Id<"threads"> });

        if (createdThread) {
            await context.runMutation(internal.lib.document_history.recordHistory, {
                attribution: { action: "insert", metadata: { branchedFrom: threadId, branchPoint: forkEnd?.index ?? 0 }, source: "manual" },
                doc: createdThread,
                documentId: newThreadId,
                isDeleted: false,
                organizationId: createdThread.organizationId ?? undefined,
                tableName: "threads",
                userId,
            });
        }

        context.log.event("chat.branch_thread", { clonedMessages: Boolean(forkEnd), forkedAtMessage: messageId !== undefined });

        return newThreadId;
    });

export const softDeleteThread = authMutation
    .use(rateLimit("chat/delete"))
    .input({
        threadId: v.id("threads"),
    })
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread || thread.userId !== userId) {
            throwForbidden("Not allowed");
        }

        await context.runMutation(internal.agent.threads.softDeleteThread, {
            threadId: threadId as Id<"threads">,
        });

        // Record audit history for soft delete
        const updatedThread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

        if (updatedThread) {
            await context.runMutation(internal.lib.document_history.recordHistory, {
                attribution: { action: "update", metadata: { softDelete: true }, source: "manual" },
                doc: updatedThread,
                documentId: threadId,
                isDeleted: false,
                oldDoc: thread,
                organizationId: updatedThread.organizationId ?? undefined,
                tableName: "threads",
                userId,
            });
        }

        await context.scheduler.runAfter(24 * 60 * 60 * 1000, internal.chat.functions.hardDeleteThread, { threadId });
        context.log.event("chat.soft_delete_thread", { scheduledHardDelete: true });
    });

export const hardDeleteThread = internalMutation
    .input({ threadId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        // Get thread data before deletion for audit history
        const threadBeforeDelete = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

        await context.runMutation(internal.chat.functions.deleteThreadRelationship, { threadId });
        await context.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, { threadId: threadId as Id<"threads"> });

        // Record audit history for hard delete
        if (threadBeforeDelete) {
            await context.runMutation(internal.lib.document_history.recordHistory, {
                attribution: { action: "delete", metadata: { hardDelete: true }, source: "manual" },
                doc: null,
                documentId: threadId,
                isDeleted: true,
                oldDoc: threadBeforeDelete,
                organizationId: threadBeforeDelete.organizationId ?? undefined,
                tableName: "threads",
                userId: threadBeforeDelete.userId,
            });
        }

        return null;
    });

export const undoDeleteThread = authMutation
    .use(rateLimit("chat/update"))
    .input({
        threadId: v.id("threads"),
    })
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread || thread.userId !== userId) {
            throwForbidden("Not allowed");
        }

        await context.runMutation(internal.agent.threads.restoreThread, {
            threadId: threadId as Id<"threads">,
        });

        // Record audit history for restore
        const restoredThread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

        if (restoredThread) {
            await context.runMutation(internal.lib.document_history.recordHistory, {
                attribution: { action: "update", metadata: { restored: true }, source: "manual" },
                doc: restoredThread,
                documentId: threadId,
                isDeleted: false,
                oldDoc: thread,
                organizationId: restoredThread.organizationId ?? undefined,
                tableName: "threads",
                userId,
            });
        }

        context.log.event("chat.undo_delete_thread", { restored: true });
    });

// Tag functions removed — replaced by auto-categorization.
// Thread categories are now set automatically via createCategoryChat.

// ── Browser session queries ─────────────────────────────────────────────
// Exposes browser session and action data so the frontend can show a live
// browser task panel with screenshots, action log, and session controls.

/**
 * Get the active browser session for a thread.
 * Returns null if no active session exists.
 */
export const getBrowserSession = authQuery
    .input({
        threadId: v.id("threads"),
    })
    .query(async ({ args: { threadId }, ctx: context }) => {
        const session = await context.runQuery(internal.browser.functions.getActiveSession, {
            threadId: threadId as Id<"threads">,
        });

        if (!session) {
            return null;
        }

        // Verify ownership
        if (session.userId !== context.user.userId) {
            return null;
        }

        // Strip sensitive fields (connectUrl, providerSessionId)
        return {
            _creationTime: session._creationTime,
            _id: session._id,
            currentUrl: session.currentUrl,
            errorMessage: session.errorMessage,
            lastActivityAt: session.lastActivityAt,
            startedAt: session.startedAt,
            status: session.status,
            threadId: session.threadId,
        };
    });

/**
 * Get browser actions for a session, ordered by timestamp.
 * Returns the most recent actions (up to 50).
 */
// Projection of `browserActions` rows: `success` is stored as a number and
// surfaced as a boolean, and the session/user columns are deliberately dropped.
export const getBrowserActions = authQuery
    .input({
        sessionId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.array(
            v.object({
                _id: v.id("browserActions"),
                action: v.union(
                    v.literal("navigate"),
                    v.literal("screenshot"),
                    v.literal("click"),
                    v.literal("type"),
                    v.literal("extract"),
                    v.literal("scroll"),
                ),
                durationMs: v.optional(v.number()),
                errorMessage: v.optional(v.string()),
                success: v.boolean(),
                target: v.optional(v.string()),
                timestamp: v.number(),
                value: v.optional(v.string()),
            }),
        ),
    )
    .query(async ({ args: { sessionId }, ctx: context }) => {
        // Verify session ownership
        const session = await context.db.get(sessionId as Id<"browserSessions">);

        if (!session || session.userId !== context.user.userId) {
            return [];
        }

        const actions = await context.db
            .query("browserActions")
            .withIndex("by_sessionId_timestamp", (q: any) => q.eq("sessionId", sessionId as Id<"browserSessions">))
            .order("desc")
            .take(50);

        // Return in chronological order
        return actions.toReversed().map((a) => {
            return {
                _id: a._id,
                action: a.action,
                durationMs: a.durationMs,
                errorMessage: a.errorMessage,
                success: a.success === 1,
                target: a.target,
                timestamp: a.timestamp,
                value: a.value,
            };
        });
    });

/**
 * Terminate an active browser session.
 */
export const terminateBrowserSession = authMutation
    .use(rateLimit("chat/update"))
    .input({
        sessionId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args: { sessionId }, ctx: context }) => {
        const session = await context.db.get(sessionId as Id<"browserSessions">);

        if (!session || session.userId !== context.user.userId) {
            throw new LunoraError("FORBIDDEN", "Not allowed");
        }

        if (session.status !== "active") {
            return;
        }

        await patchBrowserSession(context.db, sessionId as Id<"browserSessions">, {
            completedAt: context.now,
            lastActivityAt: context.now,
            status: "terminated",
        });
        context.log.event("chat.terminate_browser_session", { terminated: true });
    });

/**
 * Update browser settings (domain allowlist/blocklist).
 */
export const updateBrowserSettings = authMutation
    .use(rateLimit("chat/update"))
    .input({
        browserSettings: v.object({
            domainAllowlist: v.optional(v.array(v.string().max(MAX_LENGTH.long))),
            domainBlocklist: v.optional(v.array(v.string().max(MAX_LENGTH.long))),
            enabled: v.optional(v.boolean()),
        }),
    })
    .mutation(async ({ args: { browserSettings }, ctx: context }) => {
        const { userId } = context.user;

        // Find or create aiUserPreferences
        const prefs = await context.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q: any) => q.eq("userId", userId))
            .first();

        await saveAiUserPreferences(context.db, prefs, userId, { browserSettings });
        context.log.event("chat.update_browser_settings", {
            allowlistCount: browserSettings.domainAllowlist?.length ?? 0,
            blocklistCount: browserSettings.domainBlocklist?.length ?? 0,
            enabledSet: browserSettings.enabled !== undefined,
        });
    });

/**
 * Get browser settings for the current user.
 */
// Mirrors `aiUserPreferences.browserSettings`; every field stays optional because
// a stored value may predate any of them, and only the fallback fills all three.
export const getBrowserSettings = authQuery
    .input({})
    .output(
        v.object({
            domainAllowlist: v.optional(v.array(v.string())),
            domainBlocklist: v.optional(v.array(v.string())),
            enabled: v.optional(v.boolean()),
        }),
    )
    .query(async ({ ctx: context }) => {
        const prefs = await context.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q: any) => q.eq("userId", context.user.userId))
            .first();

        return prefs?.browserSettings ?? { domainAllowlist: [], domainBlocklist: [], enabled: true };
    });

// ── Browser Extension API (Phase 2) ────────────────────────────────────

/**
 * Generate a pairing code for a new browser extension.
 */
export const createExtensionPairing = authMutation
    .use(rateLimit("chat/create"))
    .input({})
    .mutation(async ({ ctx: context }) => {
        const result = await context.runMutation(internal.browser.functions.createExtensionPairing, {
            userId: context.user.userId,
        });

        context.log.event("chat.create_extension_pairing", { issued: true });

        return { pairingCode: result.pairingCode };
    });

/**
 * Get the user's paired browser extensions.
 */
// `getUserExtensions` only ever returns rows with status "paired", but the
// column is a three-way union and nothing narrows it, so keep the full union.
export const getBrowserExtensions = authQuery
    .input({})
    .output(
        v.array(
            v.object({
                _id: v.id("browserExtensions"),
                browserInfo: v.optional(v.string()),
                capabilities: v.optional(v.array(v.string())),
                extensionVersion: v.optional(v.string()),
                lastSeenAt: v.optional(v.number()),
                pairedAt: v.optional(v.number()),
                status: v.union(v.literal("pending"), v.literal("paired"), v.literal("revoked")),
            }),
        ),
    )
    .query(async ({ ctx: context }) => {
        const extensions = await context.runQuery(internal.browser.functions.getUserExtensions, {
            userId: context.user.userId,
        });

        // Strip internal fields
        return extensions.map((extension) => {
            return {
                _id: extension._id,
                browserInfo: extension.browserInfo,
                capabilities: extension.capabilities,
                extensionVersion: extension.extensionVersion,
                lastSeenAt: extension.lastSeenAt,
                pairedAt: extension.pairedAt,
                status: extension.status,
            };
        });
    });

/**
 * Revoke a paired browser extension.
 */
export const revokeExtension = authMutation
    .use(rateLimit("chat/delete"))
    .input({
        extensionId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(
        async ({ args: { extensionId }, ctx: context }) => {
            const result = await context.runMutation(internal.browser.functions.revokeExtension, {
                extensionDocId: extensionId as Id<"browserExtensions">,
                userId: context.user.userId,
            });

            context.log.event("chat.revoke_extension", { revoked: true });

            return result;
        },
    );

export const updateThreadDictationLanguage = authMutation
    .use(rateLimit("chat/update"))
    .input({
        dictationLanguage: v.optional(v.string().max(MAX_LENGTH.short)),
        threadId: v.id("threads"),
    })
    .mutation(async ({ args: { dictationLanguage, threadId }, ctx: context }): Promise<undefined> => {
        const { userId } = context.user;
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread) {
            return throwThreadNotFound();
        }

        if (thread.userId !== userId) {
            throwForbidden("Not allowed");
        }

        await context.runMutation(internal.agent.threads.updateThreadSettings, {
            patch: {
                dictationLanguage,
            } as never,
            threadId: threadId as Id<"threads">,
        });

        context.log.event("chat.update_thread_dictation_language", { cleared: dictationLanguage === undefined });

        return undefined;
    });

export const updateThreadLanguage = authMutation
    .use(rateLimit("chat/update"))
    .input({
        language: v.optional(v.string().max(MAX_LENGTH.short)),
        threadId: v.id("threads"),
    })
    .mutation(async ({ args: { language, threadId }, ctx: context }): Promise<undefined> => {
        const { userId } = context.user;
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread) {
            throwThreadNotFound();
        }

        if (thread && thread.userId !== userId) {
            throwForbidden("Not allowed");
        }

        await context.runMutation(internal.agent.threads.updateThreadSettings, {
            patch: {
                language,
            } as never,
            threadId: threadId as Id<"threads">,
        });

        context.log.event("chat.update_thread_language", { cleared: language === undefined });

        return undefined;
    });

export const updateThreadMode = authMutation
    .use(rateLimit("chat/update"))
    .input({
        mode: v.union(v.literal("text"), v.literal("image"), v.literal("video")),
        threadId: v.id("threads"),
    })
    .mutation(async ({ args: { mode, threadId }, ctx: context }): Promise<undefined> => {
        const { userId } = context.user;
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, {
            threadId: threadId as Id<"threads">,
        });

        if (!thread) {
            throwThreadNotFound();
        }

        if (thread && thread.userId !== userId) {
            throwForbidden("Not allowed");
        }

        await context.runMutation(internal.agent.threads.updateThreadSettings, {
            patch: {
                mode,
            } as never,
            threadId: threadId as Id<"threads">,
        });

        context.log.event("chat.update_thread_mode", { mode });

        return undefined;
    });

export const getAnonymousMessageLimit = publicQuery
    .input({ now: v.number() })
    .output(v.union(v.object({ limit: v.number(), remaining: v.number() }), v.null()))
    .query(async ({ args, ctx: context }): Promise<{ limit: number; remaining: number } | null> => {
        const identity = await getAuthUserIdentity(context);

        if (!identity) {
            return null;
        }

        // Fetch user document to check isAnonymous flag
        const userDocument = await context.db.user.findFirst({ where: { _id: identity.userId } });

        if (!userDocument || !("isAnonymous" in userDocument) || userDocument.isAnonymous !== true) {
            return null;
        }

        const userId = String(identity.userId);

        if (!userId) {
            return null;
        }

        const limit = 10;

        let used = 0;

        try {
            const limiter = createRatelimit("chat/dailyText:anonymous", context.db as never, "open", () => args.now);
            const { remaining, reset } = await limiter.getRemaining(userId);
            const { now } = args;

            if (now < reset) {
                used = Math.max(0, limit - remaining);
            }
        } catch {
            used = limit;
        }

        return {
            limit,
            remaining: Math.max(0, limit - used),
        };
    });

/**
 * Get daily content limits for users by content type.
 * Returns capacity and remaining for text, video, audio, and image.
 * Uses fixed window daily limits per tier.
 */
export const getMessageRateLimit = optionalAuthQuery
    .input({ now: v.number() })
    .output(
        v.union(
            v.object({
                audio: v.object({ capacity: v.number(), remaining: v.number() }),
                image: v.object({ capacity: v.number(), remaining: v.number() }),
                text: v.object({ capacity: v.number(), remaining: v.number() }),
                tier: v.union(v.literal("anonymous"), v.literal("free"), v.literal("premium")),
                video: v.object({ capacity: v.number(), remaining: v.number() }),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx: context }): Promise<ContentTypeLimits | null> => {
        const { user } = context;

        if (!user) {
            return null;
        }

        // Admin users have no rate limits
        const isAdmin = (user as unknown as { role?: string }).role === "admin";

        if (isAdmin) {
            return null;
        }

        const isAnonymous = (user as unknown as { isAnonymous?: boolean }).isAnonymous === true;
        const { userId } = user;

        if (!userId) {
            return null;
        }

        const paidTier = getUserTier(user) === "premium" ? "premium" : "free";
        const tier: "anonymous" | "free" | "premium" = isAnonymous ? "anonymous" : paidTier;

        const capacities = CONTENT_CAPACITIES[tier];

        const getContentTypeUsage = async (contentType: "text" | "video" | "audio" | "image"): Promise<ContentTypeLimit> => {
            const capacity = capacities[contentType];

            if (capacity === 0) {
                return { capacity: 0, remaining: 0 };
            }

            const rateLimitKey = `chat/daily${contentType.charAt(0).toUpperCase() + contentType.slice(1)}:${tier}`;

            let used = 0;

            try {
                const limiter = createRatelimit(rateLimitKey, context.db as never, "open", () => args.now);
                const { remaining, reset } = await limiter.getRemaining(userId);
                const { now } = args;

                if (now < reset) {
                    used = Math.max(0, capacity - remaining);
                }
            } catch {
                used = capacity;
            }

            return {
                capacity,
                remaining: Math.max(0, capacity - used),
            };
        };

        const [text, video, audio, image] = await Promise.all([
            getContentTypeUsage("text"),
            getContentTypeUsage("video"),
            getContentTypeUsage("audio"),
            getContentTypeUsage("image"),
        ]);

        return {
            audio,
            image,
            text,
            tier,
            video,
        };
    });

/**
 * Query to get cached follow-up suggestions for a thread.
 * This is reactive and will update when new suggestions are cached.
 */
export const getCachedFollowupSuggestions = authQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(v.object({ lastMessageId: v.optional(v.string()), suggestions: v.array(v.string()) }))
    .query(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;

        // Use validateThreadAccessWithData for single-call auth + thread validation
        await validateThreadAccessWithData(context, threadId, userId, "read");

        const cached = await context.runQuery(internal.agent.followup_suggestions.getCachedFollowupSuggestions, {
            threadId,
        });

        if (!cached) {
            return { suggestions: [] };
        }

        return {
            lastMessageId: cached.lastMessageId,
            suggestions: cached.suggestions,
        };
    });

/**
 * Action to generate follow-up suggestions for a thread.
 * Can be called from the frontend to get suggestions after a message.
 */
export const getFollowupSuggestions = authAction
    // An LLM call per invocation; it had no limit at all.
    .use(rateLimit("chat/followups"))
    .input({
        threadId: v.id("threads"),
    })
    .output(v.object({ suggestions: v.array(v.string()) }))
    .action(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;

        // Use validateThreadAccessWithData to combine access check + thread fetch in one call
        const { thread: threadData } = await validateThreadAccessWithData(context, threadId, userId, "read");

        const threadLanguage = threadData?.language;

        const { language: userLanguage, location, timezone } = await context.runQuery(internal.auth.functions.getUserPreferencesQuery, { userId });
        const language = threadLanguage || userLanguage;

        const agent = await getAgentForUser(context, userId, DEFAULT_FOLLOWUP_SUGGESTIONS_MODEL as string, language);

        const messagesResult = await agent.listMessages(context, {
            paginationOpts: { cursor: null, numItems: 10 },
            threadId,
        });

        const filteredMessageDocuments = (messagesResult.page || []).filter((messageDocument) => {
            const role = messageDocument.message?.role;

            return role === "user" || role === "assistant";
        });

        // Messages are returned in descending order (newest first), so the first element is the latest
        const lastMessageId = filteredMessageDocuments.length > 0 ? (filteredMessageDocuments[0]?._id ?? null) : null;

        if (lastMessageId) {
            const cached = await context.runQuery(internal.agent.followup_suggestions.getCachedFollowupSuggestions, {
                threadId,
            });

            if (cached && cached.lastMessageId === lastMessageId) {
                context.log.event("chat.get_followup_suggestions", { cacheHit: true, suggestionCount: cached.suggestions.length });

                return {
                    suggestions: cached.suggestions,
                };
            }
        }

        const modelMessages = docsToModelMessages(filteredMessageDocuments);

        const output = await generateFollowupSuggestionsInternal(modelMessages, agent.options.languageModel as LanguageModel, language, timezone, location);

        if (lastMessageId) {
            await context.runMutation(internal.agent.followup_suggestions.cacheFollowupSuggestions, {
                lastMessageId,
                suggestions: output.suggestions,
                threadId,
            });
        }

        context.log.event("chat.get_followup_suggestions", { cacheHit: false, suggestionCount: output.suggestions.length });

        return {
            suggestions: output.suggestions,
        };
    });

export const generateFollowupSuggestionsForThread = internalAction
    .input({
        threadId: v.string(),
        userId: v.string(),
    })
    .action(async ({ args: { threadId, userId }, ctx: context }) => {
        chatLogger.debug(`[generateFollowupSuggestionsForThread] Starting`, { threadId, userId });

        try {
            const threadData = await context.runQuery(internal.agent.threads.getThreadInternal, {
                threadId: threadId as Id<"threads">, // Cast to any for component query compatibility
            });

            if (!threadData) {
                chatLogger.warn(`[generateFollowupSuggestionsForThread] Thread not found: ${threadId}`);

                return;
            }

            chatLogger.debug(`[generateFollowupSuggestionsForThread] Thread found`, { language: threadData?.language, threadId });

            const threadLanguage = threadData?.language;

            const { language: userLanguage, location, timezone } = await context.runQuery(internal.auth.functions.getUserPreferencesQuery, { userId });
            const language = threadLanguage || userLanguage;

            const agent = await getAgentForUser(context, userId, DEFAULT_FOLLOWUP_SUGGESTIONS_MODEL as string, language);

            const messagesResult = await agent.listMessages(context, {
                paginationOpts: { cursor: null, numItems: 10 },
                threadId,
            });

            const filteredMessageDocuments = (messagesResult.page || []).filter((messageDocument) => {
                const role = messageDocument.message?.role;

                return role === "user" || role === "assistant";
            });

            // Messages are returned in descending order (newest first), so the first element is the latest
            const lastMessageId = filteredMessageDocuments.length > 0 ? (filteredMessageDocuments[0]?._id ?? null) : null;

            if (!lastMessageId) {
                chatLogger.warn(`[generateFollowupSuggestionsForThread] No messages found for thread: ${threadId}`);

                return;
            }

            chatLogger.debug(`[generateFollowupSuggestionsForThread] Last message found`, {
                lastMessageId,
                messageCount: filteredMessageDocuments.length,
                threadId,
            });

            // Check cache first
            const cached = await context.runQuery(internal.agent.followup_suggestions.getCachedFollowupSuggestions, {
                threadId,
            });

            if (cached && cached.lastMessageId === lastMessageId) {
                chatLogger.debug(`[generateFollowupSuggestionsForThread] Already cached for this message`, { lastMessageId, threadId });

                return;
            }

            chatLogger.debug(`[generateFollowupSuggestionsForThread] Generating new suggestions`, {
                cachedMessageId: cached?.lastMessageId,
                hasCached: !!cached,
                threadId,
            });

            const modelMessages = docsToModelMessages(filteredMessageDocuments);

            const output = await generateFollowupSuggestionsInternal(modelMessages, agent.options.languageModel as LanguageModel, language, timezone, location);

            // Cache the suggestions
            await context.runMutation(internal.agent.followup_suggestions.cacheFollowupSuggestions, {
                lastMessageId,
                suggestions: output.suggestions,
                threadId,
            });

            chatLogger.info(`[generateFollowupSuggestionsForThread] Generated ${output.suggestions.length} suggestions for thread: ${threadId}`);
        } catch (error) {
            chatLogger.error(`[generateFollowupSuggestionsForThread] Error generating suggestions:`, error);
        }
    });

export const streamAsync = internalAction
    .input({
        customSystemPrompt: v.optional(v.string()),
        enabledFeatures: v.optional(v.array(v.string())),
        /** Set by `runJobOnce` when `/chat/edit` enqueues this; nothing reads it. */
        jobId: v.optional(v.string()),
        messageId: v.string(),
        model: v.string(),
        parentId: v.optional(v.string()),
        prompt: v.optional(v.string()),
        reasoningEffort: v.optional(v.number()),
        statelessMode: v.optional(v.boolean()),
        threadId: v.string(),
    })
    .output(v.null())
    .action(async ({ args, ctx: context }) => {
        const streamAsyncStartTime = Date.now();

        streamLogger.debug(`[ASYNC] streamAsync started`, {
            messageId: args.messageId,
            model: args.model,
            threadId: args.threadId,
            timestamp: streamAsyncStartTime,
        });

        const { customSystemPrompt, messageId, model, prompt, reasoningEffort, statelessMode, threadId } = args;

        // Get thread to find userId
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

        if (!thread) {
            throw new LunoraError("BAD_REQUEST", `Thread ${threadId} not found`);
        }

        const { userId } = thread;

        if (!userId) {
            throw new LunoraError("BAD_REQUEST", `Thread ${threadId} has no userId`);
        }

        // Get user preferences
        const { language: userLanguage } = await context.runQuery(internal.auth.functions.getUserPreferencesQuery, { userId });
        const threadLanguage = thread.language;
        const effectiveLanguage = threadLanguage || userLanguage;

        const agent = await getAgentForUser(context, userId, model as string, effectiveLanguage);
        const threadResult = await agent.continueThread(context, { threadId, userId });
        const threadObject = threadResult.thread || threadResult;

        // Get thread settings
        const appThread = await context.runQuery(internal.chat.functions.getThreadSettings, { threadId });
        const threadReasoningEffort = appThread?.reasoningEffort ?? reasoningEffort;
        const threadStatelessMode = appThread?.statelessMode ?? statelessMode;
        const threadCustomSystemPrompt = appThread?.customSystemPrompt ?? customSystemPrompt;
        let projectContext: string | undefined;

        if (appThread?.projectId) {
            const project = await context.runQuery(api.agent.projects.getProject, {
                projectId: appThread.projectId as Id<"projects">,
            });

            projectContext = project?.context;
        }

        // Get model definition
        const modelDefinition = MODEL_LOOKUP.get(model);
        const supportsReasoningEffort =
            modelDefinition?.filterCapabilities?.includes("effort_control") || modelDefinition?.filterCapabilities?.includes("reasoning");

        // Provider-keyed, because that is what the AI SDK and the gateway's
        // `filterProviderOptions` index. See `lib/reasoning-options.ts` for the
        // three separate reasons the previous flat bag never reached a provider.
        const primaryProvider = modelDefinition?.provider?.replace(INTERNAL_PREFIX_RE, "") || "";
        const providerOptions: Record<string, Record<string, unknown>> = buildReasoningProviderOptions(
            threadReasoningEffort,
            primaryProvider,
            supportsReasoningEffort,
        ) ?? {};

        // `enabledFeatures` is not a provider option and never was: no provider
        // allowlists it, so nesting it under one would only get it stripped. It
        // stays out of this bag until something actually consumes it.

        // Prepare streamText arguments
        const streamTextArgs: any = Object.keys(providerOptions).length > 0 ? { providerOptions } : {};

        if (threadStatelessMode) {
            streamTextArgs.prompt = prompt;
        } else {
            streamTextArgs.promptMessageId = messageId;
        }

        // Build effective system prompt - combine base instructions with additional context
        if (projectContext || threadCustomSystemPrompt) {
            const baseInstructions = agent.options.instructions || "";
            const additionalParts: string[] = [];

            if (projectContext) {
                additionalParts.push(`PROJECT CONTEXT:\n${projectContext}`);
            }

            if (threadCustomSystemPrompt) {
                additionalParts.push(`ADDITIONAL INSTRUCTIONS:\n${threadCustomSystemPrompt}`);
            }

            const additionalContext = additionalParts.join("\n\n");

            streamTextArgs.system = baseInstructions ? `${baseInstructions}\n\n${additionalContext}` : additionalContext;
        }

        // Stream with deltas saved to database
        streamLogger.debug(`[ASYNC] Starting streamText`, {
            elapsedMs: Date.now() - streamAsyncStartTime,
            hasSystemPrompt: !!streamTextArgs.system,
            messageId,
            statelessMode: threadStatelessMode,
            threadId,
        });

        const result = await threadObject.streamText(streamTextArgs, {
            saveStreamDeltas: {
                chunking: "word",
                throttleMs: 0, // No batching delay - stream immediately
            },
            statelessMode: threadStatelessMode,
        });

        streamLogger.debug(`[ASYNC] streamText returned, consuming stream`, {
            elapsedMs: Date.now() - streamAsyncStartTime,
            messageId,
            threadId,
        });

        // Consume the stream to ensure it completes
        await result.consumeStream();

        context.log.event("chat.stream_async", { model, statelessMode: threadStatelessMode ?? false });

        streamLogger.debug(`[ASYNC] Stream consumed, action complete`, {
            messageId,
            threadId,
            totalElapsedMs: Date.now() - streamAsyncStartTime,
        });

        // Declared `.output(v.null())`; return it rather than falling off the
        // end, which yields `undefined` and does not match the contract.
        return null;
    });

/**
 * Abort a streaming message by messageId.
 * This is called when the user presses pause/cancel in the composer.
 * The messageId should be the user message that triggered the stream.
 * The stream is associated with the order of the user message.
 */
export const abortStreamByMessageId = authMutation
    .use(rateLimit("chat/update"))
    .input({
        messageId: v.string().max(MAX_LENGTH.id),
        threadId: v.id("threads"),
    })
    .output(v.object({ aborted: v.boolean() }))
    .mutation(async ({ args: { messageId, threadId }, ctx: context }) => {
        const { userId } = context.user;

        await validateThreadAccess(context, threadId, userId, "write");

        // Get the message to find its order
        const messages = await context.runQuery(internal.agent.messages.getMessagesByIds, {
            messageIds: [messageId as Id<"messages">],
        });
        const message = messages[0];

        if (!message) {
            throw new LunoraError("NOT_FOUND", `Message ${messageId} not found`);
        }

        // Verify the message belongs to this thread
        if (message.threadId !== threadId) {
            throw new LunoraError("BAD_REQUEST", `Message ${messageId} does not belong to thread ${threadId}`);
        }

        // Get the order - streams are associated with the order of the user message
        const { order } = message;

        if (order === undefined || order < 0) {
            throw new LunoraError("BAD_REQUEST", `Cannot determine order for message ${messageId}`);
        }

        // Abort the stream by order
        const aborted = await context.runMutation(internal.agent.streams.abortByOrder, {
            order,
            reason: "Aborted by user",
            threadId: threadId as Id<"threads">,
        });

        context.log.event("chat.abort_stream_by_message_id", { aborted });

        return { aborted };
    });

/**
 * A media reply's pending row. Given the prompt it answers, it is saved at that
 * prompt's turn as a fresh reply — a sibling of any earlier one, exactly like a
 * text regenerate (`failPendingSteps` is what marks it as a new reply) — rather
 * than appended to whatever turn happens to be last.
 */
const savePendingMediaMessage = async (
    agent: Awaited<ReturnType<typeof getAgentForUser>>,
    context: ActionContext,
    args: Parameters<Awaited<ReturnType<typeof getAgentForUser>>["saveMessage"]>[1],
): Promise<{ messageId: string }> => {
    if (!args.promptMessageId || !args.message || !args.metadata) {
        return await agent.saveMessage(context, args);
    }

    const { messages } = await agent.saveMessages(context, {
        failPendingSteps: true,
        messages: [args.message],
        metadata: [args.metadata],
        promptMessageId: args.promptMessageId,
        threadId: args.threadId,
    });
    const saved = messages.at(-1);

    if (!saved) {
        throw new LunoraError("INTERNAL_SERVER_ERROR", "Failed to save the pending media message");
    }

    return { messageId: saved._id };
};

export const generateImage = internalAction
    .input({
        cinemaSettings: v.optional(vCinemaSettings),
        imageSize: v.string(),
        /** Set by `lib/job-once.ts:runJobOnce` on the jobs queue; stamped on the pending row so a dead delivery's row can be failed (`chat/media-abandon.ts`). */
        jobId: v.optional(v.string()),
        model: v.string(),
        negativePrompt: v.optional(v.string()),
        numImages: v.optional(v.number()),
        prompt: v.string(),
        /** The prompt this is a reply to. Set by `/chat/media`, so a regenerate becomes a sibling reply (`agent/branch-tree.ts`). */
        promptMessageId: v.optional(v.id("messages")),
        referenceImages: v.optional(v.array(v.string())),
        seed: v.optional(v.number()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            assets: v.array(
                v.object({
                    imageSize: v.string(),
                    imageUrl: v.string(),
                    mimeType: v.string(),
                }),
            ),
            modelId: v.string(),
            prompt: v.string(),
        }),
    )
    .action(
        async ({
            args: {
                cinemaSettings,
                imageSize,
                jobId,
                model,
                negativePrompt,
                numImages: numberImages = 1,
                prompt,
                promptMessageId,
                referenceImages,
                seed,
                threadId,
                userId,
            },
            ctx: context,
        }) => {
            // Reference-image payload guard. The internalAction validator only pins
            // `Array<string>`; tighten here so a malformed payload errors at the
            // boundary instead of inside FAL.
            if (referenceImages !== undefined) {
                if (referenceImages.length > MAX_REFERENCE_IMAGES) {
                    throw new LunoraError("BAD_REQUEST", `referenceImages exceeds the cap of ${MAX_REFERENCE_IMAGES}`);
                }

                for (const url of referenceImages) {
                    try {
                        // eslint-disable-next-line no-new
                        new URL(url);
                    } catch {
                        throw new LunoraError("BAD_REQUEST", "referenceImages contains a malformed URL");
                    }
                }
            }

            const agent = await getAgentForUser(context, userId, model);
            const { languageModel } = agent.options;

            if (!languageModel || typeof languageModel !== "object" || !("provider" in languageModel) || !("modelId" in languageModel)) {
                throw new LunoraError("BAD_REQUEST", "Agent languageModel must have provider and modelId properties");
            }

            const modelDefinition = MODEL_LOOKUP.get(model);

            if (!modelDefinition || modelDefinition.mode !== "image") {
                throw new LunoraError("BAD_REQUEST", `Model ${model} is not an image generation model`);
            }

            const normalizedImageSize = normalizeImageSize(imageSize, modelDefinition);
            const { modelId, provider } = languageModel as { modelId: string; provider: string };
            const { aspectRatio, size } = parseImageSizeParams(normalizedImageSize);

            // Enhance prompt with cinema settings if provided
            const enhancedPrompt = buildCinemaPrompt(prompt, cinemaSettings);

            // Create pending message to show user that generation is in progress
            // Use special text marker that Streamdown can detect and render with a loading animation
            const { messageId: pendingMessageId } = await savePendingMediaMessage(agent, context, {
                message: {
                    content: [{ text: "__IMAGE_GENERATING__", type: "text" }],
                    role: "assistant",
                },
                metadata: {
                    model,
                    providerMetadata: mediaJobStamp(jobId),
                    status: "pending",
                },
                promptMessageId,
                threadId,
            });

            try {
                let images: { mimeType?: string; uint8Array: Uint8Array }[] = [];
                let warnings: any[] | undefined;
                let providerMetadata: any;

                // Build FAL reference-image fragment once. Only applied on the FAL
                // path below — OpenRouter routes models (e.g. Gemini Flash Image)
                // that take refs as inline image content parts, not as provider-
                // level `image_url`/`image_urls`, so spreading FAL fields there is
                // a no-op at best and a foot-gun at worst.
                const referenceImageInput = buildFalReferenceImageInput(modelDefinition, referenceImages);

                if (provider === "openrouter") {
                    const baseProviderOptions = {};
                    const imageConfig = aspectRatio ? { aspect_ratio: aspectRatio } : {};
                    const openrouterOptions = {
                        ...baseProviderOptions,
                        ...imageConfig,
                        modalities: ["image", "text"],
                        ...(negativePrompt && { negative_prompt: negativePrompt }),
                        ...(seed !== undefined && { seed }),
                    };

                    chatLogger.debug("[image_generation] Calling generateText x", numberImages, "with:", {
                        aspectRatio,
                        modelId,
                        numImages: numberImages,
                        prompt: prompt.slice(0, 100),
                    });

                    // Use parallel calls so each produces a unique image (a single call with
                    // "Generate N images:" in the prompt yields identical outputs).
                    const results = await Promise.all(
                        Array.from({ length: numberImages }, () =>
                            generateText({
                                model: languageModel as LanguageModel,
                                prompt: `Generate an image: ${enhancedPrompt}`,
                                providerOptions: { openrouter: openrouterOptions },
                            }),
                        ),
                    );

                    for (const result of results) {
                        // Primary source: result.files — AI SDK standard for file-producing models
                        const resultFiles = result.files;

                        if (resultFiles.length > 0) {
                            const extracted = resultFiles
                                .filter((f) => f.mediaType.startsWith("image/"))
                                .map((f) => {
                                    return { mimeType: f.mediaType, uint8Array: f.uint8Array };
                                });

                            images.push(...extracted);
                        } else {
                            // Fallback: legacy OpenRouter response message content parts
                            const assistantMessage = result.response.messages.at(-1);
                            const imageContent = assistantMessage?.content;

                            if (imageContent) {
                                const extracted = extractImagesFromOpenRouterResponse(imageContent);

                                images.push(...extracted);
                            }
                        }

                        warnings = result.warnings;
                        providerMetadata = result.providerMetadata;
                    }

                    chatLogger.debug("[image_generation] Extracted", images.length, "image(s) total");
                } else {
                    const imageModel = languageModel as unknown as ImageModelV2;
                    const providerName = provider;
                    const providerOptions: { image_url?: string; image_urls?: string[]; negative_prompt?: string } = {};

                    // Build provider-specific options
                    if (negativePrompt) {
                        providerOptions.negative_prompt = negativePrompt;
                    }

                    // FAL is the only provider with an `image_url`/`image_urls`
                    // contract on this path. Gating by providerName keeps a stale
                    // `maxReferenceImages` entry on a non-FAL registry row from
                    // leaking FAL-shaped fields into the wrong provider's call.
                    if (providerName === "fal") {
                        Object.assign(providerOptions, referenceImageInput);
                    }

                    const result = await aiGenerateImage({
                        model: imageModel,
                        prompt: enhancedPrompt,
                        ...(size ? { size } : { aspectRatio }),
                        n: numberImages,
                        ...(seed !== undefined && { seed }),
                        ...(Object.keys(providerOptions).length > 0 && providerName && { providerOptions: { [providerName]: providerOptions } }),
                    });

                    images = result.images || [];
                    warnings = result.warnings;
                    providerMetadata = result.providerMetadata;
                }

                if (images.length === 0) {
                    throw new LunoraError("BAD_REQUEST", "No images generated");
                }

                // Store all generated images
                const storedImages = await Promise.all(
                    images.map(async (image) => {
                        const mimeType = image.mimeType || "image/png";
                        const blob = createBlobFromImage(image.uint8Array, mimeType);
                        const { file, filePart } = await storeFile(context, blob, { threadId, userId });

                        return { file, filePart, mimeType };
                    }),
                );

                // Schedule NSFW checks for all generated images
                await Promise.all(
                    storedImages.map(({ file, mimeType }) =>
                        context.scheduler.runAfter(0, internal.agent.nsfw_check.checkImageNsfwForChatFile, {
                            fileId: file.fileId as Id<"chatFiles">,
                            mediaType: mimeType,
                            storageId: String(file.storageId),
                        }),
                    ),
                );

                // Serialize warnings to the format expected by the validator
                const serializedWarnings = warnings?.map((warning) => {
                    if (warning.type === "unsupported-setting") {
                        return {
                            details: warning.details,
                            setting: String(warning.setting),
                            type: "unsupported-setting" as const,
                        };
                    }

                    return warning;
                });

                // Update the pending message with the final result
                await agent.saveMessage(context, {
                    message: {
                        content: storedImages.map(({ filePart }) => filePart),
                        role: "assistant",
                    },
                    metadata: {
                        fileIds: storedImages.map(({ file }) => file.fileId),
                        model,
                        prompt,
                        providerMetadata,
                        warnings: serializedWarnings,
                    },
                    pendingMessageId,
                    threadId,
                });

                context.log.event("chat.generate_image", { imageCount: storedImages.length, imageSize: normalizedImageSize, model });

                return {
                    assets: storedImages.map(({ file, mimeType }) => {
                        return {
                            imageSize: normalizedImageSize,
                            imageUrl: file.url,
                            mimeType,
                        };
                    }),
                    modelId: model,
                    prompt,
                };
            } catch (error) {
                // Mark pending message as failed if it exists
                if (pendingMessageId) {
                    const errorMessage = error instanceof Error ? error.message : "Unknown error";

                    await agent.saveMessage(context, {
                        message: {
                            content: [{ text: `*Image generation failed: ${errorMessage}*`, type: "text" }],
                            role: "assistant",
                        },
                        metadata: {
                            error: errorMessage,
                            model,
                            status: "failed",
                        },
                        pendingMessageId,
                        threadId,
                    });
                }

                chatLogger.error("[cvx][image_generation] Error generating image:", error);
                throw new LunoraError("BAD_REQUEST", `Failed to generate image: ${error instanceof Error ? error.message : "Unknown error"}`);
            }
        },
    );

export const generateAudio = internalAction
    .input({
        /** Set by `lib/job-once.ts:runJobOnce` on the jobs queue; stamped on the pending row so a dead delivery's row can be failed (`chat/media-abandon.ts`). */
        jobId: v.optional(v.string()),
        model: v.string(),
        prompt: v.string(),
        /** The prompt this is a reply to. Set by `/chat/media`, so a regenerate becomes a sibling reply (`agent/branch-tree.ts`). */
        promptMessageId: v.optional(v.id("messages")),
        threadId: v.string(),
        userId: v.string(),
        voice: v.optional(v.string()),
    })
    .output(
        v.object({
            assets: v.array(
                v.object({
                    audioUrl: v.string(),
                    mimeType: v.string(),
                }),
            ),
            modelId: v.string(),
            prompt: v.string(),
        }),
    )
    .action(async ({ args: { jobId, model, prompt, promptMessageId, threadId, userId, voice }, ctx: context }) => {
        const agent = await getAgentForUser(context, userId, model);
        const { languageModel } = agent.options;

        if (!languageModel || typeof languageModel !== "object" || !("provider" in languageModel) || !("modelId" in languageModel)) {
            throw new LunoraError("BAD_REQUEST", "Agent languageModel must have provider and modelId properties");
        }

        // Create pending message to show user that generation is in progress
        const { messageId: pendingMessageId } = await savePendingMediaMessage(agent, context, {
            message: {
                content: [{ text: "__AUDIO_GENERATING__", type: "text" }],
                role: "assistant",
            },
            metadata: {
                model,
                providerMetadata: mediaJobStamp(jobId),
                status: "pending",
            },
            promptMessageId,
            threadId,
        });

        try {
            const speechModel = languageModel as unknown as SpeechModel;
            const result = await experimental_generateSpeech({
                model: speechModel,
                text: prompt,
                ...(voice && { voice }),
            });

            if (!result.audio || result.audio.uint8Array.length === 0) {
                throw new LunoraError("BAD_REQUEST", "No audio generated");
            }

            // GeneratedAudioFile has mediaType (from GeneratedFile) and format properties
            const mimeType = result.audio.mediaType || `audio/${result.audio.format || "mpeg"}`;
            const blob = createBlobFromImage(result.audio.uint8Array, mimeType);
            const { file, filePart } = await storeFile(context, blob, { threadId, userId });

            // Serialize warnings
            const serializedWarnings = result.warnings?.map((warning: any) => {
                if (warning.type === "unsupported-setting") {
                    return {
                        details: warning.details,
                        setting: String(warning.setting),
                        type: "unsupported-setting" as const,
                    };
                }

                return warning;
            });

            // Update the pending message with the final result
            await agent.saveMessage(context, {
                message: {
                    content: [filePart],
                    role: "assistant",
                },
                metadata: {
                    fileIds: [file.fileId],
                    model,
                    providerMetadata: result.providerMetadata,
                    warnings: serializedWarnings,
                },
                pendingMessageId,
                threadId,
            });

            return {
                assets: [
                    {
                        audioUrl: file.url,
                        mimeType,
                    },
                ],
                modelId: model,
                prompt,
            };
        } catch (error) {
            // Mark pending message as failed
            if (pendingMessageId) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";

                await agent.saveMessage(context, {
                    message: {
                        content: [{ text: `*Audio generation failed: ${errorMessage}*`, type: "text" }],
                        role: "assistant",
                    },
                    metadata: {
                        error: errorMessage,
                        model,
                        status: "failed",
                    },
                    pendingMessageId,
                    threadId,
                });
            }

            chatLogger.error("[cvx][audio_generation] Error generating audio:", error);
            throw new LunoraError("BAD_REQUEST", `Failed to generate audio: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
    });

export const generateVideo = internalAction
    .input({
        aspectRatio: v.optional(v.string()),
        cinemaSettings: v.optional(vCinemaSettings),
        duration: v.optional(v.number()),
        /** Set by `lib/job-once.ts:runJobOnce` on the jobs queue; stamped on the pending row so a dead delivery's row can be failed (`chat/media-abandon.ts`). */
        jobId: v.optional(v.string()),
        model: v.string(),
        prompt: v.string(),
        /** The prompt this is a reply to. Set by `/chat/media`, so a regenerate becomes a sibling reply (`agent/branch-tree.ts`). */
        promptMessageId: v.optional(v.id("messages")),
        startFrameUrl: v.optional(v.string()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            assets: v.array(
                v.object({
                    mimeType: v.string(),
                    videoUrl: v.string(),
                }),
            ),
            modelId: v.string(),
            prompt: v.string(),
        }),
    )
    .action(
        async ({ args: { aspectRatio, cinemaSettings, duration, jobId, model, prompt, promptMessageId, startFrameUrl, threadId, userId }, ctx: context }) => {
            const modelDefinition = MODEL_LOOKUP.get(model);

            if (!modelDefinition || modelDefinition.mode !== "video") {
                throw new LunoraError("BAD_REQUEST", `Model ${model} is not a video generation model`);
            }

            if (startFrameUrl && !modelDefinition.supportsImageToVideo) {
                throw new LunoraError(
                    "BAD_REQUEST",
                    `Model ${model} does not support image-to-video. Pick an I2V model (e.g. fal-ai/kling-video/v1.5/pro/image-to-video).`,
                );
            }

            const agent = await getAgentForUser(context, userId, model);

            // Create pending message to show user that generation is in progress
            const { messageId: pendingMessageId } = await savePendingMediaMessage(agent, context, {
                message: {
                    content: [{ text: "__VIDEO_GENERATING__", type: "text" }],
                    role: "assistant",
                },
                metadata: {
                    model,
                    providerMetadata: mediaJobStamp(jobId),
                    status: "pending",
                },
                promptMessageId,
                threadId,
            });

            try {
                // Enhance prompt with cinema settings if provided
                const enhancedPrompt = buildCinemaPrompt(prompt, cinemaSettings);

                let videoData: { mimeType?: string; uint8Array: Uint8Array } | null = null;
                let warnings: any[] | undefined;
                let providerMetadata: any;

                if (modelDefinition.provider === "fal") {
                    const falApiKey = process.env.FAL_API_KEY;

                    if (!falApiKey) {
                        throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
                    }

                    const endpoint = modelDefinition.modelApiId ?? model;
                    const falInput: FalRequestInput = {
                        prompt: enhancedPrompt,
                    };

                    if (startFrameUrl) {
                        falInput.image_url = startFrameUrl;
                    } else if (modelDefinition.supportsImageToVideo && !modelDefinition.supportsTextToVideo) {
                        throw new LunoraError("BAD_REQUEST", `Model ${model} requires a startFrameUrl (image-to-video only).`);
                    }

                    if (aspectRatio && aspectRatio !== "auto") {
                        falInput.aspect_ratio = aspectRatio;
                    }

                    if (duration !== undefined) {
                        falInput.duration = duration;
                    }

                    const falResult = await callFalApi<Parameters<typeof resolveFalVideoUrl>[0]>(endpoint, falInput, falApiKey);

                    const resolvedVideo = resolveFalVideoUrl(falResult);

                    if (!resolvedVideo) {
                        throw new LunoraError("BAD_REQUEST", "FAL response did not include a video URL");
                    }

                    const videoResponse = await fetchWithDeadline(resolvedVideo.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });

                    if (!videoResponse.ok) {
                        await videoResponse.body?.cancel();

                        throw new LunoraError("BAD_REQUEST", `Failed to download generated video: ${videoResponse.status}`);
                    }

                    const videoBuffer = await videoResponse.arrayBuffer();

                    videoData = {
                        mimeType: resolvedVideo.contentType,
                        uint8Array: new Uint8Array(videoBuffer),
                    };
                    providerMetadata = { fal: { endpoint } };
                } else if (modelDefinition.provider === "openrouter") {
                    const { languageModel } = agent.options;

                    if (!languageModel || typeof languageModel !== "object" || !("provider" in languageModel) || !("modelId" in languageModel)) {
                        throw new LunoraError("BAD_REQUEST", "Agent languageModel must have provider and modelId properties");
                    }

                    const baseProviderOptions = {};
                    const videoConfig: { aspect_ratio?: typeof aspectRatio; duration?: typeof duration } = {};

                    if (aspectRatio) {
                        videoConfig.aspect_ratio = aspectRatio;
                    }

                    if (duration !== undefined) {
                        videoConfig.duration = duration;
                    }

                    const result = await generateText({
                        model: languageModel as LanguageModel,
                        prompt: enhancedPrompt,
                        providerOptions: {
                            openrouter: {
                                ...baseProviderOptions,
                                modalities: ["video", "text"],
                                ...(Object.keys(videoConfig).length > 0 && { video_config: videoConfig }),
                            },
                        },
                    });

                    // Extract video from response (similar to image extraction)
                    const assistantMessage = result.response.messages.at(-1);
                    const responseContent = assistantMessage?.content;

                    if (Array.isArray(responseContent)) {
                        for (const part of responseContent) {
                            if (part.type !== "file") {
                                continue;
                            }

                            // AI SDK v5+ renamed `FilePart.mimeType` to `mediaType`; still
                            // accept the legacy key so a provider passthrough keeps working.
                            const mediaType = part.mediaType ?? (part as { mimeType?: string }).mimeType;

                            // Only inline base64 payloads can be decoded here; a URL/binary
                            // part is handled by the FAL path below.
                            if (!mediaType?.startsWith("video/") || typeof part.data !== "string") {
                                continue;
                            }

                            const uint8Array = Uint8Array.from(atob(part.data), (c) => c.codePointAt(0) ?? 0);

                            videoData = { mimeType: mediaType, uint8Array };
                            break;
                        }
                    }

                    warnings = result.warnings;
                    providerMetadata = result.providerMetadata;
                } else {
                    throw new LunoraError("BAD_REQUEST", `Video generation not supported for provider: ${modelDefinition.provider}`);
                }

                if (!videoData) {
                    throw new LunoraError("BAD_REQUEST", "No video generated");
                }

                const mimeType = videoData.mimeType || "video/mp4";
                const blob = createBlobFromImage(videoData.uint8Array, mimeType);
                const { file, filePart } = await storeFile(context, blob, { threadId, userId });

                // Serialize warnings
                const serializedWarnings = warnings?.map((warning: any) => {
                    if (warning.type === "unsupported-setting") {
                        return {
                            details: warning.details,
                            setting: String(warning.setting),
                            type: "unsupported-setting" as const,
                        };
                    }

                    return warning;
                });

                // Update the pending message with the final result
                await agent.saveMessage(context, {
                    message: {
                        content: [filePart],
                        role: "assistant",
                    },
                    metadata: {
                        fileIds: [file.fileId],
                        model,
                        providerMetadata,
                        warnings: serializedWarnings,
                    },
                    pendingMessageId,
                    threadId,
                });

                context.log.event("chat.generate_video", { model, mimeType });

                return {
                    assets: [
                        {
                            mimeType,
                            videoUrl: file.url,
                        },
                    ],
                    modelId: model,
                    prompt,
                };
            } catch (error) {
                // Mark pending message as failed
                if (pendingMessageId) {
                    const errorMessage = error instanceof Error ? error.message : "Unknown error";

                    await agent.saveMessage(context, {
                        message: {
                            content: [{ text: `*Video generation failed: ${errorMessage}*`, type: "text" }],
                            role: "assistant",
                        },
                        metadata: {
                            error: errorMessage,
                            model,
                            status: "failed",
                        },
                        pendingMessageId,
                        threadId,
                    });
                }

                chatLogger.error("[cvx][video_generation] Error generating video:", error);
                throw new LunoraError("BAD_REQUEST", `Failed to generate video: ${error instanceof Error ? error.message : "Unknown error"}`);
            }
        },
    );

// ============================================================================
// Music Generation Action (fal.ai)
// ============================================================================

/**
 * Submit a music render to FAL's queue API and poll until completion.
 * Music endpoints take a flat input body (no `{ input: ... }` wrapper),
 * unlike the `callFalApi` helper used by image/video generation.
 */
const runFalMusicGeneration = async (
    endpoint: string,
    inputs: FalRequestInput,
    apiKey: string,
): Promise<{ bytes: Uint8Array; mimeType: string; sampleRate?: number }> => {
    const submitResponse = await fetchWithDeadline(`https://queue.fal.run/${endpoint}`, {
        body: JSON.stringify(inputs),
        headers: {
            Authorization: `Key ${apiKey}`,
            "Content-Type": "application/json",
        },
        method: "POST",
    });

    if (!submitResponse.ok) {
        const text = await submitResponse.text().catch(() => "");

        throw new Error(`FAL submit failed (${submitResponse.status}): ${text.slice(0, 500)}`);
    }

    const submit = (await submitResponse.json()) as { response_url?: string; status_url?: string };

    if (!submit.status_url || !submit.response_url) {
        throw new Error("FAL submit returned malformed response (missing status_url / response_url)");
    }

    // 5-minute cap matches the gateway-side renderer.
    const deadline = Date.now() + 5 * 60 * 1000;

    while (Date.now() < deadline) {
        const statusResponse = await fetchWithDeadline(submit.status_url, {
            headers: { Authorization: `Key ${apiKey}` },
        });

        if (!statusResponse.ok) {
            const text = await statusResponse.text().catch(() => "");

            throw new Error(`FAL status poll failed (${statusResponse.status}): ${text.slice(0, 200)}`);
        }

        const status = (await statusResponse.json()) as { status?: string };

        if (status.status === "COMPLETED") {
            const resultResponse = await fetchWithDeadline(submit.response_url, {
                headers: { Authorization: `Key ${apiKey}` },
            });

            if (!resultResponse.ok) {
                await resultResponse.body?.cancel();

                throw new Error(`FAL response fetch failed: ${resultResponse.status}`);
            }

            const result = (await resultResponse.json()) as FalAudioResponse;
            const audio = extractFalAudioUrl(result);

            if (!audio) {
                throw new Error("FAL music response missing audio.url / audio_file.url");
            }

            const bytesResponse = await fetchWithDeadline(audio.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });

            if (!bytesResponse.ok) {
                await bytesResponse.body?.cancel();

                throw new Error(`FAL audio download failed: ${bytesResponse.status}`);
            }

            const buffer = await bytesResponse.arrayBuffer();

            return {
                bytes: new Uint8Array(buffer),
                mimeType: audio.contentType ?? bytesResponse.headers.get("content-type") ?? "audio/wav",
                sampleRate: audio.sampleRate,
            };
        }

        if (status.status === "FAILED" || status.status === "CANCELLED") {
            throw new Error(`FAL music render ${status.status.toLowerCase()}`);
        }

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 2000);
        });
    }

    throw new Error("FAL music render timed out");
};

export const generateMusic = internalAction
    .input({
        duration: v.optional(v.number()),
        model: v.string(),
        negativePrompt: v.optional(v.string()),
        prompt: v.string(),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            assets: v.array(
                v.object({
                    audioUrl: v.string(),
                    mimeType: v.string(),
                }),
            ),
            modelId: v.string(),
            prompt: v.string(),
        }),
    )
    .action(async ({ args: { duration, model, negativePrompt, prompt, threadId, userId }, ctx: context }) => {
        const modelDefinition = MODEL_LOOKUP.get(model);

        if (!modelDefinition || modelDefinition.mode !== "music") {
            throw new LunoraError("BAD_REQUEST", `Model ${model} is not a music generation model`);
        }

        if (modelDefinition.provider !== "fal") {
            throw new LunoraError("BAD_REQUEST", `Music generation not supported for provider: ${modelDefinition.provider}`);
        }

        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        const agent = await getAgentForUser(context, userId, model);

        const { messageId: pendingMessageId } = await agent.saveMessage(context, {
            message: {
                content: [{ text: "__MUSIC_GENERATING__", type: "text" }],
                role: "assistant",
            },
            metadata: {
                model,
                status: "pending",
            },
            threadId,
        });

        try {
            const endpoint = modelDefinition.modelApiId ?? model;
            const inputs: FalRequestInput = { prompt };

            if (negativePrompt && modelDefinition.supportsNegativePrompt) {
                inputs.negative_prompt = negativePrompt;
            }

            // Honour the model's max-duration cap silently rather than 422'ing.
            if (duration !== undefined) {
                const maxDuration = modelDefinition.maxMusicDurationSeconds;
                const clamped = maxDuration && maxDuration > 0 ? Math.min(duration, maxDuration) : duration;

                inputs.seconds_total = clamped;
            }

            const audio = await runFalMusicGeneration(endpoint, inputs, falApiKey);
            const blob = createBlobFromImage(audio.bytes, audio.mimeType);
            const { file, filePart } = await storeFile(context, blob, { threadId, userId });

            await agent.saveMessage(context, {
                message: {
                    content: [filePart],
                    role: "assistant",
                },
                metadata: {
                    fileIds: [file.fileId],
                    model,
                    providerMetadata: { fal: { endpoint, sampleRate: audio.sampleRate } },
                },
                pendingMessageId,
                threadId,
            });

            return {
                assets: [{ audioUrl: file.url, mimeType: audio.mimeType }],
                modelId: model,
                prompt,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";

            if (pendingMessageId) {
                await agent.saveMessage(context, {
                    message: {
                        content: [{ text: `*Music generation failed: ${errorMessage}*`, type: "text" }],
                        role: "assistant",
                    },
                    metadata: {
                        error: errorMessage,
                        model,
                        status: "failed",
                    },
                    pendingMessageId,
                    threadId,
                });
            }

            chatLogger.error("[cvx][music_generation] Error generating music:", error);
            throw new LunoraError("BAD_REQUEST", `Failed to generate music: ${errorMessage}`);
        }
    });

// ============================================================================
// Image Transformation Actions (fal.ai)
// ============================================================================

/**
 * Helper to call fal.ai REST API directly.
 */
const callFalApi = async <T>(endpoint: string, input: FalRequestInput, apiKey: string): Promise<T> => {
    const response = await fetchWithDeadline(`https://queue.fal.run/${endpoint}`, {
        body: JSON.stringify({ input }),
        headers: {
            Authorization: `Key ${apiKey}`,
            "Content-Type": "application/json",
        },
        method: "POST",
    });

    if (!response.ok) {
        const error = await response.text();

        throw new Error(`fal.ai API error: ${error}`);
    }

    // `Response.json()` is `Promise<unknown>` — every field read off it was an
    // error. These two shapes are the only parts of fal.ai's queue protocol this
    // function reads; the payload itself stays `T`, supplied by the caller.
    const result = (await response.json()) as { request_id?: string };

    // fal.ai returns a request_id for async operations, poll for result
    if (result.request_id) {
        return pollFalResult<T>(endpoint, result.request_id, apiKey);
    }

    return result as T;
};

/** The fields fal.ai's `/status` endpoint returns that we act on. */
interface FalQueueStatus {
    error?: string;
    status?: string;
}

const pollFalResult = async <T>(endpoint: string, requestId: string, apiKey: string, maxAttempts = 60): Promise<T> => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const response = await fetchWithDeadline(`https://queue.fal.run/${endpoint}/requests/${requestId}/status`, {
            headers: { Authorization: `Key ${apiKey}` },
        });

        const status = (await response.json()) as FalQueueStatus;

        if (status.status === "COMPLETED") {
            const resultResponse = await fetchWithDeadline(`https://queue.fal.run/${endpoint}/requests/${requestId}`, {
                headers: { Authorization: `Key ${apiKey}` },
            });

            return resultResponse.json() as Promise<T>;
        }

        if (status.status === "FAILED") {
            throw new Error(`fal.ai request failed: ${status.error ?? "Unknown error"}`);
        }

        // Wait 1 second between polls
        await new Promise((resolve) => {
            setTimeout(resolve, 1000);
        });
    }

    throw new Error("fal.ai request timed out");
};

export const generateImg2Img = internalAction
    .input({
        imageUrl: v.string(),
        model: v.optional(v.string()),
        negativePrompt: v.optional(v.string()),
        prompt: v.optional(v.string()),
        strength: v.optional(v.number()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            imageUrl: v.string(),
            mimeType: v.string(),
            model: v.string(),
        }),
    )
    .action(async ({ args: { imageUrl, model, negativePrompt, prompt, strength, threadId, userId }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        // Look up model in registry, default to flux-dev-img2img
        const modelId = model ?? "fal-ai/flux-dev-img2img";
        const modelDefinition = MODEL_LOOKUP.get(modelId);

        if (!modelDefinition) {
            throw new LunoraError("BAD_REQUEST", `Unknown model: ${modelId}`);
        }

        if (!modelDefinition.supportsImg2Img) {
            throw new LunoraError("BAD_REQUEST", `Model ${modelId} does not support image-to-image transformation`);
        }

        // Use modelApiId as the actual fal.ai endpoint
        const endpoint = modelDefinition.modelApiId ?? modelId;

        chatLogger.debug("[cvx][img2img] Starting transformation", { endpoint, modelId, prompt, strength });

        const input: FalRequestInput = {
            image_url: imageUrl,
            strength: strength ?? 0.75,
        };

        if (prompt) {
            input.prompt = prompt;
        }

        if (negativePrompt && modelDefinition.supportsNegativePrompt) {
            input.negative_prompt = negativePrompt;
        }

        const result = await callFalApi<{ images: { content_type?: string; url: string }[] }>(endpoint, input, falApiKey);

        if (!result.images || result.images.length === 0) {
            throw new LunoraError("BAD_REQUEST", "No images generated");
        }

        // Store the generated image. Bound once: `result.images[0]` is
        // possibly-undefined under `noUncheckedIndexedAccess`, and the emptiness
        // check above does not narrow a repeated index expression.
        const [generatedImage] = result.images;
        const imageResponse = await fetchWithDeadline(generatedImage!.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });
        const imageBlob = await imageResponse.blob();
        const mimeType = generatedImage!.content_type ?? "image/png";

        const { file } = await storeFile(context, imageBlob, { threadId, userId });

        return {
            imageUrl: file.url,
            mimeType,
            model: modelId,
        };
    });

export const generateUpscale = internalAction
    .input({
        enhanceDetails: v.optional(v.boolean()),
        enhanceFace: v.optional(v.boolean()),
        imageUrl: v.string(),
        model: v.optional(v.string()),
        scale: v.optional(v.number()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            imageUrl: v.string(),
            mimeType: v.string(),
            model: v.string(),
            scale: v.number(),
        }),
    )
    .action(async ({ args: { enhanceDetails, enhanceFace, imageUrl, model, scale, threadId, userId }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        // Look up model in registry, default to creative-upscaler
        const modelId = model ?? "fal-ai/creative-upscaler";
        const modelDefinition = MODEL_LOOKUP.get(modelId);

        if (!modelDefinition) {
            throw new LunoraError("BAD_REQUEST", `Unknown model: ${modelId}`);
        }

        if (!modelDefinition.supportsUpscale) {
            throw new LunoraError("BAD_REQUEST", `Model ${modelId} does not support upscaling`);
        }

        // Validate scale factor against model capabilities
        const requestedScale = scale ?? 2;

        if (modelDefinition.upscaleFactors && !modelDefinition.upscaleFactors.includes(requestedScale)) {
            throw new LunoraError(
                "BAD_REQUEST",
                `Model ${modelId} does not support ${requestedScale}x scale. Supported: ${modelDefinition.upscaleFactors.join(", ")}`,
            );
        }

        // Use modelApiId as the actual fal.ai endpoint
        const endpoint = modelDefinition.modelApiId ?? modelId;

        chatLogger.debug("[cvx][upscale] Starting upscale", { endpoint, modelId, scale: requestedScale });

        const input: FalRequestInput = {
            image_url: imageUrl,
            scale: requestedScale,
        };

        // Model-specific options for creative-upscaler
        if (endpoint.includes("creative-upscaler")) {
            input.creativity = enhanceDetails ? 0.5 : 0.2;
            input.detail = enhanceDetails ? 1.5 : 1;
            input.resemblance = 0.8;
        }

        // Face enhancement (only if model supports it)
        if (enhanceFace && modelDefinition.supportsFaceEnhance) {
            input.enable_face_enhancement = true;
        }

        const result = await callFalApi<{ image: { content_type?: string; url: string } }>(endpoint, input, falApiKey);

        if (!result.image) {
            throw new LunoraError("BAD_REQUEST", "No upscaled image generated");
        }

        // Store the upscaled image
        const imageResponse = await fetchWithDeadline(result.image.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });
        const imageBlob = await imageResponse.blob();
        const mimeType = result.image.content_type ?? "image/png";

        const { file } = await storeFile(context, imageBlob, { threadId, userId });

        return {
            imageUrl: file.url,
            mimeType,
            model: modelId,
            scale: requestedScale,
        };
    });

export const generateInpaint = internalAction
    .input({
        imageUrl: v.string(),
        maskUrl: v.string(),
        model: v.optional(v.string()),
        negativePrompt: v.optional(v.string()),
        prompt: v.string(),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            imageUrl: v.string(),
            mimeType: v.string(),
            model: v.string(),
        }),
    )
    .action(async ({ args: { imageUrl, maskUrl, model, negativePrompt, prompt, threadId, userId }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        // Look up model in registry, default to flux-pro-fill
        const modelId = model ?? "fal-ai/flux-pro-fill";
        const modelDefinition = MODEL_LOOKUP.get(modelId);

        if (!modelDefinition) {
            throw new LunoraError("BAD_REQUEST", `Unknown model: ${modelId}`);
        }

        if (!modelDefinition.supportsInpaint) {
            throw new LunoraError("BAD_REQUEST", `Model ${modelId} does not support inpainting`);
        }

        // Use modelApiId as the actual fal.ai endpoint
        const endpoint = modelDefinition.modelApiId ?? modelId;

        chatLogger.debug("[cvx][inpaint] Starting inpaint", { endpoint, modelId, prompt });

        const input: FalRequestInput = {
            image_url: imageUrl,
            mask_url: maskUrl,
            prompt,
        };

        if (negativePrompt && modelDefinition.supportsNegativePrompt) {
            input.negative_prompt = negativePrompt;
        }

        const result = await callFalApi<{ images: { content_type?: string; url: string }[] }>(endpoint, input, falApiKey);

        if (!result.images || result.images.length === 0) {
            throw new LunoraError("BAD_REQUEST", "No inpainted image generated");
        }

        // Store the inpainted image
        const [imageSource] = result.images;
        const imageResponse = await fetchWithDeadline(imageSource!.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });
        const imageBlob = await imageResponse.blob();
        const mimeType = imageSource!.content_type ?? "image/png";

        const { file } = await storeFile(context, imageBlob, { threadId, userId });

        return {
            imageUrl: file.url,
            mimeType,
            model: modelId,
        };
    });

export const generateCharacterRef = internalAction
    .input({
        aspectRatio: v.optional(v.string()),
        mode: v.string(), // "face" | "style" | "composition"
        model: v.optional(v.string()),
        negativePrompt: v.optional(v.string()),
        prompt: v.optional(v.string()),
        referenceImages: v.array(v.string()),
        strength: v.optional(v.number()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            imageUrl: v.string(),
            mimeType: v.string(),
            mode: v.string(),
            model: v.string(),
        }),
    )
    .action(async ({ args: { aspectRatio, mode, model, negativePrompt, prompt, referenceImages, strength, threadId, userId }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        if (!referenceImages || referenceImages.length === 0) {
            throw new LunoraError("BAD_REQUEST", "At least one reference image is required");
        }

        // Look up model in registry, default to flux-pro-redux
        const modelId = model ?? "fal-ai/flux-pro-redux";
        const modelDefinition = MODEL_LOOKUP.get(modelId);

        if (!modelDefinition) {
            throw new LunoraError("BAD_REQUEST", `Unknown model: ${modelId}`);
        }

        if (!modelDefinition.supportsCharacterRef) {
            throw new LunoraError("BAD_REQUEST", `Model ${modelId} does not support character reference`);
        }

        // Validate reference image count
        const maxImages = modelDefinition.maxReferenceImages ?? 4;

        if (referenceImages.length > maxImages) {
            throw new LunoraError("BAD_REQUEST", `Model ${modelId} supports max ${maxImages} reference images`);
        }

        // Use modelApiId as the actual fal.ai endpoint
        const endpoint = modelDefinition.modelApiId ?? modelId;

        chatLogger.debug("[cvx][character-ref] Starting character reference generation", {
            endpoint,
            mode,
            modelId,
            numReferences: referenceImages.length,
        });

        const input: FalRequestInput = {
            image_url: referenceImages[0], // Primary reference
            strength: strength ?? 0.8,
        };

        // Add additional reference images if supported
        if (referenceImages.length > 1) {
            input.image_urls = referenceImages;
        }

        // Add prompt if provided
        if (prompt) {
            input.prompt = prompt;
        }

        // Add negative prompt if model supports it
        if (negativePrompt && modelDefinition.supportsNegativePrompt) {
            input.negative_prompt = negativePrompt;
        }

        // Add aspect ratio if provided
        if (aspectRatio) {
            input.image_size = aspectRatio;
        }

        // Model-specific configurations based on mode
        if (endpoint.includes("redux")) {
            // Flux Pro Redux settings
            input.redux_mode = REDUX_MODE_BY_REFERENCE_MODE[mode] ?? "composition";
        } else if (endpoint.includes("ip-adapter")) {
            // IP-Adapter settings
            input.face_strength = mode === "face" ? (strength ?? 0.8) : 0.3;
        } else if (endpoint.includes("pulid")) {
            // PuLID settings for face
            input.id_weight = strength ?? 0.8;
        }

        const result = await callFalApi<{ images: { content_type?: string; url: string }[] }>(endpoint, input, falApiKey);

        if (!result.images || result.images.length === 0) {
            throw new LunoraError("BAD_REQUEST", "No image generated");
        }

        // Store the generated image. Bound once: `result.images[0]` is
        // possibly-undefined under `noUncheckedIndexedAccess`, and the emptiness
        // check above does not narrow a repeated index expression.
        const [generatedImage] = result.images;
        const imageResponse = await fetchWithDeadline(generatedImage!.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });
        const imageBlob = await imageResponse.blob();
        const mimeType = generatedImage!.content_type ?? "image/png";

        const { file } = await storeFile(context, imageBlob, { threadId, userId });

        return {
            imageUrl: file.url,
            mimeType,
            mode,
            model: modelId,
        };
    });

export const generateStyleRef = internalAction
    .input({
        contentImageUrl: v.optional(v.string()),
        model: v.optional(v.string()),
        negativePrompt: v.optional(v.string()),
        preserveContent: v.optional(v.boolean()),
        prompt: v.optional(v.string()),
        strength: v.optional(v.number()),
        styleImageUrl: v.string(),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            imageUrl: v.string(),
            mimeType: v.string(),
            model: v.string(),
        }),
    )
    .action(async ({ args: { contentImageUrl, model, negativePrompt, preserveContent, prompt, strength, styleImageUrl, threadId, userId }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        if (!styleImageUrl) {
            throw new LunoraError("BAD_REQUEST", "Style image URL is required");
        }

        // Look up model in registry, default to flux-redux-style
        const modelId = model ?? "fal-ai/flux-redux-style";
        const modelDefinition = MODEL_LOOKUP.get(modelId);

        if (!modelDefinition) {
            throw new LunoraError("BAD_REQUEST", `Unknown model: ${modelId}`);
        }

        if (!modelDefinition.supportsStyleRef) {
            throw new LunoraError("BAD_REQUEST", `Model ${modelId} does not support style reference`);
        }

        // Use modelApiId as the actual fal.ai endpoint
        const endpoint = modelDefinition.modelApiId ?? modelId;

        chatLogger.debug("[cvx][style-ref] Starting style reference generation", {
            endpoint,
            hasContentImage: !!contentImageUrl,
            modelId,
            preserveContent,
        });

        const input: FalRequestInput = {
            strength: strength ?? 0.8,
            style_image_url: styleImageUrl,
        };

        // Add content image if provided (for style transfer)
        if (contentImageUrl) {
            input.image_url = contentImageUrl;
            input.content_image_url = contentImageUrl;
        }

        // Add prompt if provided
        if (prompt) {
            input.prompt = prompt;
        }

        // Add negative prompt if model supports it
        if (negativePrompt && modelDefinition.supportsNegativePrompt) {
            input.negative_prompt = negativePrompt;
        }

        // Preserve content structure setting
        if (preserveContent !== undefined) {
            input.preserve_content = preserveContent;
            input.content_weight = preserveContent ? 0.7 : 0.3;
        }

        // Model-specific configurations
        if (endpoint.includes("redux")) {
            // Flux Pro Redux settings for style transfer
            input.redux_mode = "style_transfer";
            input.image_url = styleImageUrl;

            if (contentImageUrl) {
                input.image_urls = [styleImageUrl, contentImageUrl];
            }
        } else if (endpoint.includes("style-transfer")) {
            // Classic style transfer settings
            input.style_strength = strength ?? 0.8;
        } else if (endpoint.includes("ip-adapter")) {
            // IP-Adapter style mode
            input.image_url = styleImageUrl;
            input.style_strength = strength ?? 0.8;
        }

        const result = await callFalApi<{ images: { content_type?: string; url: string }[] }>(endpoint, input, falApiKey);

        if (!result.images || result.images.length === 0) {
            throw new LunoraError("BAD_REQUEST", "No image generated");
        }

        // Store the generated image. Bound once: `result.images[0]` is
        // possibly-undefined under `noUncheckedIndexedAccess`, and the emptiness
        // check above does not narrow a repeated index expression.
        const [generatedImage] = result.images;
        const imageResponse = await fetchWithDeadline(generatedImage!.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });
        const imageBlob = await imageResponse.blob();
        const mimeType = generatedImage!.content_type ?? "image/png";

        const { file } = await storeFile(context, imageBlob, { threadId, userId });

        return {
            imageUrl: file.url,
            mimeType,
            model: modelId,
        };
    });

export const generateParallelCompare = internalAction
    .input({
        aspectRatio: v.optional(v.string()),
        models: v.array(v.string()), // 2-4 model IDs
        negativePrompt: v.optional(v.string()),
        prompt: v.string(),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            prompt: v.string(),
            results: v.array(
                v.object({
                    error: v.optional(v.string()),
                    imageUrl: v.union(v.string(), v.null()),
                    mimeType: v.union(v.string(), v.null()),
                    modelId: v.string(),
                    modelName: v.string(),
                    success: v.boolean(),
                }),
            ),
            successCount: v.number(),
            totalModels: v.number(),
        }),
    )
    .action(async ({ args: { aspectRatio, models, negativePrompt, prompt, threadId, userId }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        if (!models || models.length < 2) {
            throw new LunoraError("BAD_REQUEST", "At least 2 models required for comparison");
        }

        if (models.length > 4) {
            throw new LunoraError("BAD_REQUEST", "Maximum 4 models allowed for comparison");
        }

        if (!prompt) {
            throw new LunoraError("BAD_REQUEST", "Prompt is required");
        }

        chatLogger.debug("[cvx][parallel-compare] Starting parallel comparison", {
            models,
            numModels: models.length,
        });

        // Run all models in parallel
        const results = await Promise.allSettled(
            models.map(async (modelId) => {
                const modelDefinition = MODEL_LOOKUP.get(modelId);

                if (!modelDefinition) {
                    throw new LunoraError("BAD_REQUEST", `Unknown model: ${modelId}`);
                }

                const endpoint = modelDefinition.modelApiId ?? modelId;
                const input: FalRequestInput = {
                    prompt,
                };

                // Add negative prompt if supported
                if (negativePrompt && modelDefinition.supportsNegativePrompt) {
                    input.negative_prompt = negativePrompt;
                }

                // Add aspect ratio
                if (aspectRatio) {
                    input.image_size = aspectRatio;
                }

                const result = await callFalApi<{ images: { content_type?: string; url: string }[] }>(endpoint, input, falApiKey);

                if (!result.images || result.images.length === 0) {
                    throw new LunoraError("INTERNAL", "No image generated");
                }

                // Store the generated image
                const [imageSource] = result.images;
                const imageResponse = await fetchWithDeadline(imageSource!.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });
                const imageBlob = await imageResponse.blob();
                const mimeType = imageSource!.content_type ?? "image/png";

                const { file } = await storeFile(context, imageBlob, { threadId, userId });

                return {
                    imageUrl: file.url,
                    mimeType,
                    modelId,
                    modelName: modelDefinition.name ?? modelId,
                    success: true,
                };
            }),
        );

        // Process results - include both successes and failures
        const processedResults = results.map((result, index) => {
            if (result.status === "fulfilled") {
                return result.value;
            }

            return {
                error: result.reason instanceof Error ? result.reason.message : "Generation failed",
                imageUrl: null,
                mimeType: null,
                // `results` is `Promise.allSettled(models.map(...))`, so it is
                // index-aligned with `models` and this is always in range. The
                // `| undefined` is noUncheckedIndexedAccess, not a real case —
                // and the declared output types both as required strings.
                modelId: models[index]!,
                modelName: models[index]!,
                success: false,
            };
        });

        return {
            prompt,
            results: processedResults,
            successCount: processedResults.filter((r) => r.success).length,
            totalModels: models.length,
        };
    });

// ============================================================================
// Outpaint, Background Removal, Object Edit, Image-to-Video, ControlNet, Transcription
// ============================================================================

export const generateOutpaint = internalAction
    .input({
        expandDirection: v.string(),
        expandPixels: v.optional(v.number()),
        imageUrl: v.string(),
        model: v.optional(v.string()),
        negativePrompt: v.optional(v.string()),
        prompt: v.optional(v.string()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            imageUrl: v.string(),
            mimeType: v.string(),
            model: v.string(),
        }),
    )
    .action(async ({ args: { expandDirection, expandPixels, imageUrl, model, negativePrompt, prompt, threadId, userId }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        const endpoint = model ?? "fal-ai/flux-pro/v1.1/outpaint";

        chatLogger.debug("[cvx][outpaint] Starting outpaint", { endpoint, expandDirection, expandPixels });

        const pixels = expandPixels ?? 256;
        const input: FalRequestInput = {
            image_url: imageUrl,
        };

        if (prompt) {
            input.prompt = prompt;
        }

        if (negativePrompt) {
            input.negative_prompt = negativePrompt;
        }

        // Set expand dimensions based on direction
        switch (expandDirection) {
            case "all": {
                input.top = pixels;
                input.bottom = pixels;
                input.left = pixels;
                input.right = pixels;

                break;
            }
            case "bottom": {
                input.bottom = pixels;

                break;
            }
            case "left": {
                input.left = pixels;

                break;
            }
            case "right": {
                input.right = pixels;

                break;
            }
            case "top": {
                input.top = pixels;

                break;
            }
            // No default
            default: {
                break;
            }
        }

        const result = await callFalApi<{ images: { content_type?: string; url: string }[] }>(endpoint, input, falApiKey);

        if (!result.images || result.images.length === 0) {
            throw new LunoraError("BAD_REQUEST", "No outpainted image generated");
        }

        const [imageSource] = result.images;
        const imageResponse = await fetchWithDeadline(imageSource!.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });
        const imageBlob = await imageResponse.blob();
        const mimeType = imageSource!.content_type ?? "image/png";

        const { file } = await storeFile(context, imageBlob, { threadId, userId });

        return {
            imageUrl: file.url,
            mimeType,
            model: endpoint,
        };
    });

export const generateBackgroundRemoval = internalAction
    .input({
        backgroundColor: v.optional(v.string()),
        imageUrl: v.string(),
        model: v.optional(v.string()),
        outputFormat: v.optional(v.string()),
        refineMask: v.optional(v.boolean()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            imageUrl: v.string(),
            mimeType: v.string(),
            model: v.string(),
        }),
    )
    .action(async ({ args: { backgroundColor, imageUrl, model, outputFormat, refineMask, threadId, userId }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        const endpoint = model ?? "fal-ai/birefnet/v2";

        chatLogger.debug("[cvx][bg-removal] Starting background removal", { endpoint });

        const input: FalRequestInput = {
            image_url: imageUrl,
            output_format: outputFormat ?? "png",
        };

        if (refineMask !== undefined) {
            input.refine_mask = refineMask;
        }

        if (backgroundColor) {
            input.bg_color = backgroundColor;
        }

        const result = await callFalApi<{ image: { content_type?: string; url: string } }>(endpoint, input, falApiKey);

        if (!result.image) {
            throw new LunoraError("BAD_REQUEST", "No result from background removal");
        }

        const imageResponse = await fetchWithDeadline(result.image.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });
        const imageBlob = await imageResponse.blob();
        const mimeType = result.image.content_type ?? "image/png";

        const { file } = await storeFile(context, imageBlob, { threadId, userId });

        return {
            imageUrl: file.url,
            mimeType,
            model: endpoint,
        };
    });

export const generateObjectEdit = internalAction
    .input({
        imageUrl: v.string(),
        maskUrl: v.string(),
        mode: v.string(), // "remove" | "add"
        model: v.optional(v.string()),
        negativePrompt: v.optional(v.string()),
        prompt: v.optional(v.string()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            imageUrl: v.string(),
            mimeType: v.string(),
            model: v.string(),
        }),
    )
    .action(async ({ args: { imageUrl, maskUrl, mode, model, negativePrompt, prompt, threadId, userId }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        // Use LaMa for removal (no prompt needed), inpaint model for adding
        const endpoint = mode === "remove" ? (model ?? "fal-ai/lama") : (model ?? "fal-ai/flux-pro/v1.1/fill");

        chatLogger.debug("[cvx][object-edit] Starting object edit", { endpoint, mode });

        const input: FalRequestInput = {
            image_url: imageUrl,
            mask_url: maskUrl,
        };

        if (mode === "add") {
            if (!prompt) {
                throw new LunoraError("BAD_REQUEST", "Prompt required for add mode");
            }

            input.prompt = prompt;

            if (negativePrompt) {
                input.negative_prompt = negativePrompt;
            }
        }

        const result = await callFalApi<{
            image?: { content_type?: string; url: string };
            images?: { content_type?: string; url: string }[];
        }>(endpoint, input, falApiKey);

        // LaMa returns { image }, inpaint models return { images }
        const outputUrl = result.image?.url ?? result.images?.[0]?.url;

        if (!outputUrl) {
            throw new LunoraError("BAD_REQUEST", "No result from object editing");
        }

        const contentType = result.image?.content_type ?? result.images?.[0]?.content_type ?? "image/png";
        const imageResponse = await fetchWithDeadline(outputUrl, { timeoutMs: FETCH_TIMEOUT_LONG_MS });
        const imageBlob = await imageResponse.blob();

        const { file } = await storeFile(context, imageBlob, { threadId, userId });

        return {
            imageUrl: file.url,
            mimeType: contentType,
            model: endpoint,
        };
    });

export const generateImageToVideo = internalAction
    .input({
        duration: v.optional(v.number()),
        fps: v.optional(v.number()),
        imageUrl: v.string(),
        loop: v.optional(v.boolean()),
        model: v.optional(v.string()),
        motionStrength: v.optional(v.number()),
        prompt: v.optional(v.string()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            mimeType: v.string(),
            model: v.string(),
            videoUrl: v.string(),
        }),
    )
    .action(async ({ args: { duration, fps, imageUrl, loop, model, motionStrength, prompt, threadId: _threadId, userId: _userId }, ctx: _context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        const endpoint = model ?? "fal-ai/kling-video/v2.1/standard/image-to-video";

        chatLogger.debug("[cvx][img2video] Starting image-to-video", { duration, endpoint });

        const input: FalRequestInput = {
            image_url: imageUrl,
        };

        if (prompt) {
            input.prompt = prompt;
        }

        if (duration) {
            input.duration = duration;
        }

        if (motionStrength !== undefined) {
            input.motion_strength = motionStrength;
        }

        if (fps) {
            input.fps = fps;
        }

        if (loop !== undefined) {
            input.loop = loop;
        }

        const result = await callFalApi<{ video: { content_type?: string; url: string } }>(endpoint, input, falApiKey);

        if (!result.video) {
            throw new LunoraError("BAD_REQUEST", "No video generated from image");
        }

        return {
            mimeType: result.video.content_type ?? "video/mp4",
            model: endpoint,
            videoUrl: result.video.url,
        };
    });

export const generateControlNet = internalAction
    .input({
        controlType: v.string(), // "pose" | "depth" | "canny" | "normal" | "softedge"
        endPercent: v.optional(v.number()),
        imageUrl: v.string(),
        model: v.optional(v.string()),
        preprocessor: v.optional(v.string()),
        prompt: v.optional(v.string()),
        startPercent: v.optional(v.number()),
        strength: v.optional(v.number()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            controlType: v.string(),
            imageUrl: v.string(),
            mimeType: v.string(),
            model: v.string(),
        }),
    )
    .action(async ({ args: { controlType, endPercent, imageUrl, model, preprocessor, prompt, startPercent, strength, threadId, userId }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        const endpoint = model ?? "fal-ai/flux-general/image-to-image";

        chatLogger.debug("[cvx][controlnet] Starting ControlNet generation", { controlType, endpoint });

        const input: FalRequestInput = {
            control_image_url: imageUrl,
            controlnet_conditioning_scale: strength ?? 0.8,
        };

        if (prompt) {
            input.prompt = prompt;
        }

        // Map control type to preprocessor
        const preprocessorMap: Record<string, string> = {
            canny: "canny",
            depth: "depth_anything_v2",
            normal: "normal_bae",
            pose: "openpose",
            softedge: "hed",
        };

        input.controlnet_type = controlType;
        input.preprocessor = preprocessor ?? preprocessorMap[controlType] ?? controlType;

        if (startPercent !== undefined) {
            input.control_guidance_start = startPercent;
        }

        if (endPercent !== undefined) {
            input.control_guidance_end = endPercent;
        }

        const result = await callFalApi<{ images: { content_type?: string; url: string }[] }>(endpoint, input, falApiKey);

        if (!result.images || result.images.length === 0) {
            throw new LunoraError("BAD_REQUEST", "No ControlNet image generated");
        }

        const [imageSource] = result.images;
        const imageResponse = await fetchWithDeadline(imageSource!.url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });
        const imageBlob = await imageResponse.blob();
        const mimeType = imageSource!.content_type ?? "image/png";

        const { file } = await storeFile(context, imageBlob, { threadId, userId });

        return {
            controlType,
            imageUrl: file.url,
            mimeType,
            model: endpoint,
        };
    });

export const generateTranscription = internalAction
    .input({
        audioUrl: v.string(),
        language: v.optional(v.string()),
        model: v.optional(v.string()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.object({
            chunks: v.array(
                v.object({
                    text: v.string(),
                    timestamp: v.array(v.number()),
                }),
            ),
            model: v.string(),
            text: v.string(),
        }),
    )
    .action(async ({ args: { audioUrl, language, model, threadId: _threadId, userId: _userId }, ctx: _context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        const endpoint = model ?? "fal-ai/whisper";

        chatLogger.debug("[cvx][transcription] Starting transcription", { endpoint });

        const input: FalRequestInput = {
            audio_url: audioUrl,
        };

        if (language) {
            input.language = language;
        }

        const result = await callFalApi<{
            chunks?: { text: string; timestamp: [number, number] }[];
            text: string;
        }>(endpoint, input, falApiKey);

        if (!result.text && result.text !== "") {
            throw new LunoraError("BAD_REQUEST", "No transcription result");
        }

        return {
            chunks: result.chunks ?? [],
            model: endpoint,
            text: result.text,
        };
    });

/**
 * Action to test an MCP server connection and discover its tools.
 * Called from the MCP settings UI to validate a server before/after saving.
 */
// Output declared and handler annotated so codegen prints a SELF-CONTAINED type.
// Left to inference it emitted `import("./lib/mcp-tools").MCPTestResult` into `_generated/api.ts` — a
// specifier resolved against this file's directory, which means nothing from
// `_generated/`.
export const testMCPServerConnection = authAction
    // `mcp/proxy`, not `"default"`. There is no `default` entry in
    // RATE_LIMIT_CONFIGS — the name only compiled because the table was annotated
    // `Record<string, RateLimitConfig>`, which collapsed `RateLimitName` to plain
    // `string`. Both MCP actions were running with NO limit, and the mcp/proxy
    // entry exists precisely because outbound MCP connections are a pool-DoS
    // vector (its own comment says so).
    .use(rateLimit("mcp/proxy"))
    .input({
        headers: v.optional(v.array(v.object({ key: v.string().max(MAX_LENGTH.key), value: v.string().max(MAX_LENGTH.text) }))),
        name: v.string().max(MAX_LENGTH.short),
        protocol: v.union(v.literal("sse"), v.literal("http")),
        url: v.string().max(MAX_LENGTH.url),
    })
    .output(
        v.object({
            error: v.optional(v.string()),
            latencyMs: v.number(),
            ok: v.boolean(),
            /** The server wants OAuth (401, or protected-resource metadata): offer "Sign in". */
            requiresOAuth: v.optional(v.boolean()),
            /** The test used the caller's stored sign-in for this server. */
            signedIn: v.optional(v.boolean()),
            tools: v.array(v.string()),
        }),
    )
    .action(async ({ args: { headers, name, protocol, url }, ctx: context }) => {
        const { testMCPServer } = await import("./lib/mcp-tools");
        const { withMcpServerGrants } = await import("../connectors/lib/grant-runtime");
        const { probeRequiresOAuth } = await import("../connectors/lib/mcp-oauth");

        const config: import("./lib/mcp-tools").MCPServerConfig = { enabled: true, ...(headers && { headers }), name, protocol, url };
        // A saved server the user signed in to is tested WITH its token (same name
        // and url only), never pruning: this is one server, not the whole list.
        const [withGrant] = await withMcpServerGrants(context, context.user.userId, [config]).catch(() => [config]);
        const signedIn = withGrant?.oauth !== undefined;
        const result = await testMCPServer(withGrant ?? config);

        context.log.event("chat.test_mcp_server_connection", { ok: result.ok, signedIn, toolCount: result.tools.length });

        if (result.ok) {
            return { ...result, ...(signedIn && { signedIn }) };
        }

        return { ...result, requiresOAuth: await probeRequiresOAuth(url), ...(signedIn && { signedIn }) };
    });

/**
 * Action to list MCP tool metadata (including _meta.ui.resourceUri) for all enabled servers.
 * Used by the frontend to know which tools have MCP Apps UI support.
 */
export const listMCPToolsMeta = authAction
    .use(rateLimit("mcp/proxy"))
    .input({
        serverNames: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
    })
    .output(
        v.object({
            servers: v.array(
                v.object({
                    error: v.union(v.string(), v.null()),
                    name: v.string(),
                    tools: v.array(v.object({ name: v.string(), resourceUri: v.union(v.string(), v.null()) })),
                }),
            ),
        }),
    )
    .action(async ({ args: { serverNames }, ctx: context }) => {
        // The user's servers (with their sign-in tokens) AND connected connectors,
        // so connector tools with ui:// resources render as MCP Apps too.
        const { resolveUserMcpServers } = await import("../connectors/lib/user-mcp-servers");
        const allServers = await resolveUserMcpServers(context, context.user.userId);

        const servers =
            serverNames && serverNames.length > 0 ? allServers.filter((s) => s.enabled && serverNames.includes(s.name)) : allServers.filter((s) => s.enabled);

        if (servers.length === 0) {
            return { servers: [] };
        }

        const { createMCPClient } = await import("@ai-sdk/mcp");
        const { assertSafeMcpUrl, headersToRecord } = await import("./lib/mcp-tools");

        const serverResults = await Promise.allSettled(
            servers.map(async (config) => {
                assertSafeMcpUrl(config.url);

                const headers = headersToRecord(config.headers);
                const client = await createMCPClient({
                    transport: {
                        type: config.protocol,
                        url: config.url,
                        ...(headers && { headers }),
                    },
                });

                try {
                    const { tools } = await client.listTools();

                    return {
                        error: null,
                        name: config.name,
                        tools: tools.map((t) => {
                            return {
                                name: t.name,
                                resourceUri: (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri ?? null,
                            };
                        }),
                    };
                } finally {
                    await client.close().catch(() => {});
                }
            }),
        );

        context.log.event("chat.list_mcp_tools_meta", {
            failedCount: serverResults.filter((result) => result.status === "rejected").length,
            serverCount: serverResults.length,
        });

        return {
            servers: serverResults.map((result, i) => {
                if (result.status === "fulfilled") {
                    return result.value;
                }

                return {
                    error: String((result as PromiseRejectedResult).reason?.message ?? result.reason),
                    name: servers[i]!.name,
                    tools: [],
                };
            }),
        };
    });

// ---------------------------------------------------------------------------
// Image Editing (fal.ai)
// ---------------------------------------------------------------------------

const FAL_MODELS: Record<string, string> = {
    face_enhance: "fal-ai/gfpgan",
    inpaint: "fal-ai/flux/dev/inpainting",
    remove_background: "fal-ai/birefnet",
    style_transfer: "fal-ai/flux/dev/image-to-image",
    upscale: "fal-ai/clarity-upscaler",
};

export const editImage = internalAction
    .input({
        imageUrl: v.string(),
        mask: v.optional(v.string()),
        operation: v.string(),
        prompt: v.optional(v.string()),
    })
    .action(async ({ args: { imageUrl, mask, operation, prompt }, ctx: _context }) => {
        const { FAL_API_KEY } = await import("../env");

        if (!FAL_API_KEY) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY is not configured");
        }

        const modelId = FAL_MODELS[operation];

        if (!modelId) {
            throw new LunoraError("BAD_REQUEST", `Unknown image editing operation: ${operation}`);
        }

        // Build per-operation input payload
        let input: FalRequestInput;

        switch (operation) {
            case "face_enhance": {
                input = { image_url: imageUrl };
                break;
            }
            case "inpaint": {
                input = { image_url: imageUrl, prompt, ...(mask && { mask_url: mask }) };
                break;
            }
            case "remove_background": {
                input = { image_url: imageUrl };
                break;
            }
            case "style_transfer": {
                input = { image_url: imageUrl, prompt, strength: 0.65 };
                break;
            }
            case "upscale": {
                input = { image_url: imageUrl, scale: 2 };
                break;
            }
            default: {
                throw new LunoraError("BAD_REQUEST", `Unknown image editing operation: ${operation}`);
            }
        }

        const response = await fetchWithDeadline(`https://queue.fal.run/${modelId}`, {
            body: JSON.stringify(input),
            headers: {
                Authorization: `Key ${FAL_API_KEY}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });

        if (!response.ok) {
            const errorText = await response.text();

            throw new LunoraError("BAD_REQUEST", `fal.ai API error: ${response.status} ${errorText}`);
        }

        const data = (await response.json()) as {
            image?: { content_type?: string; url: string };
            images?: { content_type?: string; url: string }[];
        };

        const resultUrl = data.images?.[0]?.url ?? data.image?.url;

        if (!resultUrl) {
            throw new LunoraError("BAD_REQUEST", "No image returned from fal.ai");
        }

        return { resultUrl };
    });
