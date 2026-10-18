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
 * A non-streaming request that declares `tools` is dispatched as a stream and
 * folded into one Responses object, because completions' non-streaming reply
 * carries no `tool_calls`. The folded text gets the same output PII mask that
 * completions applies to its non-streaming reply.
 *
 * Nothing is stored. `previous_response_id`, `conversation`, hosted tools,
 * background mode, and a `tool_choice` other than "auto" are refused with a 400
 * that names the field.
 *
 * KNOWN LIMITS, inherited from /v1/chat/completions (fix them there):
 * - Assistant `tool_calls` in the history are not replayed to the model
 *   (completions' `convertMessages` drops them), and tool results carry no tool
 *   name. A multi-turn tool conversation loses its own calls.
 * - Streams carry no usage, so a streamed or folded `response.completed` reports
 *   `usage: null`.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AppEnv, HonoEnv } from "../../env.js";
import { DEFAULT_GUARDRAIL_CONFIG, scanOutput } from "../../lib/guardrails.js";
import type { ChatCompletion, ChatRequestBody, ResponseObject } from "./responses-map.js";
import {
    chatCompletionToResponse,
    createResponsesStream,
    foldResponsesStream,
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

const maskText = (text: string): string => {
    const scan = scanOutput(text, DEFAULT_GUARDRAIL_CONFIG);

    return scan.action === "mask" && scan.maskedContent !== undefined ? scan.maskedContent : text;
};

/** Masks PII in a folded reply's message text, as completions does for its non-streaming reply. */
const maskOutput = (response: ResponseObject): ResponseObject => {
    return {
        ...response,
        output: response.output.map((item) =>
            item.type === "message"
                ? {
                      ...item,
                      content: item.content.map((part) => {
                          return { ...part, text: maskText(part.text) };
                      }),
                  }
                : item,
        ),
    };
};

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

        const isFolding = chat.stream === false && chat.tools !== undefined;
        const upstreamBody: ChatRequestBody = isFolding ? { ...chat, stream: true } : chat;
        const upstream = await dispatch(
            new Request(new URL("/v1/chat/completions", c.req.url), { body: JSON.stringify(upstreamBody), headers, method: "POST" }),
            c.env,
            c.executionCtx,
        );
        const kept = passthroughHeaders(upstream.headers);

        if (!upstream.ok) {
            const text = await upstream.text();

            return c.json(upstreamError(upstream.status, text), upstream.status as ContentfulStatusCode, kept);
        }

        if (chat.stream && upstream.body) {
            return new Response(upstream.body.pipeThrough(createResponsesStream(chat.model)), {
                headers: {
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "Content-Type": "text/event-stream",
                    ...kept,
                },
                status: 200,
            });
        }

        if (isFolding && upstream.body) {
            const response = maskOutput(await foldResponsesStream(upstream.body, chat.model));

            if (response.status === "failed") {
                return c.json(responsesError(response.error?.message ?? "The model provider failed.", { type: "server_error" }), 502, kept);
            }

            return c.json(response, 200, kept);
        }

        const completion = (await upstream.json()) as ChatCompletion;

        return c.json(chatCompletionToResponse(completion), 200, kept);
    });

    return responsesRouter;
};
