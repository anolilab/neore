/**
 * Input validation middleware for the LLM Gateway.
 *
 * Validates common fields across internal and future client-facing endpoints:
 * - Model ID format and length
 * - Prompt/system prompt length limits
 * - Backend ID format (for Phase 5 gateway-first entry)
 * - Cinema settings type
 *
 * Applied before route-specific Zod validation to reject obviously bad requests early.
 */
import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";

const MODEL_ID_PATTERN = /^[\w./:@-]+$/;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_SYSTEM_PROMPT_LENGTH = 4000;
const LUNORA_ID_PATTERN = /^[\w-]+$/;
// Mirrors the picker cap and the backend's `generateImage` validator.
const MAX_REFERENCE_IMAGES = 4;

/**
 * The fields each middleware inspects. Every value stays `unknown` because the
 * body is unparsed JSON at this point — the runtime `typeof`/`Array.isArray`
 * guards below are what actually establish the type.
 */
interface InternalRequestBody {
    messages?: unknown;
    modelId?: unknown;
    system?: unknown;
}

interface ChatRequestBody {
    cinemaSettings?: unknown;
    customSystemPrompt?: unknown;
    fileIds?: unknown;
    messageId?: unknown;
    model?: unknown;
    parentId?: unknown;
    prompt?: unknown;
    referenceImages?: unknown;
    streamingConfig?: unknown;
    threadId?: unknown;
}

/**
 * Validates model ID, prompt lengths, and other stateless input constraints
 * on internal endpoints that receive LLM call parameters.
 */
export const inputValidationMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    if (c.req.method !== "POST") {
        return next();
    }

    const path = new URL(c.req.url).pathname;

    if (!path.startsWith("/internal/")) {
        return next();
    }

    let body: InternalRequestBody;

    try {
        body = (await c.req.json()) as InternalRequestBody;
    } catch {
        // Let downstream Zod validation handle parse errors
        return next();
    }

    // Validate modelId format (present on all internal routes)
    const modelId = body.modelId as string | undefined;

    if (modelId && (typeof modelId !== "string" || modelId.length > MAX_MODEL_ID_LENGTH || !MODEL_ID_PATTERN.test(modelId))) {
        return c.json({ error: "Invalid model ID" }, 400);
    }

    // Validate system prompt length (/internal/stream and /internal/generate)
    const system = body.system as string | undefined;

    if (system && typeof system === "string" && system.length > MAX_SYSTEM_PROMPT_LENGTH) {
        return c.json({ error: "Custom system prompt exceeds maximum allowed length (4000 characters)" }, 400);
    }

    // Validate messages total content length as a prompt length proxy
    const messages = body.messages as { content?: unknown }[] | undefined;

    if (Array.isArray(messages)) {
        let totalLength = 0;

        for (const message of messages) {
            if (typeof message.content === "string") {
                totalLength += message.content.length;
            } else if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (typeof part === "object" && part !== null && "text" in part && typeof (part as { text: unknown }).text === "string") {
                        totalLength += (part as { text: string }).text.length;
                    }
                }
            }

            if (totalLength > MAX_PROMPT_LENGTH) {
                return c.json({ error: "Prompt exceeds maximum allowed length" }, 400);
            }
        }
    }

    return next();
});

/**
 * Validates client-facing chat request fields (for Phase 5 gateway-first entry).
 * Checks backend ID formats, cinema settings, and other client-specific fields.
 *
 * Body-shape handling:
 *   - `/v1/chat/media` posts `{ messageId, streamingConfig: { model, ... } }` —
 *     the chat fields live inside `streamingConfig`. Without unwrapping, every
 *     media request hard-400s on the `body.model` check.
 *   - All other routes post the chat fields at the top level.
 */
export const chatInputValidationMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    if (c.req.method !== "POST") {
        return next();
    }

    let body: ChatRequestBody;

    try {
        body = (await c.req.json()) as ChatRequestBody;
    } catch {
        return next();
    }

    const path = new URL(c.req.url).pathname;
    const isMediaRoute = path === "/v1/chat/media";

    // For media, validate the envelope's `messageId` and pull chat fields from
    // `streamingConfig`. For every other route, the chat fields are top-level.
    if (isMediaRoute) {
        const messageId = body.messageId as string | undefined;

        if (!messageId || typeof messageId !== "string" || !LUNORA_ID_PATTERN.test(messageId)) {
            return c.json({ error: "Invalid message ID format" }, 400);
        }

        const { streamingConfig } = body;

        if (!streamingConfig || typeof streamingConfig !== "object" || Array.isArray(streamingConfig)) {
            return c.json({ error: "Invalid streamingConfig payload" }, 400);
        }
    }

    const payload: ChatRequestBody = isMediaRoute ? ((body.streamingConfig as ChatRequestBody | undefined) ?? {}) : body;

    // Model ID
    const model = payload.model as string | undefined;

    if (!model || typeof model !== "string" || model.length > MAX_MODEL_ID_LENGTH || !MODEL_ID_PATTERN.test(model)) {
        return c.json({ error: "Invalid model ID" }, 400);
    }

    // Prompt length
    const prompt = payload.prompt as string | undefined;

    if (prompt && typeof prompt === "string" && prompt.length > MAX_PROMPT_LENGTH) {
        return c.json({ error: "Prompt exceeds maximum allowed length" }, 400);
    }

    // Custom system prompt length
    const customSystemPrompt = payload.customSystemPrompt as string | undefined;

    if (customSystemPrompt && typeof customSystemPrompt === "string" && customSystemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
        return c.json({ error: "Custom system prompt exceeds maximum allowed length (4000 characters)" }, 400);
    }

    // Backend ID format checks
    const threadId = payload.threadId as string | undefined;

    if (threadId && threadId !== "default" && !LUNORA_ID_PATTERN.test(threadId)) {
        return c.json({ error: "Invalid thread ID format" }, 400);
    }

    const parentId = payload.parentId as string | undefined;

    if (parentId && !LUNORA_ID_PATTERN.test(parentId)) {
        return c.json({ error: "Invalid parent ID format" }, 400);
    }

    // File IDs format
    const fileIds = payload.fileIds as string[] | undefined;

    if (Array.isArray(fileIds)) {
        for (const fileId of fileIds) {
            if (!LUNORA_ID_PATTERN.test(fileId)) {
                return c.json({ error: `Invalid file ID format: ${fileId}` }, 400);
            }
        }
    }

    // Cinema settings type check
    const { cinemaSettings } = payload;

    if (cinemaSettings !== undefined && (typeof cinemaSettings !== "object" || cinemaSettings === null || Array.isArray(cinemaSettings))) {
        return c.json({ error: "Invalid cinemaSettings format" }, 400);
    }

    // Reference-image array (multi-ref picker on media routes).
    const { referenceImages } = payload;

    if (referenceImages !== undefined) {
        if (!Array.isArray(referenceImages) || referenceImages.length > MAX_REFERENCE_IMAGES) {
            return c.json({ error: "Invalid referenceImages payload" }, 400);
        }

        for (const url of referenceImages) {
            if (typeof url !== "string") {
                return c.json({ error: "Invalid referenceImages payload" }, 400);
            }

            try {
                // eslint-disable-next-line no-new
                new URL(url);
            } catch {
                return c.json({ error: "referenceImages contains a malformed URL" }, 400);
            }
        }
    }

    return next();
});
