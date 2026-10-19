/**
 * POST /v1/responses — OpenAI Responses API, translated onto the chat route.
 *
 * The request is rewritten into a `/v1/chat/completions` body and dispatched
 * in-process through the TOP-LEVEL app (`dispatch`, wired in `src/index.ts`; it
 * cannot be imported here without a cycle). The inner request adopts the outer
 * one's request id and telemetry (`lib/dispatched-request.ts`), so the app-level
 * middleware records the call once, on the outer `/v1/responses` request: one
 * root span, one `gateway.requests_total`, one log line. The completions route's
 * own middleware (bearer auth, rate limit, idempotency) runs once, for the inner
 * request. The reply is translated back by `responses-map.ts`.
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
import { asDispatchedEnv } from "../../lib/dispatched-request.js";
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

/** Request headers passed on as they are: the completions route's bearer auth and the stream's CORS origin. The idempotency key is forwarded separately, namespaced. */
const FORWARDED_HEADERS = ["authorization", "origin"] as const;

const GATEWAY_KEY_AUTHORIZATION_PREFIX = "Bearer gk_";

/**
 * The chat route's idempotency cache is keyed by user and key alone, so a key a caller also used on
 * `/v1/chat/completions` would replay that route's reply here. A prefix keeps the two namespaces apart.
 */
const IDEMPOTENCY_KEY_PREFIX = "responses:";

export const createResponsesRouter = (dispatch: Dispatch): OpenAPIHono<HonoEnv> => {
    const responsesRouter = new OpenAPIHono<HonoEnv>();

    responsesRouter.post("/v1/responses", async (c) => {
        // Refuse a caller that cannot hold a key before any work: the body is parsed and translated
        // here, and only the dispatched chat request checks the key itself. The shape is the one
        // `bearerAuth` demands first (`Bearer gk_…`), so a stray header does not buy a parse.
        if (!c.req.header("Authorization")?.startsWith(GATEWAY_KEY_AUTHORIZATION_PREFIX)) {
            return c.json(responsesError("Missing or invalid Authorization header."), 401);
        }

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

        const idempotencyKey = c.req.header("idempotency-key");

        if (idempotencyKey !== undefined) {
            headers.set("idempotency-key", `${IDEMPOTENCY_KEY_PREFIX}${idempotencyKey}`);
        }

        const upstream = await dispatch(
            new Request(new URL("/v1/chat/completions", c.req.url), { body: JSON.stringify(chat), headers, method: "POST" }),
            asDispatchedEnv(c.env, { requestId: c.get("requestId"), rootSpan: c.get("rootSpan"), telemetry: c.get("telemetry") }),
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
