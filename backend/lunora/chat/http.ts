import { ANONYMOUS_FREE_MODEL } from "@neore/ai/constants";
import { MODEL_LOOKUP } from "@neore/ai/models";
import type { CinemaSettings } from "@neore/ai/types/cinema";
import type { HttpActionCtx } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { getFile } from "../agent/client";
import { getCurrentUserInternal } from "../auth/lib/helper";
import type { BetterAuthUser } from "../auth/lib/types";
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "../lib/crypto";
import type { Signer } from "../lib/storage-sign";
import { httpScheduler } from "../lib/http-scheduler";
import { enqueueJob } from "../lib/job-queue";
import { inShard } from "../lib/http-shard";
import { chatLogger } from "../lib/logger";
import { getUserTier } from "../lib/rate-limiter";
import { SERVICE_REQUEST_WINDOW_MS } from "../lib/sign-request";
import { threadShardFor } from "../lib/thread-shard";
import { chargeDailyLimit, type DailyLimitKind } from "./lib/daily-limit";
import { NO_SERVICE_FETCH } from "../lib/services";
import getAgent from "./lib/get-agent";
import { mediaThreadTitle, startTitleJobs } from "./lib/start-title-jobs";
import { formatPageContextPart, parsePageContext } from "./lib/page-context";
import { createStreamToken } from "./streaming/persistent/stream-token";

const SAFE_TOKEN_RE = /^[\w-]+$/;

/**
 * Validates if a string looks like a valid document ID format.
 * Document IDs are URL-safe tokens (checked against SAFE_TOKEN_RE).
 */
const isValidDocumentIdFormat = (id: string): boolean => typeof id === "string" && id.length > 0 && SAFE_TOKEN_RE.test(id);

/**
 * A thrown value's `message`, without asserting it is an `Error`.
 *
 * `getCurrentUserInternal` rejects with plain `{ message }` objects as well as real
 * `Error`s, and the handlers below only branch on the text — so read the field
 * structurally and hand back `""` when there is none, rather than typing every
 * `catch` binding `any` just to reach `.message`.
 */
const errorMessageOf = (error: unknown): string =>
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : "";

/**
 * The caught error, when it is a `LunoraError` the client may see verbatim.
 *
 * `LunoraError` covers internal failures too, and these handlers
 * build their own JSON bodies — so nothing else would redact an INTERNAL
 * message on its way out. The 5xx codes are exactly the ones the catalog marks
 * internal, so the status is the cheapest correct filter.
 */
const userFacingError = (error: unknown): LunoraError | undefined => (error instanceof LunoraError && error.status < 500 ? error : undefined);

/** True when the auth failure is a stale/expired session rather than a genuine error. */
const isStaleSessionError = (error: unknown): boolean => {
    const message = errorMessageOf(error);

    return message.includes("OIDC token") || message.includes("token claim");
};

// HTTP action for prompt improvement (wrapper around the action)
export const improvePromptHttpAction = async (context: HttpActionCtx, request: Request) => {
    // Parse the request body
    const { improvementInstructions, prompt, style, threadId } = v
        .object({
            improvementInstructions: v.optional(v.string()),
            prompt: v.string(),
            style: v.optional(v.string()),
            threadId: v.optional(v.string()),
        })
        .parse(await request.json());

    if (!prompt) {
        return Response.json(
            { error: "Missing prompt" },
            {
                headers: { "Content-Type": "application/json" },
                status: 400,
            },
        );
    }

    // Validate threadId format if provided
    if (threadId && !isValidDocumentIdFormat(threadId)) {
        return Response.json(
            { error: "Invalid thread ID format" },
            {
                headers: { "Content-Type": "application/json" },
                status: 400,
            },
        );
    }

    // Get authenticated user
    let user: BetterAuthUser | undefined;

    try {
        user = await getCurrentUserInternal(context);
    } catch (error) {
        // Handle OIDC token verification errors - might be stale session
        if (isStaleSessionError(error)) {
            return Response.json(
                {
                    error: "SESSION_EXPIRED",
                    message: "Your session has expired. Please refresh the page and try again.",
                },
                { headers: { "Content-Type": "application/json" }, status: 401 },
            );
        }

        // Re-throw other errors
        throw error;
    }

    if (!user) {
        return Response.json({ error: "Not authenticated", message: "User not found" }, { headers: { "Content-Type": "application/json" }, status: 401 });
    }

    const userId = user._id;

    if (!userId) {
        return Response.json(
            { error: "User ID is required", message: "User ID not found in session" },
            { headers: { "Content-Type": "application/json" }, status: 401 },
        );
    }

    try {
        const result = await context.runAction(internal.chat.functions.improvePrompt, {
            improvementInstructions,
            prompt,
            style,
            threadId,
            userId,
            userPlan: getUserTier({ plan: user.plan ?? null }) === "premium" ? "premium" : "free",
        });

        return Response.json(result, {
            headers: { "Content-Type": "application/json" },
            status: 200,
        });
    } catch (error) {
        chatLogger.error("Error improving prompt:", error);

        const errorMessage = userFacingError(error)?.message ?? "Failed to improve prompt";

        return Response.json(
            { error: errorMessage },
            {
                headers: { "Content-Type": "application/json" },
                status: 500,
            },
        );
    }
};

