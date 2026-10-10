import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";

import { internal } from "../../_generated/internal";
import type { ActionCtx as ActionContext } from "../../_generated/server";
import { cacheKeyFor } from "../../lib/action-cache";

const ONE_HOUR_IN_MS = 1000 * 60 * 60;

const createCacheMiddleware = (name: string, context: ActionContext): LanguageModelV3Middleware => {
    const cacheName = `cached-${name}`;

    return {
        specificationVersion: "v3",
        wrapGenerate: async ({ doGenerate, params }) => {
            const cacheKey = JSON.stringify(params);
            const ttl = ONE_HOUR_IN_MS;
            const generateCacheName = `${cacheName}-generate`;

            const cached = await context.runQuery(internal.lib.action_cache.get, { key: await cacheKeyFor(generateCacheName, cacheKey), now: Date.now() });

            if (cached.kind === "hit" && cached.value) {
                const result = cached.value as Awaited<ReturnType<typeof doGenerate>>;

                if (result.response?.timestamp && typeof result.response.timestamp === "string") {
                    result.response.timestamp = new Date(result.response.timestamp);
                }

                return result;
            }

            const result = await doGenerate();

            await context.runMutation(internal.lib.action_cache.put, {
                key: await cacheKeyFor(generateCacheName, cacheKey),
                name: generateCacheName,
                ttl,
                value: result,
            });

            return result;
        },
        wrapStream: async ({ doStream, params }) => {
            const cacheKey = JSON.stringify(params);
            const ttl = ONE_HOUR_IN_MS;
            const streamCacheName = `${cacheName}-stream`;

            const cached = await context.runQuery(internal.lib.action_cache.get, { key: await cacheKeyFor(streamCacheName, cacheKey), now: Date.now() });

            if (cached.kind === "hit" && cached.value) {
                const formattedChunks = (cached.value as LanguageModelV3StreamPart[]).map((p) => {
                    if (p.type === "response-metadata" && p.timestamp) {
                        return { ...p, timestamp: new Date(p.timestamp) };
                    }

                    return p;
                });

                return {
                    rawCall: { rawPrompt: null, rawSettings: {} },
                    stream: simulateReadableStream({
                        chunkDelayInMs: 2,
                        chunks: formattedChunks,
                        initialDelayInMs: 0,
                    }),
                };
            }

            const { stream, ...rest } = await doStream();

            const fullResponse: LanguageModelV3StreamPart[] = [];

            const transformStream = new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
                async flush() {
                    // `await` inside flush rather than fire-and-forget: the stream is
                    // complete here, so nothing is
                    // blocked, and an un-awaited write can be cancelled when the
                    // Worker isolate is torn down after the response.
                    await context.runMutation(internal.lib.action_cache.put, {
                        key: await cacheKeyFor(streamCacheName, cacheKey),
                        name: streamCacheName,
                        ttl,
                        value: fullResponse,
                    });
                },
                transform(chunk, controller) {
                    fullResponse.push(chunk);
                    controller.enqueue(chunk);
                },
            });

            return {
                stream: stream.pipeThrough(transformStream),
                ...rest,
            };
        },
    };
};

export default createCacheMiddleware;
