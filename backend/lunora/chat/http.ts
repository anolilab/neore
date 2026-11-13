import { ANONYMOUS_FREE_MODEL } from "@neore/ai/constants";
import { enabledModelOf, MODEL_LOOKUP } from "@neore/ai/models";
import type { CinemaSettings } from "@neore/ai/types/cinema";
import { stripHiddenText } from "@neore/ai/utils";
import type { HttpActionCtx } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { isHostRunThread } from "../acp/lib/host-thread";
import { getFile } from "../agent/client";
import { requestSignIn } from "../auth/lib/request-sign-in";
import { getCurrentUserInternal } from "../auth/lib/helper";
import type { BetterAuthUser } from "../auth/lib/types";
import { assertPaidModel } from "./lib/enabled-model";
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "../lib/crypto";
import type { Signer } from "../lib/storage-sign";
import { httpScheduler } from "../lib/http-scheduler";
import { enqueueJob } from "../lib/job-queue";
import { inShard } from "../lib/http-shard";
import { chatLogger } from "../lib/logger";
import { getUserTier } from "../lib/rate-limiter";
import { SERVICE_REQUEST_WINDOW_MS } from "../lib/sign-request";
import { threadShardFor } from "../lib/thread-shard";
import { THREAD_LOCKED_CODE } from "../lib/thread-lock";
import { parseSkillCommand } from "../skills/slash-command";
import { clampGoalEffort, GOAL_TEXT_MAX } from "./goals/shared";
import { vGoalRunConfig } from "./goals/validators";
import { chargeDailyLimit, type DailyLimitKind } from "./lib/daily-limit";
import { NO_SERVICE_FETCH } from "../lib/services";
import getAgent from "./lib/get-agent";
import { capTitlePrompt, fileOnlyPromptPart } from "./lib/first-user-prompt";
import type { StartTitleJob } from "./lib/start-title-jobs";
import { mediaThreadTitle, startTitleJobs } from "./lib/start-title-jobs";
import { documentTextPart, guestNoteIdOfMessage, guestTextPart } from "./lib/attached-text";
import { unsendableGuestText } from "./lib/guest-link-store";
import { formatPageContextPart, parsePageContext } from "./lib/page-context";
import type { ChatStartRequest, StartClaim } from "./start-claim";
import { chatStartFingerprint, isValidClientMessageId, startChargeKey } from "./start-claim";
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

        return respondWithUserError(error, "Failed to improve prompt");
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

        // The refusal's own 4xx (a model filter that allows no model, unreadable settings): a 500 reads as transient and is retried.
        return Response.json({ error: userError.message }, { headers: { "Content-Type": "application/json" }, status: userError.status });
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
    /** New thread only: each send routes to a model the gateway picks (`chat/lib/auto-model.ts`). An existing thread keeps its own setting. */
    autoModel?: boolean;
    cinemaSettings?: CinemaSettings;
    /**
     * The client's own id for this send (`chat/start-claim.ts`), so a resend after an ambiguous failure saves nothing
     * twice: it is answered with the first send's ids and `duplicate: true`. 1–128 of `[A-Za-z0-9_-]`; not with `regenerate`.
     * The same id on a different send (thread, prompt, attachments, guest note, goal, or any setting) is a 422 `CLIENT_MESSAGE_ID_REUSED`.
     */
    clientMessageId?: string;
    customSystemPrompt?: string;
    duration?: number;
    enabledFeatures?: string[];
    fileIds?: string[];
    /** Run until a reviewer confirms this goal is met (`chat/goals/`). Text turns in the caller's own chat only. */
    goal?: { maxRounds?: number; text: string };
    /** A held guest note the owner sends on (`chat/guest-links.ts`): its own text is saved, marked as guest text. */
    guestMessageId?: string;
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
    /** New thread only: the composer's temporary setting, decided by the client (`chat-context.tsx`). */
    retentionHours?: number;
    searchMode?: string;
    seed?: number;
    shouldAutoContinue?: boolean;
    statelessMode?: boolean;
    style?: string;
    temporary?: boolean;
    threadId?: string;
    /** The passcode proof for a locked thread (`agent/thread-passcode.ts`). Forwarded by the gateway as is. */
    unlockProof?: string;
}

/** The answer to a chat turn aimed at a worker's thread, which runs only through `dispatchToWorker`. */
const workerThreadResponse = (): Response =>
    Response.json({ error: "This is a worker's thread. Message the worker from its thread instead of starting a chat turn here." }, { status: 400 });

/** The answer to a request that writes into a locked thread without a valid proof. */
const threadLockedResponse = (): Response => Response.json({ code: THREAD_LOCKED_CODE, error: "This chat is locked." }, { status: 403 });

/**
 * Everything `/chat/start` does once the caller is trusted: resolve the user
 * from the request identity, apply the daily limit, create or continue the
 * thread and schedule the agent.
 *
 * Split out of `chatStartHttpAction` so the public API (`public-api/router.ts`)
 * runs the SAME path — same limits, same thread creation, same stream — with
 * an API-key identity instead of the gateway's HMAC plus forwarded JWT.
 */
const cleaned = (value: unknown): unknown => (typeof value === "string" ? stripHiddenText(value).text : value);

/**
 * Every text field that reaches the model, with the hidden characters removed. The body is untrusted JSON, so each
 * field is cleaned only when it is a string; a malformed one is left for its own validation to refuse.
 */
const withoutHiddenText = (body: ChatStartBody): ChatStartBody => {
    const { goal, pageContext } = body;
    const cleanGoal = goal !== null && typeof goal === "object" && typeof goal.text === "string" ? { ...goal, text: cleaned(goal.text) as string } : goal;
    const cleanPageContext =
        pageContext !== null && typeof pageContext === "object" && !Array.isArray(pageContext)
            ? Object.fromEntries(Object.entries(pageContext).map(([key, value]) => [key, cleaned(value)]))
            : pageContext;

    return {
        ...body,
        ...(body.prompt !== undefined && { prompt: cleaned(body.prompt) as string }),
        ...(body.customSystemPrompt !== undefined && { customSystemPrompt: cleaned(body.customSystemPrompt) as string }),
        ...(body.negativePrompt !== undefined && { negativePrompt: cleaned(body.negativePrompt) as string }),
        // Stored on a new thread and interpolated into the system prompt; the other strings are model options.
        ...(body.language !== undefined && { language: cleaned(body.language) as string }),
        ...(body.style !== undefined && { style: cleaned(body.style) as string }),
        ...(body.quality !== undefined && { quality: cleaned(body.quality) as string }),
        ...(body.imageSize !== undefined && { imageSize: cleaned(body.imageSize) as string }),
        ...(body.searchMode !== undefined && { searchMode: cleaned(body.searchMode) as string }),
        ...(goal !== undefined && { goal: cleanGoal }),
        ...(pageContext !== undefined && { pageContext: cleanPageContext }),
    };
};