const respondWithUserError = (error: unknown, fallback: string) => {
    const userError = userFacingError(error);

    if (userError) {
        const data = userError.data as { kind?: string; message?: string; retryAfter?: number } | undefined;

        if (data?.kind === "RateLimitError") {
            return Response.json(
                { error: data.message ?? "Rate limit exceeded", kind: "RateLimitError", retryAfter: data.retryAfter },
                { headers: { "Content-Type": "application/json" }, status: 429 },
            );
        }

        return Response.json({ error: userError.message }, { headers: { "Content-Type": "application/json" }, status: 500 });
    }

    return Response.json({ error: fallback }, { headers: { "Content-Type": "application/json" }, status: 500 });
};

const authenticateOptimizerRequest = async (context: HttpActionCtx): Promise<Response | { userId: string; userPlan?: "free" | "premium" }> => {
    let user: BetterAuthUser | undefined;

    try {
        user = await getCurrentUserInternal(context);
    } catch (error) {
        if (isStaleSessionError(error)) {
            return Response.json(
                { error: "SESSION_EXPIRED", message: "Your session has expired. Please refresh the page and try again." },
                { headers: { "Content-Type": "application/json" }, status: 401 },
            );
        }

        throw error;
    }

    if (!user) {
        return Response.json({ error: "Not authenticated" }, { headers: { "Content-Type": "application/json" }, status: 401 });
    }

    const userId = user._id;

    if (!userId) {
        return Response.json({ error: "User ID is required" }, { headers: { "Content-Type": "application/json" }, status: 401 });
    }

    return { userId, userPlan: getUserTier({ plan: user.plan ?? null }) === "premium" ? "premium" : "free" };
};

