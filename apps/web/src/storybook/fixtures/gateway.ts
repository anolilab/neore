import type { HttpHandler } from "msw";
import { delay, http, HttpResponse } from "msw";

import env from "@/lib/env";

/** One `persistentChunks` row as the gateway relays it on `/v1/stream` (`@neore/chat-ui/utils/stream-line`). */
export interface StreamChunk {
    reasoning?: string;
    restart?: true;
    speaker?: { name: string; skillId: string };
    text: string;
}

/** Splits a reply into word-sized chunks, the way a model streams it. */
export const chunksOf = (text: string, reasoning?: string): StreamChunk[] => {
    const words = text.split(/(?<=\s)/u);
    const chunks: StreamChunk[] = words.map((word) => {
        return { text: word };
    });

    return reasoning ? [{ reasoning, text: "" }, ...chunks] : chunks;
};

const encoder = new TextEncoder();

interface StreamOptions {
    /** Pause between lines, so the reply visibly streams. Default 60 ms. */
    delayMs?: number;
    /** Stop before the end marker and keep the stream open: the "still generating" state. */
    hang?: boolean;
    /** Answer with this gateway error instead of a stream. */
    status?: number;
}

/**
 * `POST <gateway>/v1/stream`: relays `chunks` as NDJSON, one line every `delayMs`, then
 * `{ type: "end" }`. The chat's `StreamingPlaceholder` reads it exactly as it reads the real relay.
 */
export const gatewayStreamHandler = (chunks: ReadonlyArray<StreamChunk>, options: StreamOptions = {}): HttpHandler =>
    http.post(`${env.VITE_LLM_GATEWAY_URL}/v1/stream`, () => {
        if (options.status) {
            return HttpResponse.json({ error: { code: "UPSTREAM_ERROR", message: "The model provider failed" } }, { status: options.status });
        }

        const body = new ReadableStream<Uint8Array>({
            async start(controller) {
                for (const chunk of chunks) {
                    await delay(options.delayMs ?? 60);
                    controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
                }

                if (options.hang) {
                    return;
                }

                controller.enqueue(encoder.encode(`${JSON.stringify({ type: "end" })}\n`));
                controller.close();
            },
        });

        return new HttpResponse(body, { headers: { "Content-Type": "application/x-ndjson" } });
    });

interface SendResponse {
    messageId: string;
    streamId: string;
    threadId: string;
}

/**
 * `POST <gateway>/v1/chat` (send) and `/v1/chat/edit`: accepts the message and hands back the
 * stream to read. `status` answers with a gateway error instead (429 is a rate limit, 400 with
 * `bannedWords` the content filter).
 */
export const gatewaySendHandlers = (response: SendResponse, options: { bannedWords?: string[]; retryAfter?: number; status?: number } = {}): HttpHandler[] => {
    const answer = () => {
        if (options.status === 429) {
            return HttpResponse.json(
                { error: { code: "RATE_LIMITED", message: "Rate limit exceeded", retryAfter: options.retryAfter ?? 30 } },
                { status: 429 },
            );
        }

        if (options.status) {
            // A 400 that names the banned words is the content filter: it carries the `BANNED_CONTENT` discriminator the
            // send path reads, so the composer is restored. Other errors stay generic.
            const isContentFilter = options.status === 400 && options.bannedWords !== undefined;

            return HttpResponse.json(
                {
                    ...(isContentFilter ? { error: "BANNED_CONTENT" } : {}),
                    bannedWords: options.bannedWords,
                    message: "This message cannot be sent",
                },
                { status: options.status },
            );
        }

        return HttpResponse.json({
            contentType: "text",
            gatewayUrl: env.VITE_LLM_GATEWAY_URL,
            streaming: true,
            streamToken: `storybook-stream-${response.streamId}`,
            ...response,
        });
    };

    return [http.post(`${env.VITE_LLM_GATEWAY_URL}/v1/chat`, answer), http.post(`${env.VITE_LLM_GATEWAY_URL}/v1/chat/edit`, answer)];
};