/** A prompt that was only hidden characters is not an omitted prompt (which means "continue"): it is refused. */
const emptyAfterStripping = (prompt: unknown): boolean => {
    if (typeof prompt !== "string") {
        return false;
    }

    const { removed, text } = stripHiddenText(prompt);

    return removed > 0 && text.trim() === "";
};

const hostRunThreadResponse = (): Response =>
    Response.json({ error: "HOST_RUN_THREAD", message: "This thread runs on a paired computer. Send the message from the desktop app." }, { status: 409 });

/** How long a send waits before it tries its failed `afterOwnerMessage` call once more. */
const AFTER_SAVE_RETRY_MS = 5000;

export const runChatStart = async (
    context: HttpActionCtx,
    rawBody: ChatStartBody,
    signingSecret: string,
    /** `outside_agent` for the public API's key callers; the user's own chat when unset. */
    origin?: "outside_agent",
): Promise<Response> => {
    // Characters that render as nothing (tag block, bidi controls) can carry instructions the person never sees. The
    // composer removes them too; this is the check no client can skip, and it covers the public API.
    if (emptyAfterStripping(rawBody.prompt)) {
        return Response.json({ error: "The prompt is empty after removing hidden characters" }, { status: 400 });
    }

    const body = withoutHiddenText(rawBody);

    // The gateway forwards this field without looking at it, so this is the
    // only place its shape and size are checked.
    const pageContext = parsePageContext(body.pageContext);

    if (pageContext === null) {
        return Response.json({ error: "Invalid pageContext" }, { status: 400 });
    }

    // A held note is a send of its own: never a regeneration, which would answer some other prompt, nor a goal, whose rounds
    // would carry the guest's words as the owner's.
    if (body.guestMessageId !== undefined && (!isValidDocumentIdFormat(body.guestMessageId) || body.regenerate)) {
        return Response.json({ error: "Invalid guestMessageId" }, { status: 400 });
    }

    if (body.clientMessageId !== undefined && (!isValidClientMessageId(body.clientMessageId) || body.regenerate)) {
        return Response.json({ error: "Invalid clientMessageId" }, { status: 400 });
    }

    if (body.guestMessageId !== undefined && body.goal !== undefined) {
        return Response.json({ error: "GUEST_NOTE_AS_GOAL", message: "A guest's message cannot be sent as a goal." }, { status: 400 });
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
    // its owner's, where the thread, its messages and this run's stream live.
    // Everything below runs there.
    const shardKey = await threadShardFor(context, userId, body.threadId);

    return await inShard(
        context,
        shardKey,
        async (shardCtx) => await runChatStartOnShard(shardCtx, body, signingSecret, { origin, pageContext, user, userId }),
    );
};

/**
 * `/chat/start`'s answer when a held guest note cannot go: each reason its own code, so the owner is told why. A
 * `Record` over the reasons, so a new reason fails the type check until it has its own answer.
 */
const GUEST_NOTE_REFUSALS: Record<"being-sent" | "ended" | "missing" | "sent", { error: string; message: string; status: 400 | 409 }> = {
    "being-sent": { error: "GUEST_NOTE_BEING_SENT", message: "That guest note is being sent.", status: 409 },
    ended: { error: "GUEST_LINK_ENDED", message: "That guest note's link has ended.", status: 400 },
    missing: { error: "GUEST_NOTE_NOT_SENDABLE", message: "That guest note cannot be sent in this chat.", status: 400 },
    sent: { error: "GUEST_NOTE_ALREADY_SENT", message: "That guest note was already sent.", status: 409 },
};

/**
 * The rest of a send's inputs for its `clientMessageId` fingerprint (`chat/start-claim.ts`), listed in a fixed order so
 * the client's key order never matters. Not the id itself, nor `unlockProof`, which a resend may refresh.
 */
const startSettingsOf = (body: ChatStartBody, pageContext: ReturnType<typeof parsePageContext>): ChatStartRequest["settings"] => {
    return {
        autoModel: body.autoModel,
        cinemaSettings: body.cinemaSettings,
        customSystemPrompt: body.customSystemPrompt,
        duration: body.duration,
        enabledFeatures: body.enabledFeatures,
        goalMaxRounds: body.goal?.maxRounds,
        imageSize: body.imageSize,
        language: body.language,
        mcpServerNames: body.mcpServerNames,
        mode: body.mode,
        model: body.model,
        negativePrompt: body.negativePrompt,
        numImages: body.numImages,
        pageContext,
        quality: body.quality,
        reasoningEffort: body.reasoningEffort,
        referenceImages: body.referenceImages,
        researchDepth: body.researchDepth,
        retentionHours: body.retentionHours,
        searchMode: body.searchMode,
        seed: body.seed,
        shouldAutoContinue: body.shouldAutoContinue,
        statelessMode: body.statelessMode,
        style: body.style,
        temporary: body.temporary,
    };
};

/** A `clientMessageId` already used for a different send (another thread, prompt or attachment): the client needs a new id. */
const startMismatchResponse = (): Response =>
    Response.json({ error: "CLIENT_MESSAGE_ID_REUSED", message: "This message id was already used for a different message." }, { status: 422 });

/** A send whose `clientMessageId` another request holds and has not saved yet: the client retries shortly. */
const startInProgressResponse = (): Response =>
    Response.json({ error: "CHAT_START_IN_PROGRESS", message: "This message is still being sent." }, { status: 409 });

const guestNoteRefused = (reason: keyof typeof GUEST_NOTE_REFUSALS): Response => {
    const { error, message, status } = GUEST_NOTE_REFUSALS[reason];

    return Response.json({ error, message }, { status });
};

const runChatStartOnShard = async (
    context: HttpActionCtx,
    body: ChatStartBody,
    signingSecret: string,
    {
        origin,
        pageContext,
        user,
        userId,
    }: {
        origin: "outside_agent" | undefined;
        pageContext: ReturnType<typeof parsePageContext>;
        user: BetterAuthUser;
        userId: NonNullable<BetterAuthUser["_id"]>;
    },
): Promise<Response> => {
    // Force anonymous users onto free model
    const isAnonymous = user.isAnonymous === true;
    // Reassigned below for a bot's thread or a switched one, and for a resend, to the model its prompt was saved with.
    let effectiveModel = isAnonymous ? ANONYMOUS_FREE_MODEL : body.model;

    // Determine content type
    const modelDefinition = MODEL_LOOKUP.get(effectiveModel);
    let contentType: "image" | "text" | "video" = "text";

    if (modelDefinition?.mode === "image") {
        contentType = "image";
    } else if (modelDefinition?.mode === "video") {
        contentType = "video";
    }

    // The gateway forwards the body unread, so the goal's shape and size are checked here.
    const goalText = typeof body.goal?.text === "string" ? body.goal.text.trim() : "";

    if (body.goal !== undefined) {
        if (contentType !== "text" || isAnonymous || body.regenerate) {
            return Response.json({ error: "A goal needs a signed-in account and a new text message." }, { status: 400 });
        }

        if (goalText.length === 0 || goalText.length > GOAL_TEXT_MAX) {
            return Response.json({ error: `A goal must be between 1 and ${GOAL_TEXT_MAX} characters.` }, { status: 400 });
        }
    }

    // The sign-in the request comes from: the web app's session (`sid`) or the extension's, desktop's or phone's grant
    // (`gsid`, which never becomes `sessionId`, `src/bearer-identity.ts`). It places the chat in its organization, so a
    // signed-in caller with neither cannot be placed and must not read as the personal space, whose cap is `auto`. A
    // public API key caller has neither; its run is held at `ask` by its origin (`apiKeyOrigin`).
    const signIn = requestSignIn(await context.auth.getIdentity());

    if (signIn === undefined && origin !== "outside_agent") {
        return Response.json({ error: "Your sign-in could not be confirmed. Sign in again, then retry." }, { status: 401 });
    }

    // The caller's active organization, from that sign-in's session row (`user.activeOrganization` is always null here:
    // no session read from an HTTP action), with its membership re-checked. A sign-in whose session is gone, expired or
    // another user's cannot be placed either, so it is refused before anything is spent or saved (below, at the first
    // write), rather than read as the personal space (`getSessionOrganizationForCap`). One that still names an
    // organization its user left is personal. It depends on nothing below, so it is read alongside the rest.
    const placedPromise =
        signIn === undefined
            ? Promise.resolve(undefined)
            : context.runQuery(internal.auth.session_organization.getSessionOrganizationForCap, { sessionId: signIn, userId });
    const sessionOrganizationPromise = placedPromise.then((placed) => placed?.organizationId ?? null);

    // A request refused before the first write never awaits these; they are only reads.
    placedPromise.catch(() => undefined);
    sessionOrganizationPromise.catch(() => undefined);

    // Scopes organization-shared skills and goals. Only a text run has one.
    const activeOrganizationPromise = contentType === "text" ? sessionOrganizationPromise : Promise.resolve(null);

    const validThreadId = body.threadId && body.threadId !== "default" ? body.threadId : undefined;
    const isGuestSend = body.guestMessageId !== undefined;
    // A held guest note goes only into its own chat, as text, and its stored text is saved, never the client's prompt.
    const guestLookup = isGuestSend
        ? await context.runQuery(internal.chat.guest_links.getGuestNoteForSend, {
              messageId: body.guestMessageId as Id<"threadGuestMessages">,
              userId,
          })
        : undefined;
    const guestRefusal = guestLookup && "refused" in guestLookup ? guestLookup.refused : undefined;
    // A resend of a send that took the note marked it sent (or holds it), or saved it before its link ended: its claim
    // answers it below, and refuses it only when this id never saved the note. A note gone or not the caller's is refused here.
    const deferredGuestRefusal = body.clientMessageId !== undefined && guestRefusal !== "missing" ? guestRefusal : undefined;

    if (guestRefusal && !deferredGuestRefusal) {
        return guestNoteRefused(guestRefusal);
    }

    const guestNote = guestLookup && !("refused" in guestLookup) ? guestLookup : undefined;

    if (guestNote && (guestNote.threadId !== validThreadId || unsendableGuestText(guestNote.text))) {
        return guestNoteRefused("missing");
    }

    // The chat's model makes images or video: the note can still go once a text model is picked, so this refusal is its own.
    if (guestNote && contentType !== "text") {
        return Response.json({ error: "GUEST_NOTE_NEEDS_TEXT_MODEL", message: "Switch to a text model to send this message." }, { status: 400 });
    }

    // Build message content
    const messageContent: any[] = [];

    if (guestNote && body.guestMessageId !== undefined) {
        // The mark carries the note's id, so a send that stored this message but no record is found later (`settleSend`).
        messageContent.push(guestTextPart(guestNote.text, body.guestMessageId));
    } else if (body.prompt) {
        messageContent.push({ text: body.prompt.trim(), type: "text" });
    } else if (contentType === "image") {
        messageContent.push({ text: "Generate an image", type: "text" });
    } else {
        messageContent.push(fileOnlyPromptPart());
    }

    // Page context goes in front of the typed text, like extracted documents,
    // wrapped as untrusted data (see `chat/lib/page-context.ts`). Text runs only:
    // a media model has no use for it.
    if (pageContext && contentType === "text") {
        messageContent.unshift(formatPageContextPart(pageContext));
    }

    // Continuing a thread needs write access to it. Nothing checked this: the
    // continue branch below saved the prompt into whatever thread id it was
    // handed, so a signed-in caller could post into — and trigger replies in —
    // another user's thread. Regenerate has its own owner check further down.
    // Read while the attachments load; answered after them, as before. A regenerate reads it too, but
    // only for the worker check below: its lock and owner checks stay with its own gate.
    const isRegenerate = Boolean(body.regenerate && body.parentId);
    const accessPromise = validThreadId
        ? context.runQuery(internal.chat.functions.gateThreadAction, {
              level: "write",
              threadId: validThreadId as Id<"threads">,
              unlockProof: body.unlockProof,
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
                        unlockProof: body.unlockProof,
                        userId,
                    });

                    return { extractedText, filename: file.filename, filePart, imagePart };
                }),
            );

            for (const { extractedText, filename, filePart, imagePart } of fileResults) {
                if (imagePart && Object.keys(imagePart).length > 0) {
                    messageContent.push(imagePart);
                } else if (extractedText) {
                    messageContent.unshift(documentTextPart(filename, extractedText));
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

    if (access?.outcome === "locked" && !isRegenerate) {
        return threadLockedResponse();
    }

    if (access && access.outcome !== "ok" && !isRegenerate) {
        return Response.json({ error: "Thread not found" }, { status: 404 });
    }

    if (access?.isWorker) {
        return workerThreadResponse();
    }

    // A goal spends the owner's budget over several rounds: refuse it in a shared thread now, before the turn is saved and charged.
    if (body.goal !== undefined && validThreadId) {
        const goalThread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: validThreadId as Id<"threads"> });

        if (goalThread?.userId !== userId) {
            return Response.json({ error: "A goal can only be set in your own chat." }, { status: 403 });
        }
    }

    // A coding agent's thread runs on its paired device, not on a cloud model. This is the one turn-start path
    // every caller shares (the app, the public API, the MCP server), so it is also the refusal they hit.
    if (access?.hostRun) {
        return hostRunThreadResponse();
    }

    // A bot thread always runs on its bot's model, whatever the composer sent. It is
    // set here, before any write, so the stream config and the agent both see it.
    // Bots chat in text only, so a media model is refused rather than swapped.
    // A regenerate's gate answer is used only for the worker check above, so it reads the thread itself.
    let threadBotId: string | undefined = access?.botId;
    // Only a thread that was switched has an agent to look up (`agent/agent-switch.ts`).
    let threadSwitched = access?.activeAgent !== undefined;

    if (validThreadId && body.regenerate && body.parentId) {
        const ownThread = await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: validThreadId as Id<"threads"> });

        // The regenerate branch skips the access gate above, so the host-run refusal is repeated here. Only for the
        // owner (the only caller a regenerate admits): a stranger gets the answer any inaccessible thread gets.
        if (ownThread?.userId === userId && isHostRunThread(ownThread)) {
            return hostRunThreadResponse();
        }

        threadBotId ??= ownThread?.botId;
        threadSwitched = ownThread?.activeAgent !== undefined;
    }

    // A chat whose bot was deleted is a plain chat again, so the bot rules apply only to a bot that still exists.
    const bot = threadBotId ? await context.runQuery(internal.bots.functions.getBotForRun, { botId: threadBotId, userId }) : null;

    if (bot) {
        if (contentType !== "text") {
            return Response.json({ error: "A bot chats in text only." }, { status: 400 });
        }

        // Anonymous callers stay on the free model, as they always do: the bot's model does not lift that.
        if (!isAnonymous) {
            effectiveModel = bot.model;
        }
    }

    // A switched thread runs on the agent its path ends on, whatever the composer sent: the model a
    // send brings only stands for a thread that was never switched. A regenerate continues from its
    // prompt's path, so it runs on what was recorded THERE (`agent/agent-switch.ts`). A model outside the
    // registry (a custom endpoint) is no switch target, so a send that names one keeps it, and a path
    // that ends on one (the thread's pre-switch model) does not override the send.
    if (validThreadId && threadSwitched && !bot && !isAnonymous && contentType === "text" && MODEL_LOOKUP.has(effectiveModel)) {
        const agentModel = await context.runQuery(internal.agent.agent_switch.getRunAgentModel, {
            ...(body.regenerate && body.parentId && { promptMessageId: body.parentId as Id<"messages"> }),
            threadId: validThreadId as Id<"threads">,
        });

        if (agentModel && MODEL_LOOKUP.has(agentModel)) {
            effectiveModel = agentModel;
        }
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
        // A goal runs Deep Work.
        shouldAutoContinue: body.shouldAutoContinue === true || body.goal !== undefined,
        statelessMode: body.statelessMode,
        style: body.style,
    };

    // The config every round of a goal runs with, checked against what `startGoal` accepts BEFORE the turn is charged
    // and saved: an ordinary send tolerates any `researchDepth` and longer lists, a goal does not.
    // A held guest note never selects a skill, whatever prompt the client sent alongside it.
    const goalSkill = body.goal === undefined || !body.prompt || guestNote ? null : parseSkillCommand(body.prompt);
    const goalConfig =
        body.goal === undefined
            ? undefined
            : vGoalRunConfig.safeParse({
                  ...(streamingConfig.customSystemPrompt !== undefined && { customSystemPrompt: streamingConfig.customSystemPrompt }),
                  ...(streamingConfig.enabledFeatures !== undefined && { enabledFeatures: streamingConfig.enabledFeatures }),
                  ...(streamingConfig.mcpServerNames !== undefined && { mcpServerNames: streamingConfig.mcpServerNames }),
                  model: streamingConfig.model,
                  ...(streamingConfig.reasoningEffort !== undefined && { reasoningEffort: clampGoalEffort(streamingConfig.reasoningEffort) }),
                  ...(streamingConfig.researchDepth !== undefined && { researchDepth: streamingConfig.researchDepth }),
                  ...(streamingConfig.searchMode !== undefined && { searchMode: streamingConfig.searchMode }),
                  ...(streamingConfig.statelessMode !== undefined && { statelessMode: streamingConfig.statelessMode }),
                  // Every round runs as this one does: an API key's tool limits and the invoked skill carry through.
                  ...(origin && { origin }),
                  ...(goalSkill && { skill: goalSkill }),
              });

    if (goalConfig && !goalConfig.ok) {
        return Response.json({ error: "These chat settings cannot be used with a goal." }, { status: 400 });
    }

    // The sign-in check, read alongside the rest: an unconfirmed sign-in is refused here, before the first write.
    if ((await placedPromise) === null) {
        return Response.json({ error: "Your sign-in could not be confirmed. Sign in again, then retry." }, { status: 401 });
    }

    // Rate limiting. Media prompts are charged where the paid generation actually
    // runs — `/chat/media`, which the client calls next with this prompt's id —
    // because that route can be called again for the same prompt; a charge here
    // would count the prompt, not the generations.
    // A send with a client id is taken before the charge too: a resend is answered with the first send's ids, uncharged.
    // Its fingerprint binds the id to this thread and prompt, so a duplicate's thread is the one gated above (or the
    // caller's own new chat), and the same id on another send is refused.
    const startFingerprint =
        body.clientMessageId === undefined
            ? undefined
            : await chatStartFingerprint({
                  contentType,
                  ...(body.fileIds !== undefined && { fileIds: body.fileIds }),
                  ...(body.goal !== undefined && { goal: goalText }),
                  ...(body.guestMessageId !== undefined && { guestMessageId: body.guestMessageId }),
                  ...(body.parentId !== undefined && { parentId: body.parentId }),
                  ...(body.prompt !== undefined && { prompt: body.prompt }),
                  settings: startSettingsOf(body, pageContext),
                  ...(validThreadId !== undefined && { threadId: validThreadId }),
              });
    const startOutcome =
        body.clientMessageId === undefined || startFingerprint === undefined
            ? undefined
            : await context.runMutation(internal.chat.start_claim.claimChatStart, {
                  clientMessageId: body.clientMessageId,
                  fingerprint: startFingerprint,
                  streams: contentType === "text",
                  userId,
              });

    if (startOutcome?.outcome === "mismatch") {
        return startMismatchResponse();
    }

    if (startOutcome?.outcome === "in_progress") {
        return startInProgressResponse();
    }

    // The first send's goal was refused after its prompt was saved: the same answer, and no run.
    if (startOutcome?.outcome === "refused") {
        return Response.json({ error: startOutcome.error }, { status: 400 });
    }

    // A resend runs on the model its first try saved the prompt with: the thread's agent may have been switched since.
    const savedModel = startOutcome?.outcome === "duplicate" || startOutcome?.outcome === "resume" ? startOutcome.model : undefined;

    if (savedModel !== undefined) {
        effectiveModel = savedModel;
        streamingConfig.model = savedModel;
    }

    // The run of a text turn, on the jobs queue. A queue redelivery, or a second submission, is harmless: the run claims its stream first.
    const enqueueRun = async (run: { messageId: string; streamId: string; threadId: string }): Promise<void> => {
        const activeOrganizationId = await activeOrganizationPromise;

        await enqueueJob(internal.chat.execute.runStreamingAgent, {
            isAnonymous,
            messageId: run.messageId,
            ...(activeOrganizationId && { organizationId: activeOrganizationId }),
            ...(origin && { origin }),
            // The typed text, for skill-command detection. Not on regenerate: that
            // replies to an existing prompt, which the run reads from the message.
            // A guest note's text is not the owner's, so it is never handed over for skill detection.
            ...(!body.regenerate && !isGuestSend && body.prompt && { userPrompt: body.prompt }),
            streamId: run.streamId,
            streamingConfig: {
                ...streamingConfig,
                mcpServerNames: streamingConfig.mcpServerNames,
                researchDepth: streamingConfig.researchDepth,
                shouldAutoContinue: streamingConfig.shouldAutoContinue,
            },
            threadId: run.threadId,
            userId,
        });
    };

    // Title/category jobs, scheduled only once the agent run is enqueued. Text
    // prompts only: they are LLM calls, and only text was charged above
    // (`chat/lib/start-title-jobs.ts`).
    const titleJobs: { job: StartTitleJob; schedule: () => Promise<unknown> }[] = [];
    const scheduleTitleJobs = (titleThreadId: string, promptId: string, jobs: StartTitleJob[]): void => {
        // Capped where it is sent: the title is generated from the first characters of the prompt only.
        const prompt = capTitlePrompt(body.prompt ?? " ");

        for (const job of jobs) {
            if (job === "title") {
                // A fresh id per scheduled title job: its retries carry the same id (and so the same billing key), a later message's job does not.
                // A send with a client id is keyed by its prompt, so a resend that schedules the title again shares the first one's charge.
                const jobId = body.clientMessageId === undefined ? crypto.randomUUID() : promptId;

                // The prompt's id: the job refuses to title from a prompt deleted before it runs.
                titleJobs.push({
                    job,
                    schedule: async () =>
                        await httpScheduler(context).runAfter(0, internal.chat.functions.createTitleChat, {
                            jobId,
                            prompt,
                            promptId,
                            threadId: titleThreadId,
                        }),
                });
            } else {
                // Keyed by the prompt too: one delivery per prompt calls the model, however often the job was scheduled.
                titleJobs.push({
                    job,
                    schedule: async () =>
                        await httpScheduler(context).runAfter(0, internal.chat.functions.createCategoryChat, { prompt, promptId, threadId: titleThreadId }),
                });
            }
        }
    };

    // Titles and categories last: they are LLM calls on the one-at-a-time
    // scheduler, and the reply must not queue behind them. Scheduled together —
    // neither waits on the other, and the response waits on both.
    // The turn is already saved, charged and queued: a title job that cannot be scheduled must not fail the
    // request, or a retry (and an idempotency key) would run the turn a second time.
    // The jobs that were scheduled.
    const runTitleJobs = async (): Promise<StartTitleJob[]> => {
        const titled = await Promise.allSettled(titleJobs.map(async ({ schedule }) => await schedule()));
        const scheduled: StartTitleJob[] = [];

        for (const [index, outcome] of titled.entries()) {
            if (outcome.status === "rejected") {
                chatLogger.warn("Failed to schedule a title job after the turn was queued:", outcome.reason);
            } else if (titleJobs[index]) {
                scheduled.push(titleJobs[index].job);
            }
        }

        return scheduled;
    };

    // A claimed send's title jobs that were scheduled, each on its own: a resend schedules only the others (`claimChatStart`).
    // Never throws: a job a resend schedules again is charged once anyway, as both are keyed by the prompt.
    const recordTitlesScheduled = async (claim: StartClaim, promptId: string, jobs: StartTitleJob[]): Promise<void> => {
        if (jobs.length === 0) {
            return;
        }

        await context.runMutation(internal.chat.start_claim.recordStartTitlesScheduled, { claim, jobs, messageId: promptId }).catch((error: unknown) => {
            chatLogger.warn("Could not record a send's title jobs as scheduled:", error);
        });
    };

    /**
     * The message is saved, whatever its content: a sub-agent waiting on this thread ends its wait, and a result held for
     * the owner's own request here is released (`afterOwnerMessage`, idempotent). Its own transaction, after the save and
     * its claim: a failure is logged and never fails this send, whose prompt is saved and charged. A new thread can be
     * neither a sub-agent's child nor hold a request, so it costs nothing. Once per send, whichever path reaches it.
     */
    let afterSaveDone = false;
    const afterSave = async (savedThreadId: string): Promise<void> => {
        if (validThreadId === undefined || afterSaveDone) {
            return;
        }

        afterSaveDone = true;

        // A failed call is tried once more shortly (it is idempotent); only a failed retry schedule is logged.
        await context.runMutation(internal.sub_agents.functions.afterOwnerMessage, { threadId: savedThreadId }).catch(async () => {
            await httpScheduler(context)
                .runAfter(AFTER_SAVE_RETRY_MS, internal.sub_agents.functions.afterOwnerMessage, { threadId: savedThreadId })
                .catch((error: unknown) => {
                    chatLogger.error("[chat] Could not end a sub-agent's wait or release its held results, nor schedule a retry", error);
                });
        });
    };

    if (startOutcome?.outcome === "duplicate") {
        // The stream token attaches to the first send's run as a reconnect does; a run that ended reads from the thread.
        const { messageId, streamId: duplicateStreamId, threadId } = startOutcome;

        // The first send recorded its stream but its run never started (its queue submission failed, or is still in flight):
        // submitted again, so the reply is not lost.
        try {
            if (duplicateStreamId !== undefined && startOutcome.streamUnclaimed === true) {
                await enqueueRun({ messageId, streamId: duplicateStreamId, threadId });
            }
        } finally {
            // The first try may have died before its own call: a resend makes it, whether or not its run's submission
            // succeeds (it is idempotent and catches its own errors).
            await afterSave(threadId);

            // Title jobs no try recorded scheduled: they follow the run, so a failed submission skipped them, or one was refused.
            // Each is recorded once scheduled; one this resend fails to schedule, or dies before, is left to the next.
            // A guest note's text never reaches the title model.
            const pending = startOutcome.titleJobs;

            if (pending !== undefined && !isGuestSend) {
                scheduleTitleJobs(threadId, messageId, pending.jobs);
                await recordTitlesScheduled(pending.claim, messageId, await runTitleJobs());
            }
        }

        return Response.json(
            {
                contentType,
                duplicate: true,
                messageId,
                streamId: duplicateStreamId ?? null,
                streaming: duplicateStreamId !== undefined,
                ...(duplicateStreamId !== undefined && { streamToken: await createStreamToken(duplicateStreamId, userId, threadId, signingSecret) }),
                ...(contentType !== "text" && { streamingConfig }),
                threadId,
            },
            { status: 200 },
        );
    }

    const startClaim = startOutcome?.claim;
    // A text turn whose first send saved its prompt and died before its stream: this request makes the stream and run only.
    const resumed = startOutcome?.outcome === "resume" ? startOutcome : undefined;

    // Never throws, like the guest send's release: kept when the save recorded its ids.
    const releaseStartClaim = async (): Promise<void> => {
        if (startClaim === undefined) {
            return;
        }

        try {
            await context.runMutation(internal.chat.start_claim.releaseChatStart, { claim: startClaim });
        } catch (releaseError) {
            chatLogger.error("Could not release a chat send's claim:", releaseError);
        }
    };

    // The note was sent, or is being sent, by another send than this id's, or its link ended before this id saved it:
    // refused as without an id. Nothing was saved, so the `messageContent` built without the note's text is never used.
    if (deferredGuestRefusal && !resumed) {
        await releaseStartClaim();

        return guestNoteRefused(deferredGuestRefusal);
    }

    // A held note's send is taken before the charge, so one concurrent send wins and only it is charged (`settleSend` after).
    const guestClaim =
        guestNote && !resumed
            ? await context
                  .runMutation(internal.chat.guest_links.claimGuestNoteSend, {
                      messageId: body.guestMessageId as Id<"threadGuestMessages">,
                      userId,
                  })
                  .catch(async (error: unknown) => {
                      await releaseStartClaim();

                      throw error;
                  })
            : undefined;

    if (guestClaim && "refused" in guestClaim) {
        await releaseStartClaim();

        return guestNoteRefused(guestClaim.refused);
    }

    const guestSend = guestClaim?.fence;

    // Never throws: a failed release must not hide why the send failed. The lease settles the send later.
    const releaseGuestSend = async (): Promise<void> => {
        await releaseStartClaim();

        if (guestSend === undefined) {
            return;
        }

        try {
            await context.runMutation(internal.chat.guest_links.releaseGuestNoteSend, {
                claimedAt: guestSend,
                messageId: body.guestMessageId as Id<"threadGuestMessages">,
            });
        } catch (releaseError) {
            chatLogger.error("[GuestLink] Could not release a guest send:", releaseError);
        }
    };

    // A resumed send was charged by its first try.
    if (contentType === "text" && !resumed) {
        // A keyed send is charged once per send: a retry after a failed save, which gave its claim back, is not charged again.
        const chargeKey =
            body.clientMessageId === undefined || startFingerprint === undefined ? undefined : startChargeKey(userId, body.clientMessageId, startFingerprint);
        const dailyLimit = await chargeDailyLimit(context, user, "Text", 1, { ...(chargeKey !== undefined && { chargeKey }) }).catch(async (error: unknown) => {
            await releaseGuestSend();

            throw error;
        });

        if (!dailyLimit.ok) {
            await releaseGuestSend();

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

    if (resumed) {
        threadId = resumed.threadId;
        messageId = resumed.messageId;

        if (isGuestSend) {
            // The dead send saved the note but may not have marked it sent; a failure is logged and settled later (`settleSend`).
            try {
                await context.runMutation(internal.chat.guest_links.recordResumedGuestNoteSent, {
                    messageId: body.guestMessageId as Id<"threadGuestMessages">,
                    savedMessageId: messageId,
                    userId,
                });
            } catch (error) {
                chatLogger.error("[GuestLink] Could not record a resumed send's note:", error);
            }
        } else {
            // The dead send's title jobs were to be scheduled after its run, which it never queued.
            scheduleTitleJobs(threadId, messageId, startTitleJobs(contentType, resumed.newThread === true));
        }
    } else if (validThreadId && body.regenerate && body.parentId) {
        // Regenerate: a SIBLING reply to the same prompt row (see
        // `agent/branch-tree.ts`). This used to save a copy of the prompt, which
        // appended a duplicate turn at the end and left the old reply behind it.
        // A regenerate writes a sibling reply, so a locked chat needs its proof here.
        // The gate runs first: with a valid proof the prompt read below passes the lock filter.
        const regenerateGate = await context.runQuery(internal.chat.functions.gateThreadAction, {
            level: "write",
            threadId: validThreadId as Id<"threads">,
            unlockProof: body.unlockProof,
            userId,
        });

        if (regenerateGate.outcome === "locked") {
            return threadLockedResponse();
        }

        const [[prompt], regenerateThread] = await Promise.all([
            context.runQuery(internal.agent.messages.getMessagesByIds, {
                messageIds: [body.parentId as Id<"messages">],
                threadId: validThreadId as Id<"threads">,
                unlockProof: body.unlockProof,
            }),
            context.runQuery(internal.agent.threads.getThreadInternal, { threadId: validThreadId as Id<"threads"> }),
        ]);

        if (!prompt || prompt.threadId !== validThreadId || prompt.message?.role !== "user" || regenerateThread?.userId !== userId) {
            return Response.json({ error: "Invalid regenerate target" }, { status: 400 });
        }

        // The new reply will be the prompt's latest child, so pointing the
        // thread at the prompt puts it on the displayed path once it exists.
        await context.runMutation(internal.agent.branches.setActiveLeaf, {
            messageId: prompt._id as Id<"messages">,
            runModel: effectiveModel,
            threadId: validThreadId as Id<"threads">,
        });

        threadId = validThreadId;
        messageId = prompt._id;
    } else if (validThreadId) {
        // Existing thread: use agent to continue and save message
        // An HTTP action has no `ctx.services`: this agent only SAVES the user's
        // message. The reply is generated by `runStreamingAgent` on the jobs queue.
        // Save message. `metadata.fileIds` is the attachment channel `saveMessages` reads
        // (see `SaveMessagesArgs.metadata` -> `base?.fileIds`), so it is typed, not `any`.
        const attachmentFileIds = body.fileIds && body.fileIds.length > 0 ? body.fileIds : undefined;
        // A send with a client id saves in the mutation that checks its claim and records the ids on it.
        const savePrompt = async (): Promise<{ messageId: string }> => {
            if (startClaim !== undefined) {
                return await context.runMutation(internal.chat.start_claim.saveStartPrompt, {
                    claim: startClaim,
                    ...(attachmentFileIds && { fileIds: attachmentFileIds }),
                    messageContent,
                    model: effectiveModel,
                    ...(body.parentId !== undefined && { parentId: body.parentId }),
                    threadId: validThreadId,
                });
            }

            // An HTTP action has no `ctx.services`: this agent only SAVES the user's
            // message. The reply is generated by `runStreamingAgent` on the jobs queue.
            const agent = await getAgent(effectiveModel, { gateway: NO_SERVICE_FETCH, userId });

            return await agent.saveMessage(context, {
                fromUser: true,
                message: { content: messageContent, role: "user" },
                ...(attachmentFileIds && { metadata: { fileIds: attachmentFileIds } }),
                promptMessageId: body.parentId,
                threadId: validThreadId,
            });
        };
        const result = await savePrompt().catch(async (error: unknown) => {
            // Released, or marked sent if the save committed after all.
            await releaseGuestSend();

            throw error;
        });

        threadId = validThreadId;
        messageId = result.messageId;

        // One write records the saved message and marks the note sent; a failed one is logged and settled later (`settleSend`).
        if (guestSend !== undefined) {
            try {
                const recorded = await context.runMutation(internal.chat.guest_links.recordGuestNoteSent, {
                    claimedAt: guestSend,
                    messageId: body.guestMessageId as Id<"threadGuestMessages">,
                    savedMessageId: messageId,
                });

                if (!recorded) {
                    chatLogger.warn("[GuestLink] A sent note's record found its send taken over", { savedMessageId: messageId });
                }
            } catch (error) {
                chatLogger.error("[GuestLink] Could not record a sent note:", error);
            }
        }

        // Title generation for existing threads too — scheduled after the agent run below.
        // A guest note's text never reaches the title model.
        if (!isGuestSend) {
            scheduleTitleJobs(threadId, messageId, startTitleJobs(contentType, false));
        }
    } else {
        // The organization goes in with the insert, so no chat exists without it. Read first: a failed lookup refuses the
        // request before anything is saved, rather than leaving a chat a later run would cap by a broader space.
        const threadOrganizationId = await sessionOrganizationPromise;

        // New thread: batched creation
        const result = await context
            .runMutation(internal.chat.functions.createThreadWithInitialMessage, {
                // A plain hosted text thread only: a guest, a media thread and a custom endpoint have nothing to route.
                ...(body.autoModel === true && contentType === "text" && !isAnonymous && MODEL_LOOKUP.has(effectiveModel) && { autoModel: true }),
                customSystemPrompt: body.customSystemPrompt,
                enabledFeatures: body.enabledFeatures,
                fileIds: body.fileIds,
                language: body.language,
                messageContent,
                mode: body.mode,
                model: effectiveModel,
                ...(threadOrganizationId && { organizationId: threadOrganizationId }),
                reasoningEffort: body.reasoningEffort,
                statelessMode: body.statelessMode,
                // Temporary only when the client asked for it; the composer applies the user's default itself.
                ...(body.temporary === true && { retentionHours: body.retentionHours, temporary: true }),
                ...(startClaim !== undefined && { startClaim }),
                // A media thread is titled from its prompt, with no model call.
                ...(contentType !== "text" && { title: mediaThreadTitle(body.prompt) }),
                userId,
            })
            .catch(async (error: unknown) => {
                await releaseStartClaim();

                throw error;
            });

        threadId = result.threadId;
        messageId = result.messageId;

        // Title + category generation — scheduled after the agent run below.
        scheduleTitleJobs(threadId, messageId, startTitleJobs(contentType, true));
    }

    // Create persistent stream + schedule agent (text content only)
    let streamId: string | null = null;
    let streamToken: string | undefined;

    // The prompt is saved from here on: a stream or run that fails still ends a sub-agent's wait (`afterSave`, once).
    try {
        if (contentType === "text") {
            const activeOrganizationId = await activeOrganizationPromise;
            let goalId: Id<"threadGoals"> | undefined;

            if (body.goal !== undefined && goalConfig?.ok) {
                const started = await context.runMutation(internal.chat.goals.internal.startGoal, {
                    // The goal's config was checked with the resolved model; a resumed send runs on its saved one.
                    config: { ...goalConfig.value, model: effectiveModel },
                    ...(typeof body.goal.maxRounds === "number" && { maxRounds: body.goal.maxRounds }),
                    ...(activeOrganizationId && { organizationId: activeOrganizationId }),
                    promptMessageId: messageId,
                    ...(startClaim !== undefined && { startClaim }),
                    // The trimmed text the length check above passed, so a padded goal cannot fail validation after the charge.
                    text: goalText,
                    threadId: threadId as Id<"threads">,
                    userId,
                });

                if (!started.ok) {
                    // The prompt is saved though its goal is refused: it moved the thread past what it waited on all the same.
                    await afterSave(threadId);

                    return Response.json({ error: started.error }, { status: 400 });
                }

                goalId = started.goalId;
            }

            streamId = await context.runMutation(internal.chat.streaming.createStreamWithMessage, {
                ...(goalId && { goalId }),
                messageId,
                ...(startClaim !== undefined && { startClaim }),
                streamingConfig,
                threadId,
                userId,
            });

            streamToken = await createStreamToken(streamId!, userId, threadId, signingSecret);

            // On the jobs queue, not the scheduler: the SchedulerDO runs jobs one at a
            // time, so a scheduled run waited behind every other user's run and
            // behind this request's own title jobs (`lib/job-queue.ts`).
            await enqueueRun({ messageId, streamId: streamId!, threadId });

            // The thread's `running` status was set with the stream, in
            // `createStreamWithMessage`.
        }
    } catch (error) {
        await afterSave(threadId);

        throw error;
    }

    // A claimed send records each title job it scheduled, so a resend schedules only one it could not.
    const [, scheduledTitleJobs] = await Promise.all([afterSave(threadId), runTitleJobs()]);

    if (startClaim !== undefined) {
        await recordTitlesScheduled(startClaim, messageId, scheduledTitleJobs);
    }

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
    const { content, fileIds, messageId, unlockProof } = (await request.json()) as {
        content: ({ text: string; type: "text" } | { image: string; type: "image" } | { data: string; filename?: string; mimeType?: string; type: "file" })[];
        fileIds?: string[];
        messageId: string;
        unlockProof?: string;
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
        // Get the message to find its thread. The thread is not known yet, so the raw row is read and the gate below decides.
        const messages = await context.runQuery(internal.agent.messages.getMessagesByIdsUnfiltered, { messageIds: [messageId as Id<"messages">] });

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

        // A message in a thread the caller does not own answers exactly like a message that does not exist,
        // so a message id cannot be probed (a locked chat's included).
        if (!thread || thread.userId !== userId) {
            return Response.json({ error: "Message not found" }, { headers: { "Content-Type": "application/json" }, status: 404 });
        }

        // An edit writes a sibling prompt and a reply into the thread: a locked chat needs its proof.
        const gateResult = await context.runQuery(internal.chat.functions.gateThreadAction, {
            level: "write",
            threadId: threadId as Id<"threads">,
            unlockProof,
            userId,
        });

        if (gateResult.outcome === "locked") {
            return threadLockedResponse();
        }

        if (gateResult.isWorker) {
            return workerThreadResponse();
        }

        // The reply would come from a cloud model, in a thread the desktop owns.
        if (gateResult.hostRun) {
            return hostRunThreadResponse();
        }

        // An edit of a guest's note the owner sent on is still the guest's words: it keeps the mark and the note's id.
        const guestNoteId = guestNoteIdOfMessage(message.message as Parameters<typeof guestNoteIdOfMessage>[0]);

        // A stateless reply saves its prompt again from the plain text (`streamAsync`), an untagged copy of the guest's words
        // under the tagged edit: refused there, before anything is saved or charged.
        if (guestNoteId !== undefined && thread.statelessMode === true) {
            return Response.json(
                { error: "A guest's message cannot be edited in a chat without memory." },
                { headers: { "Content-Type": "application/json" }, status: 400 },
            );
        }

        // The reply is generated by `streamAsync`, which builds its own agent;
        // this handler only saves the edit.
        // A switched thread's reply runs on what the path above the edited prompt ends on.
        const model =
            (await context.runQuery(internal.agent.agent_switch.getRunAgentModel, {
                replacedMessageId: messageId as Id<"messages">,
                threadId: threadId as Id<"threads">,
            })) ??
            ((thread.model as string) || "openrouter/anthropic/claude-3.5-sonnet");

        // The path's model may have been picked before a plan lapsed (or by a collaborator, against their plan):
        // the edit's reply runs under the owner's plan, so a paid model it can no longer run is refused here, as a
        // send would be, before the edit is saved.
        const pathModel = enabledModelOf(model, { mode: "text" });

        if (pathModel) {
            try {
                await assertPaidModel(context, userId, pathModel);
            } catch (error) {
                if (error instanceof LunoraError) {
                    return Response.json(
                        { error: "MODEL_REQUIRES_PLAN", message: error.message },
                        { headers: { "Content-Type": "application/json" }, status: 403 },
                    );
                }

                throw error;
            }
        }

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
                            unlockProof,
                            userId,
                        });

                        return { extractedText, filename: file.filename, filePart, imagePart };
                    }),
                );

                for (const { extractedText, filename, filePart, imagePart } of fileResults) {
                    if (imagePart && Object.keys(imagePart).length > 0) {
                        messageContent.push(imagePart);
                    } else if (extractedText) {
                        messageContent.push(documentTextPart(filename, extractedText));
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
        let droppedHiddenOnlyText = false;

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
                    if (typeof part.text !== "string") {
                        return Response.json({ error: "A text part needs a text string" }, { headers: { "Content-Type": "application/json" }, status: 400 });
                    }

                    // The edit is a prompt like any other: the composer strips, and this is the check no client can skip.
                    const { removed, text } = stripHiddenText(part.text);

                    // A text part that was only hidden characters is dropped; the edit is refused below only when nothing else is left.
                    if (removed > 0 && text.trim() === "") {
                        droppedHiddenOnlyText = true;

                        break;
                    }

                    messageContent.push(guestNoteId === undefined ? { text, type: "text" } : guestTextPart(text, guestNoteId));

                    break;
                }
                // No default
                default: {
                    break;
                }
            }
        }

        if (droppedHiddenOnlyText && messageContent.length === 0) {
            return Response.json(
                { error: "The prompt is empty after removing hidden characters" },
                { headers: { "Content-Type": "application/json" }, status: 400 },
            );
        }

        // Only a prompt can be edited. The edit is saved as a SIBLING of the
        // original (see `agent/branch-tree.ts`): the original and every reply
        // after it stay in the thread, one switch away. This used to delete them.
        if (message.message?.role !== "user") {
            return Response.json({ error: "Only user messages can be edited" }, { headers: { "Content-Type": "application/json" }, status: 400 });
        }

        // An edit regenerates the reply, so it spends the same daily message quota
        // as `/chat/start` — it used to be an uncounted way to generate.
        // Charged after every refusal above (hidden-only text, a missing file, a non-prompt), so a refused edit costs nothing.
        const editLimit = await chargeDailyLimit(context, user, "Text");

        if (!editLimit.ok) {
            return Response.json(
                { error: "DAILY_MESSAGE_LIMIT_REACHED", message: "You've reached your daily message limit.", retryAfter: editLimit.retryAfter },
                { headers: { "Content-Type": "application/json" }, status: 403 },
            );
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
        unlockProof,
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
        unlockProof?: string;
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

    // Get message to retrieve threadId and prompt content. The gate below refuses a locked thread without its proof.
    const messages = await context.runQuery(internal.agent.messages.getMessagesByIdsUnfiltered, { messageIds: [messageId as Id<"messages">] });
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
    const access = await context.runQuery(internal.chat.functions.gateThreadAction, {
        level: "write",
        threadId: threadId as Id<"threads">,
        unlockProof,
        userId: authenticatedUserId,
    });

    if (access.outcome === "locked") {
        return threadLockedResponse();
    }

    if (access.outcome !== "ok") {
        return Response.json({ error: "Forbidden" }, { headers: { "Content-Type": "application/json" }, status: 403 });
    }

    if (access.isWorker) {
        return workerThreadResponse();
    }

    // The reply would come from a cloud model, in a thread the desktop owns.
    if (access.hostRun) {
        return hostRunThreadResponse();
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