/** HTTP action: optimize a system prompt (new feature). */
export const optimizeSystemPromptHttpAction = async (context: HttpActionCtx, request: Request) => {
    const { improvementInstructions, modelId, prompt, style, threadId } = v
        .object({
            improvementInstructions: v.optional(v.string()),
            modelId: v.optional(v.string()),
            prompt: v.string(),
            style: v.optional(v.string()),
            threadId: v.optional(v.string()),
        })
        .parse(await request.json());

    if (!prompt) {
        return Response.json({ error: "Missing prompt" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    if (threadId && !isValidDocumentIdFormat(threadId)) {
        return Response.json({ error: "Invalid thread ID format" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    const auth = await authenticateOptimizerRequest(context);

    if (auth instanceof Response) {
        return auth;
    }

    try {
        const result = await context.runAction(internal.chat.functions.optimizeSystemPrompt, {
            improvementInstructions,
            modelId,
            prompt,
            style,
            threadId,
            userId: auth.userId,
            userPlan: auth.userPlan,
        });

        return Response.json(result, { headers: { "Content-Type": "application/json" }, status: 200 });
    } catch (error) {
        chatLogger.error("Error optimizing system prompt:", error);

        return respondWithUserError(error, "Failed to optimize system prompt");
    }
};

/** HTTP action: iterate on a previously optimized prompt. */
export const iteratePromptHttpAction = async (context: HttpActionCtx, request: Request) => {
    const { iterateInput, lastOptimizedPrompt, mode, threadId } = v
        .object({
            iterateInput: v.optional(v.string()),
            lastOptimizedPrompt: v.string(),
            mode: v.optional(v.union(v.literal("user"), v.literal("system"))),
            threadId: v.optional(v.string()),
        })
        .parse(await request.json());

    if (!lastOptimizedPrompt) {
        return Response.json({ error: "Missing lastOptimizedPrompt" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    if (!iterateInput) {
        return Response.json({ error: "Missing iterateInput" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    if (threadId && !isValidDocumentIdFormat(threadId)) {
        return Response.json({ error: "Invalid thread ID format" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    const auth = await authenticateOptimizerRequest(context);

    if (auth instanceof Response) {
        return auth;
    }

    try {
        const result = await context.runAction(internal.chat.functions.iteratePrompt, {
            iterateInput,
            lastOptimizedPrompt,
            mode,
            threadId,
            userId: auth.userId,
            userPlan: auth.userPlan,
        });

        return Response.json(result, { headers: { "Content-Type": "application/json" }, status: 200 });
    } catch (error) {
        chatLogger.error("Error iterating prompt:", error);

        return respondWithUserError(error, "Failed to iterate prompt");
    }
};

/**
 * Gateway-first entry point for chat requests.
 *
 * Called by the LLM Gateway after it has validated input, checked content safety,
 * and applied rate limiting. This endpoint performs auth, creates the thread/message,
 * schedules the background agent, and returns stream metadata.
 *
 * Auth: HMAC (gateway) + Authorization header (user JWT forwarded by gateway).
 *
 * POST /chat/start.
 */
export const chatStartHttpAction = async (context: HttpActionCtx, request: Request) => {
    // Verify HMAC — proves the request came from the gateway
    const signingSecret = process.env.LLM_GATEWAY_SIGNING_SECRET;

    if (!signingSecret) {
        return Response.json({ error: "Gateway not configured" }, { status: 500 });
    }

    const signature = request.headers.get("X-Signature");
    const timestamp = request.headers.get("X-Timestamp");

    if (!signature || !timestamp) {
        return Response.json({ error: "Missing HMAC auth headers" }, { status: 401 });
    }

    // Replay protection
    if (Math.abs(Date.now() - Number(timestamp)) > SERVICE_REQUEST_WINDOW_MS) {
        return Response.json({ error: "Request timestamp expired" }, { status: 401 });
    }

    // Clone request to read body without consuming it for auth
    const bodyClone = await request.clone().arrayBuffer();
    const bodyHash = await sha256Hex(bodyClone);
    const path = new URL(request.url).pathname;
    const message = `${request.method}\n${path}\n${timestamp}\n${bodyHash}`;
    const expected = await hmacSha256Hex(signingSecret, message);

    if (!timingSafeEqual(signature, expected)) {
        return Response.json({ error: "Invalid HMAC signature" }, { status: 401 });
    }

    // Parse request body (already validated by gateway)
    const body = JSON.parse(new TextDecoder().decode(bodyClone)) as ChatStartBody;

    return await runChatStart(context, body, signingSecret);
};

/** The `/chat/start` request body. Also built by the public API's chat route. */
export interface ChatStartBody {
    cinemaSettings?: CinemaSettings;
    customSystemPrompt?: string;
    duration?: number;
    enabledFeatures?: string[];
    fileIds?: string[];
    imageSize?: string;
    language?: string;
    mcpServerNames?: string[];
    mode?: "text" | "image" | "video";
    model: string;
    negativePrompt?: string;
    numImages?: number;
    /** Browser-extension page capture; untrusted, validated by `parsePageContext`. */
    pageContext?: unknown;
    parentId?: string;
    prompt?: string;
    quality?: string;
    reasoningEffort?: number;
    referenceImages?: string[];
    regenerate?: boolean;
    researchDepth?: "speed" | "balanced" | "thorough";
    searchMode?: string;
    seed?: number;
    shouldAutoContinue?: boolean;
    statelessMode?: boolean;
    style?: string;
    threadId?: string;
}

/**
 * Everything `/chat/start` does once the caller is trusted: resolve the user
 * from the request identity, apply the daily limit, create or continue the
 * thread and schedule the agent.
 *
 * Split out of `chatStartHttpAction` so the public API (`public-api/router.ts`)
 * runs the SAME path — same limits, same thread creation, same stream — with
 * an API-key identity instead of the gateway's HMAC plus forwarded JWT.
 */
export const runChatStart = async (context: HttpActionCtx, body: ChatStartBody, signingSecret: string): Promise<Response> => {
    // The gateway forwards this field without looking at it, so this is the
    // only place its shape and size are checked.
    const pageContext = parsePageContext(body.pageContext);

    if (pageContext === null) {
        return Response.json({ error: "Invalid pageContext" }, { status: 400 });
    }

    // Auth: extract user from the forwarded JWT
    let user: BetterAuthUser | undefined;

    try {
        user = await getCurrentUserInternal(context);
    } catch {
        return Response.json({ error: "Not authenticated" }, { status: 401 });
    }

    if (!user) {
        return Response.json({ error: "Not authenticated" }, { status: 401 });
    }

    const userId = user._id;

    if (!userId) {
        return Response.json({ error: "User ID not found" }, { status: 401 });
    }

    // The thread's shard: the caller's own, or — in a thread shared with them —
    // its owner's, where the thread, its messages and this run's stream live
    // (docs/plans/per-user-sharding.md). Everything below runs there.
    const shardKey = await threadShardFor(context, userId, body.threadId);

    return await inShard(context, shardKey, async (shardCtx) => await runChatStartOnShard(shardCtx, body, signingSecret, { pageContext, user, userId }));
};

const runChatStartOnShard = async (
    context: HttpActionCtx,
    body: ChatStartBody,
    signingSecret: string,
    { pageContext, user, userId }: { pageContext: ReturnType<typeof parsePageContext>; user: BetterAuthUser; userId: NonNullable<BetterAuthUser["_id"]> },
): Promise<Response> => {
    // Force anonymous users onto free model
    const isAnonymous = user.isAnonymous === true;
    const effectiveModel = isAnonymous ? ANONYMOUS_FREE_MODEL : body.model;

    // Determine content type
    const modelDefinition = MODEL_LOOKUP.get(effectiveModel);
    let contentType: "image" | "text" | "video" = "text";

    if (modelDefinition?.mode === "image") {
        contentType = "image";
    } else if (modelDefinition?.mode === "video") {
        contentType = "video";
    }

    // Scopes organization-shared skills. `user.activeOrganization` is always
    // null here (no session read from an HTTP action), so resolve it from the
    // session row, which also re-checks membership. It depends on nothing
    // below, so it is read alongside the rest instead of just before enqueueing
    // the run. Only a text run has one.
    const activeOrganizationPromise = (async (): Promise<string | null> => {
        if (contentType !== "text") {
            return null;
        }

        const identity = await context.auth.getIdentity();
        const sessionId = identity?.sessionId;

        return typeof sessionId === "string"
            ? await context.runQuery(internal.auth.session_organization.getActiveOrganizationIdForSession, { sessionId, userId })
            : null;
    })();

    // A request refused below never awaits it; it is only a read.
    activeOrganizationPromise.catch(() => undefined);

    // Build message content
    const messageContent: any[] = [];

    if (body.prompt) {
        messageContent.push({ text: body.prompt.trim(), type: "text" });
    } else if (contentType === "image") {
        messageContent.push({ text: "Generate an image", type: "text" });
    } else {
        messageContent.push({ text: "Please analyze the uploaded file.", type: "text" });
    }

    // Page context goes in front of the typed text, like extracted documents,
    // wrapped as untrusted data (see `chat/lib/page-context.ts`). Text runs only:
    // a media model has no use for it.
    if (pageContext && contentType === "text") {
        messageContent.unshift(formatPageContextPart(pageContext));
    }

    const validThreadId = body.threadId && body.threadId !== "default" ? body.threadId : undefined;

    // Continuing a thread needs write access to it. Nothing checked this: the
    // continue branch below saved the prompt into whatever thread id it was
    // handed, so a signed-in caller could post into — and trigger replies in —
    // another user's thread. Regenerate has its own owner check further down.
    // Read while the attachments load; answered after them, as before.
    const accessPromise =
        validThreadId && !(body.regenerate && body.parentId)
            ? context.runQuery(internal.agent.threads.checkThreadAccessBatch, {
                  requiredPermission: "write",
                  threadId: validThreadId as Id<"threads">,
                  userId,
              })
            : undefined;

    // A refused attachment answers first and never awaits it; it is only a read.
    accessPromise?.catch(() => undefined);

    // Process file attachments. Every id must be one the caller may attach
    // (`agent_files.getFileForUser`); one they may not refuses the request —
    // it used to attach any id at all, and even a failed lookup was only
    // logged, so the ids still reached the saved message's `fileIds`.
    if (body.fileIds && body.fileIds.length > 0) {
        const attachThreadId = body.threadId && body.threadId !== "default" ? body.threadId : undefined;

        try {
            const fileResults = await Promise.all(
                body.fileIds.map(async (fileId) => {
                    const { extractedText, file, filePart, imagePart } = await getFile(context as HttpActionCtx & { storage: Signer }, fileId, {
                        ...(attachThreadId && { threadId: attachThreadId }),
                        userId,
                    });

                    return { extractedText, filename: file.filename, filePart, imagePart };
                }),
            );

            for (const { extractedText, filename, filePart, imagePart } of fileResults) {
                if (imagePart && Object.keys(imagePart).length > 0) {
                    messageContent.push(imagePart);
                } else if (extractedText) {
                    const label = filename ? `[Document: ${filename}]` : "[Attached Document]";

                    messageContent.unshift({ text: `${label}\n\n${extractedText}`, type: "text" });
                } else if (filePart && Object.keys(filePart).length > 0) {
                    messageContent.push(filePart);
                }
            }
        } catch (error) {
            if ((error as { code?: unknown }).code === "NOT_FOUND") {
                return Response.json({ error: "File not found" }, { status: 404 });
            }

            chatLogger.error("Error processing file:", error);

            return Response.json({ error: "Could not attach the file" }, { status: 400 });
        }
    }

    const access = await accessPromise;

    if (access && !access.hasAccess) {
        return Response.json({ error: "Thread not found" }, { status: 404 });
    }

    // Build streaming config
    //
    // The web client now sends the user's chosen ratio as `body.imageSize`, so
    // this is only the fallback for callers that send none. It used to read a
    // `supportedImageSizes` field that `ModelDefinition` does not have (the real
    // one is `aspectRatios`), which made the read inert and "1:1" unconditional.
    const defaultImageSize = contentType === "image" ? "1:1" : undefined;

    const streamingConfig = {
        cinemaSettings: body.cinemaSettings,
        contentType,
        customSystemPrompt: body.customSystemPrompt,
        duration: body.duration,
        enabledFeatures: body.enabledFeatures,
        imageSize: body.imageSize || defaultImageSize,
        mcpServerNames: body.mcpServerNames,
        model: effectiveModel,
        negativePrompt: body.negativePrompt,
        numImages: body.numImages,
        quality: body.quality,
        reasoningEffort: body.reasoningEffort,
        referenceImages: body.referenceImages,
        researchDepth: body.researchDepth,
        searchMode: body.searchMode,
        seed: body.seed,
        shouldAutoContinue: body.shouldAutoContinue === true,
        statelessMode: body.statelessMode,
        style: body.style,
    };

    // Rate limiting. Media prompts are charged where the paid generation actually
    // runs — `/chat/media`, which the client calls next with this prompt's id —
    // because that route can be called again for the same prompt; a charge here
    // would count the prompt, not the generations.
    if (contentType === "text") {
        const dailyLimit = await chargeDailyLimit(context, user, "Text");

        if (!dailyLimit.ok) {
            return Response.json(
                {
                    error: "DAILY_MESSAGE_LIMIT_REACHED",
                    message: "You've reached your daily message limit.",
                    retryAfter: dailyLimit.retryAfter,
                },
                { status: 403 },
            );
        }
    }

    // Create or continue thread
    let threadId: string;
    let messageId: string;
    // Title/category jobs, scheduled only once the agent run is enqueued. Text
    // prompts only: they are LLM calls, and only text was charged above
    // (`chat/lib/start-title-jobs.ts`).
    const titleJobs: (() => Promise<unknown>)[] = [];
    const scheduleTitleJobs = (titleThreadId: string, isNewThread: boolean): void => {
        const prompt = body.prompt ?? " ";

        for (const job of startTitleJobs(contentType, isNewThread)) {
            const reference = job === "title" ? internal.chat.functions.createTitleChat : internal.chat.functions.createCategoryChat;

            titleJobs.push(async () => await httpScheduler(context).runAfter(0, reference, { prompt, threadId: titleThreadId }));
        }
    };

    if (validThreadId && body.regenerate && body.parentId) {
        // Regenerate: a SIBLING reply to the same prompt row (see
        // `agent/branch-tree.ts`). This used to save a copy of the prompt, which
        // appended a duplicate turn at the end and left the old reply behind it.
        const [[prompt], regenerateThread] = await Promise.all([
            context.runQuery(internal.agent.messages.getMessagesByIds, { messageIds: [body.parentId as Id<"messages">] }),
            context.runQuery(internal.agent.threads.getThreadInternal, { threadId: validThreadId as Id<"threads"> }),
        ]);

        if (!prompt || prompt.threadId !== validThreadId || prompt.message?.role !== "user" || regenerateThread?.userId !== userId) {
            return Response.json({ error: "Invalid regenerate target" }, { status: 400 });
        }

        // The new reply will be the prompt's latest child, so pointing the
        // thread at the prompt puts it on the displayed path once it exists.
        await context.runMutation(internal.agent.branches.setActiveLeaf, {
            messageId: prompt._id as Id<"messages">,
            threadId: validThreadId as Id<"threads">,
        });

        threadId = validThreadId;
        messageId = prompt._id;
    } else if (validThreadId) {
        // Existing thread: use agent to continue and save message
        // An HTTP action has no `ctx.services`: this agent only SAVES the user's
        // message. The reply is generated by `runStreamingAgent` on the jobs queue.
        const agent = await getAgent(effectiveModel, { gateway: NO_SERVICE_FETCH, userId });

        // `agent.continueThread(context, { threadId: validThreadId })` used to run
        // here. It builds a Thread object with a dozen bound methods — and the only
        // thing read off it was `thread.threadId`, which is the id that was just
        // passed in. Removing it also removes the ctx problem: `continueThread`
        // requires a full `ActionCtx` because the Thread it returns can generate
        // text, and an HTTP handler's ctx has no `storage`.

        // Save message. `metadata.fileIds` is the attachment channel `saveMessages` reads
        // (see `SaveMessagesArgs.metadata` -> `base?.fileIds`), so it is typed, not `any`.
        const attachmentFileIds = body.fileIds && body.fileIds.length > 0 ? body.fileIds : undefined;
        const result = await agent.saveMessage(context, {
            message: { content: messageContent, role: "user" },
            ...(attachmentFileIds && { metadata: { fileIds: attachmentFileIds } }),
            promptMessageId: body.parentId,
            threadId: validThreadId,
        });

        threadId = validThreadId;
        messageId = result.messageId;

        // Title generation for existing threads too — scheduled after the agent run below.
        scheduleTitleJobs(threadId, false);
    } else {
        // New thread: batched creation
        const result = await context.runMutation(internal.chat.functions.createThreadWithInitialMessage, {
            customSystemPrompt: body.customSystemPrompt,
            enabledFeatures: body.enabledFeatures,
            fileIds: body.fileIds,
            language: body.language,
            messageContent,
            mode: body.mode,
            model: effectiveModel,
            reasoningEffort: body.reasoningEffort,
            statelessMode: body.statelessMode,
            // A media thread is titled from its prompt, with no model call.
            ...(contentType !== "text" && { title: mediaThreadTitle(body.prompt) }),
            userId,
        });

        threadId = result.threadId;
        messageId = result.messageId;

        // Title + category generation — scheduled after the agent run below.
        scheduleTitleJobs(threadId, true);
    }

    // Create persistent stream + schedule agent (text content only)
    let streamId: string | null = null;
    let streamToken: string | undefined;

    if (contentType === "text") {
        streamId = await context.runMutation(internal.chat.streaming.createStreamWithMessage, {
            messageId,
            streamingConfig,
            threadId,
            userId,
        });

        streamToken = await createStreamToken(streamId!, userId, threadId, signingSecret);

        const activeOrganizationId = await activeOrganizationPromise;

        // On the jobs queue, not the scheduler: the SchedulerDO runs jobs one at a
        // time, so a scheduled run waited behind every other user's run and
        // behind this request's own title jobs (`lib/job-queue.ts`). A queue
        // redelivery is harmless — the run claims its stream first.
        await enqueueJob(internal.chat.execute.runStreamingAgent, {
            isAnonymous,
            messageId,
            ...(activeOrganizationId && { organizationId: activeOrganizationId }),
            // The typed text, for skill-command detection. Not on regenerate: that
            // replies to an existing prompt, which the run reads from the message.
            ...(!body.regenerate && body.prompt && { userPrompt: body.prompt }),
            streamId: streamId!,
            streamingConfig: {
                ...streamingConfig,
                mcpServerNames: streamingConfig.mcpServerNames,
                researchDepth: streamingConfig.researchDepth,
                shouldAutoContinue: streamingConfig.shouldAutoContinue,
            },
            threadId,
            userId,
        });

        // The thread's `running` status was set with the stream, in
        // `createStreamWithMessage`.
    }

    // Titles and categories last: they are LLM calls on the one-at-a-time
    // scheduler, and the reply must not queue behind them. Scheduled together —
    // neither waits on the other, and the response waits on both.
    await Promise.all(titleJobs.map(async (scheduleTitleJob) => await scheduleTitleJob()));

    return Response.json(
        {
            contentType,
            messageId,
            streamId,
            streaming: contentType === "text",
            streamToken,
            ...(contentType !== "text" && { streamingConfig }),
            threadId,
        },
        { status: 200 },
    );
};

export const editMessageHttpAction = async (context: HttpActionCtx, request: Request) => {
    const { content, fileIds, messageId } = (await request.json()) as {
        content: ({ text: string; type: "text" } | { image: string; type: "image" } | { data: string; filename?: string; mimeType?: string; type: "file" })[];
        fileIds?: string[];
        messageId: string;
    };

    // Validate messageId format
    if (!messageId || !isValidDocumentIdFormat(messageId)) {
        return Response.json({ error: "Invalid message ID format" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    // Validate fileIds format if provided
    if (fileIds && fileIds.length > 0) {
        for (const fileId of fileIds) {
            if (!isValidDocumentIdFormat(fileId)) {
                return Response.json({ error: `Invalid file ID format: ${fileId}` }, { headers: { "Content-Type": "application/json" }, status: 400 });
            }
        }
    }

    let user: BetterAuthUser | undefined;

    try {
        user = await getCurrentUserInternal(context);
    } catch (error) {
        // Handle OIDC token verification errors - might be stale session
        if (isStaleSessionError(error)) {
            return Response.json(
                {
                    error: "SESSION_EXPIRED",
                    message: "Your session has expired. Please refresh the page and try again.",
                },
                { headers: { "Content-Type": "application/json" }, status: 401 },
            );
        }

        // Re-throw other errors
        throw error;
    }

    if (!user) {
        return Response.json({ error: "Not authenticated", message: "User not found" }, { headers: { "Content-Type": "application/json" }, status: 401 });
    }

    const userId = user._id;

    if (!userId) {
        return Response.json(
            { error: "User ID is required", message: "User ID not found in session" },
            { headers: { "Content-Type": "application/json" }, status: 401 },
        );
    }

    try {
        // Get the message to find its thread
        const messages = await context.runQuery(internal.agent.messages.getMessagesByIds, { messageIds: [messageId as Id<"messages">] });

        if (!messages || messages.length === 0) {
            return Response.json({ error: "Message not found" }, { headers: { "Content-Type": "application/json" }, status: 404 });
        }

        const message = messages[0];

        if (!message) {
            return Response.json({ error: "Message not found" }, { headers: { "Content-Type": "application/json" }, status: 404 });
        }

        const { threadId } = message;

        // Get thread to determine model
        const thread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

        if (!thread) {
            return Response.json({ error: "Thread not found" }, { headers: { "Content-Type": "application/json" }, status: 404 });
        }

        // Verify the authenticated user owns this thread
        if (thread.userId !== userId) {
            return Response.json({ error: "Forbidden" }, { headers: { "Content-Type": "application/json" }, status: 403 });
        }

        // An edit regenerates the reply, so it spends the same daily message quota
        // as `/chat/start` — it used to be an uncounted way to generate.
        const editLimit = await chargeDailyLimit(context, user, "Text");

        if (!editLimit.ok) {
            return Response.json(
                { error: "DAILY_MESSAGE_LIMIT_REACHED", message: "You've reached your daily message limit.", retryAfter: editLimit.retryAfter },
                { headers: { "Content-Type": "application/json" }, status: 403 },
            );
        }

        // The reply is generated by `streamAsync`, which builds its own agent;
        // this handler only saves the edit.
        const model = (thread.model as string) || "openrouter/anthropic/claude-3.5-sonnet";

        // Convert content to message format
        const messageContent: any[] = [];

        // Add file parts if fileIds are provided
        if (fileIds && fileIds.length > 0) {
            try {
                // Process files in parallel for better performance
                const fileResults = await Promise.all(
                    fileIds.map(async (fileId) => {
                        // Same check as `/chat/start`: the caller stored it, or it is
                        // already on a message in this thread.
                        const { extractedText, file, filePart, imagePart } = await getFile(context as HttpActionCtx & { storage: Signer }, fileId, {
                            threadId: threadId as string,
                            userId,
                        });

                        return { extractedText, filename: file.filename, filePart, imagePart };
                    }),
                );

                for (const { extractedText, filename, filePart, imagePart } of fileResults) {
                    if (imagePart && Object.keys(imagePart).length > 0) {
                        messageContent.push(imagePart);
                    } else if (extractedText) {
                        const label = filename ? `[Document: ${filename}]` : "[Attached Document]";

                        messageContent.push({
                            text: `${label}\n\n${extractedText}`,
                            type: "text",
                        });
                    } else if (filePart && Object.keys(filePart).length > 0) {
                        messageContent.push(filePart);
                    }
                }
            } catch (error) {
                if ((error as { code?: unknown }).code === "NOT_FOUND") {
                    return Response.json({ error: "File not found" }, { headers: { "Content-Type": "application/json" }, status: 404 });
                }

                chatLogger.error("Error processing file:", error);

                return Response.json({ error: "Could not attach the file" }, { headers: { "Content-Type": "application/json" }, status: 400 });
            }
        }

        // Add text and other content parts
        for (const part of content) {
            switch (part.type) {
                case "file": {
                    // The wire field is `mimeType`; every consumer downstream — the ai-sdk
                    // `FilePart` and `vMessage`'s `file-data` variant — spells it `mediaType`.
                    // Emitting `mimeType` here produced a part no serializer would accept.
                    messageContent.push({
                        data: part.data,
                        filename: part.filename,
                        mediaType: part.mimeType,
                        type: "file",
                    });

                    break;
                }
                case "image": {
                    messageContent.push({ image: part.image, type: "image" });

                    break;
                }
                case "text": {
                    messageContent.push({ text: part.text, type: "text" });

                    break;
                }
                // No default
                default: {
                    break;
                }
            }
        }

        // Only a prompt can be edited. The edit is saved as a SIBLING of the
        // original (see `agent/branch-tree.ts`): the original and every reply
        // after it stay in the thread, one switch away. This used to delete them.
        if (message.message?.role !== "user") {
            return Response.json({ error: "Only user messages can be edited" }, { headers: { "Content-Type": "application/json" }, status: 400 });
        }

        const editedMessageId = await context.runMutation(internal.agent.branches.saveEditedSibling, {
            fileIds: fileIds as Id<"chatFiles">[] | undefined,
            message: { content: messageContent, role: "user" },
            originalMessageId: messageId as Id<"messages">,
            userId,
        });

        // Get thread settings for generation
        const appThread = await context.runQuery(internal.chat.functions.getThreadSettings, {
            threadId,
        });

        const editedTextContent = messageContent.find((c) => c.type === "text")?.text || "";

        // Trigger a new generation after editing, on the jobs queue like
        // `/chat/start`'s run (a long run must not hold a scheduler lane).
        // `streamAsync` has no row to claim, so `once` claims the delivery for
        // it — a redelivery must not generate a second reply. A delivery that
        // dies mid-run leaves an error under the edit (`chat/edit-abandon.ts`).
        await enqueueJob(
            internal.chat.functions.streamAsync,
            {
                customSystemPrompt: appThread?.customSystemPrompt,
                enabledFeatures: appThread?.enabledFeatures,
                messageId: editedMessageId,
                model: model as string,
                parentId: editedMessageId, // Use the edited message as parent
                prompt: editedTextContent,
                reasoningEffort: appThread?.reasoningEffort,
                statelessMode: appThread?.statelessMode,
                threadId,
            },
            {
                once: {
                    onLapse: { args: { promptMessageId: editedMessageId, threadId }, ref: internal.chat.edit_abandon.failAbandonedEditReply },
                    userId,
                },
            },
        );

        return Response.json(
            {
                messageId: editedMessageId,
                streaming: true,
                success: true,
                threadId,
            },
            {
                headers: { "Content-Type": "application/json" },
                status: 200,
            },
        );
    } catch (error) {
        chatLogger.error("Error editing message:", error);

        const errorMessage = userFacingError(error)?.message ?? "Failed to edit message";

        return Response.json(
            { error: errorMessage },
            {
                headers: { "Content-Type": "application/json" },
                status: 500,
            },
        );
    }
};

/**
 * Media Generation HTTP Action
 *
 * Handles media generation (image, audio, video) with streamingConfig passed from client.
 * The setup (auth, thread, message, rate limit) is already done by /chat/stream.
 * Client receives streamingConfig from /chat/stream response and passes it here.
 */
/** Upper bound on images per `/chat/media` call — each one is a parallel paid generation. */
const MAX_IMAGES_PER_REQUEST = 4;

/** The daily quota each media content type is charged to. */
const MEDIA_LIMIT_KIND: Partial<Record<string, Exclude<DailyLimitKind, "Text">>> = { audio: "Audio", image: "Image", video: "Video" };

export const mediaGenerationHttpAction = async (context: HttpActionCtx, request: Request) => {
    const traceId = request.headers.get("x-request-id") || crypto.randomUUID();

    const {
        messageId,
        streamingConfig,
        threadId: bodyThreadId,
    } = (await request.json()) as {
        messageId: string;
        streamingConfig?: {
            cinemaSettings?: CinemaSettings;
            contentType: string;
            duration?: number;
            imageSize?: string;
            model: string;
            negativePrompt?: string;
            numImages?: number;
            quality?: "standard" | "hd";
            referenceImages?: string[];
            seed?: number;
            style?: string;
        };
        /** Routes the request to the thread owner's shard (`onThreadShard`); must name the message's thread. */
        threadId?: string;
    };

    // Validate messageId
    if (!messageId) {
        return Response.json({ error: "Missing required parameter: messageId" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    if (!isValidDocumentIdFormat(messageId)) {
        return Response.json({ error: "Invalid message ID format" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    // Validate streamingConfig
    if (!streamingConfig) {
        return Response.json({ error: "Missing required parameter: streamingConfig" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    // Authenticate user
    let user: BetterAuthUser | undefined;

    try {
        user = await getCurrentUserInternal(context);
    } catch (error) {
        if (isStaleSessionError(error)) {
            return Response.json(
                { error: "SESSION_EXPIRED", message: "Your session has expired.", traceId },
                { headers: { "Content-Type": "application/json" }, status: 401 },
            );
        }

        throw error;
    }

    if (!user) {
        return Response.json({ error: "Not authenticated" }, { headers: { "Content-Type": "application/json" }, status: 401 });
    }

    const authenticatedUserId = user._id;

    if (!authenticatedUserId) {
        return Response.json({ error: "User ID not found" }, { headers: { "Content-Type": "application/json" }, status: 401 });
    }

    // Get message to retrieve threadId and prompt content
    const messages = await context.runQuery(internal.agent.messages.getMessagesByIds, { messageIds: [messageId as Id<"messages">] });
    const message = messages?.[0];

    if (!message) {
        return Response.json({ error: "Message not found" }, { headers: { "Content-Type": "application/json" }, status: 404 });
    }

    const { threadId } = message;

    if (!threadId || !isValidDocumentIdFormat(threadId)) {
        return Response.json({ error: "Invalid thread ID" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    // The body's `threadId` chose the shard; it must be the message's own thread.
    if (bodyThreadId !== undefined && bodyThreadId !== threadId) {
        return Response.json({ error: "Message does not belong to this thread" }, { headers: { "Content-Type": "application/json" }, status: 400 });
    }

    // Only the message's author may generate for it...
    if (message.userId !== authenticatedUserId) {
        return Response.json({ error: "Forbidden" }, { headers: { "Content-Type": "application/json" }, status: 403 });
    }

    // ...and only while they may still WRITE to the thread: authorship outlives a
    // grant, so a collaborator downgraded to view (or revoked) must not start paid
    // generations that land as replies in the owner's thread. As `/chat/start`.
    const access = await context.runQuery(internal.agent.threads.checkThreadAccessBatch, {
        requiredPermission: "write",
        threadId: threadId as Id<"threads">,
        userId: authenticatedUserId,
    });

    if (!access.hasAccess) {
        return Response.json({ error: "Forbidden" }, { headers: { "Content-Type": "application/json" }, status: 403 });
    }

    // Extract config from request body (already validated above)
    const { cinemaSettings, contentType, duration, imageSize, model, negativePrompt, referenceImages, seed } = streamingConfig;

    // Every call here is a paid provider generation, and the route takes the model
    // and count from the body — so it carries its own gates rather than trusting
    // that `/chat/start` ran first:
    //  - guests never reach media (`/chat/start` pins them to a text model);
    //  - the count is clamped (it fans out into that many parallel generations);
    //  - each call is charged to the per-kind daily limit, which `/chat/start`
    //    no longer charges for media prompts.
    if (user.isAnonymous === true) {
        return Response.json({ error: "Forbidden" }, { headers: { "Content-Type": "application/json" }, status: 403 });
    }

    const numberImages = Math.min(MAX_IMAGES_PER_REQUEST, Math.max(1, Math.trunc(Number(streamingConfig.numImages ?? 1)) || 1));
    const mediaLimitKind = MEDIA_LIMIT_KIND[contentType];

    if (mediaLimitKind) {
        const mediaLimit = await chargeDailyLimit(context, user, mediaLimitKind, contentType === "image" ? numberImages : 1);

        if (!mediaLimit.ok) {
            return Response.json(
                {
                    error: `DAILY_${mediaLimitKind.toUpperCase()}_LIMIT_REACHED`,
                    message: `You've reached your daily ${mediaLimitKind.toLowerCase()} generation limit.`,
                    retryAfter: mediaLimit.retryAfter,
                },
                { headers: { "Content-Type": "application/json" }, status: 403 },
            );
        }
    }

    // Get prompt from message convenience field
    const prompt = message.text || "";

    // Claimed once on the jobs queue (`lib/job-queue.ts`); if a delivery dies
    // mid-run, its pending row is failed rather than left spinning.
    const mediaJobOptions = {
        once: {
            onLapse: { args: { threadId }, ref: internal.chat.media_abandon.failAbandonedMediaJob },
            userId: authenticatedUserId,
        },
    };

    // Handle based on content type
    if (contentType === "image") {
        // Schedule image generation
        await enqueueJob(
            internal.chat.functions.generateImage,
            {
                cinemaSettings,
                imageSize: imageSize || "1:1",
                model,
                negativePrompt,
                numImages: numberImages,
                prompt,
                // A reply to this prompt: a regenerate lands beside the earlier reply.
                promptMessageId: messageId as Id<"messages">,
                referenceImages,
                seed,
                threadId,
                userId: authenticatedUserId,
                // Note: quality and style are provider-specific and would need to be handled
                // in the generateImage function based on the provider being used
            },
            mediaJobOptions,
        );

        return Response.json(
            {
                contentType,
                messageId,
                success: true,
                threadId,
            },
            { headers: { "Content-Type": "application/json" }, status: 200 },
        );
    }

    // Handle audio generation
    if (contentType === "audio") {
        await enqueueJob(
            internal.chat.functions.generateAudio,
            {
                model,
                prompt,
                // A reply to this prompt: a regenerate lands beside the earlier reply.
                promptMessageId: messageId as Id<"messages">,
                threadId,
                userId: authenticatedUserId,
            },
            mediaJobOptions,
        );

        return Response.json(
            {
                contentType,
                messageId,
                success: true,
                threadId,
            },
            { headers: { "Content-Type": "application/json" }, status: 200 },
        );
    }

    // Handle video generation
    if (contentType === "video") {
        await enqueueJob(
            internal.chat.functions.generateVideo,
            {
                aspectRatio: imageSize, // Video uses aspectRatio instead of imageSize
                cinemaSettings,
                duration,
                model,
                prompt,
                // A reply to this prompt: a regenerate lands beside the earlier reply.
                promptMessageId: messageId as Id<"messages">,
                threadId,
                userId: authenticatedUserId,
            },
            mediaJobOptions,
        );

        return Response.json(
            {
                contentType,
                messageId,
                success: true,
                threadId,
            },
            { headers: { "Content-Type": "application/json" }, status: 200 },
        );
    }

    return Response.json({ error: "Invalid content type for media endpoint" }, { headers: { "Content-Type": "application/json" }, status: 400 });
};
