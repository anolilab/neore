/**
 * POST /v1/responses — OpenAI Responses API, translated onto the chat route.
 *
 * The request is rewritten into a `/v1/chat/completions` body and dispatched
 * in-process through the TOP-LEVEL app (`dispatch`, wired in `src/index.ts`; it
 * cannot be imported here without a cycle). The app-level middleware (request
 * id, telemetry, logging) therefore runs for the inner request, and the
 * completions route's own middleware (bearer auth, rate limit, idempotency)
 * runs once, for that inner request only. The reply is translated back by
 * `responses-map.ts`.
 *
 * Nothing is stored. `previous_response_id`, `conversation`, hosted tools and
 * background mode are refused with a 400 that names the field.
 *
 * KNOWN LIMITS, inherited from /v1/chat/completions (fix them there):
 * - `text.format` is enforced only on a non-streaming request. The chat stream
 *   carries no structured-output validation, so a streamed reply is not checked.
 * - Streamed text is not scanned for PII. Only a non-streaming reply is masked.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AppEnv, HonoEnv } from "../../env.js";
import type { ChatCompletion, ChatRequestBody } from "./responses-map.js";
import {
    chatCompletionToResponse,
    createResponsesStream,
    endOnReadError,
    isResponsesRequestError,
    passthroughHeaders,
    responsesError,
    translateRequest,
    upstreamError,
} from "./responses-map.js";

/** Sends a request through the top-level app. Wired in `src/index.ts`. */
export type Dispatch = (request: Request, env: AppEnv, ctx: Context["executionCtx"]) => Response | Promise<Response>;

/** Request headers the completions route reads: its bearer auth, its idempotency cache and the stream's CORS origin. */
const FORWARDED_HEADERS = ["authorization", "idempotency-key", "origin"] as const;

export const createResponsesRouter = (dispatch: Dispatch): OpenAPIHono<HonoEnv> => {
    const responsesRouter = new OpenAPIHono<HonoEnv>();

    responsesRouter.post("/v1/responses", async (c) => {
        let raw: unknown;

        try {
            raw = await c.req.json();
        } catch {
            return c.json(responsesError("Request body must be valid JSON."), 400);
        }

        let chat: ChatRequestBody;

        try {
            chat = translateRequest(raw);
        } catch (error) {
            if (isResponsesRequestError(error)) {
                return c.json(responsesError(error.message, { param: error.param }), 400);
            }

            throw error;
        }

        const headers = new Headers({ "Content-Type": "application/json" });

        for (const name of FORWARDED_HEADERS) {
            const value = c.req.header(name);

            if (value !== undefined) {
                headers.set(name, value);
            }
        }

        const upstream = await dispatch(
            new Request(new URL("/v1/chat/completions", c.req.url), { body: JSON.stringify(chat), headers, method: "POST" }),
            c.env,
            c.executionCtx,
        );
        const kept = passthroughHeaders(upstream.headers);

        if (!upstream.ok) {
            const text = await upstream.text();

            return c.json(upstreamError(upstream.status, text), upstream.status as ContentfulStatusCode, kept);
        }

        // A reused Idempotency-Key can replay a cached JSON reply for a stream request. Only an
        // event-stream body is translated; anything else takes the JSON path below.
        const isEventStream = upstream.headers.get("content-type")?.startsWith("text/event-stream") === true;

        if (isEventStream && upstream.body && chat.stream) {
            return new Response(endOnReadError(upstream.body).pipeThrough(createResponsesStream(chat.model)), {
                headers: {
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "Content-Type": "text/event-stream",
                    ...kept,
                },
                status: 200,
            });
        }

        const completion = (await upstream.json()) as ChatCompletion;

        return c.json(chatCompletionToResponse(completion), 200, kept);
    });

    return responsesRouter;
};
