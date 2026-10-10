/**
 * Every backend -> service call goes through the action's service binding
 * (`ctx.services.<key>`), threaded down explicitly — never a URL, never a
 * signature, never a module-level client. A fake binding stands in for the
 * `Fetcher` here; like the real one, its `fetch` throws `Illegal invocation`
 * when called detached from the binding, which is why `serviceFetch` wraps it.
 */
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { fetchWithDeadline } from "../../lib/fetch-timeout";
import { gatewayFetch, gatewayFetchFor, isServiceBound, NO_SERVICE_FETCH, SERVICE_ORIGIN, serviceFetch, type ServicesContext } from "../../lib/services";
import { createNotificationRule, listGatewayKeys, revokeGatewayKey } from "./gateway-client";
import { createGatewayEmbeddingModel } from "./gateway-embedding-model";
import { GatewayLanguageModel } from "./gateway-language-model";

interface RecordedCall {
    body: string | undefined;
    headers: Headers;
    method: string;
    url: string;
}

/** A `Fetcher`-like binding: `fetch` must be called ON it, as workerd requires. */
class FakeBinding {
    public readonly calls: RecordedCall[] = [];

    public constructor(private readonly respond: (call: RecordedCall) => Response | Promise<Response> = () => Response.json({ ok: true })) {}

    public async fetch(this: FakeBinding | undefined, input: Request | string | URL, init?: RequestInit): Promise<Response> {
        if (!(this instanceof FakeBinding)) {
            throw new TypeError("Illegal invocation");
        }

        const request = new Request(input, init);
        const call = { body: request.body ? await request.text() : undefined, headers: request.headers, method: request.method, url: request.url };

        this.calls.push(call);

        return await this.respond(call);
    }
}

/** An action ctx's `services`, every key on its own fake binding. */
const servicesCtx = (bindings: Partial<Record<keyof ServicesContext["services"], FakeBinding>>): ServicesContext => {
    return { services: bindings as unknown as ServicesContext["services"] };
};

/** Lunora's stand-in for a declared service whose binding is absent (`createServices`). */
const unboundStandIn = new Proxy(
    {},
    {
        get(_target, key) {
            if (key === "then" || typeof key === "symbol") {
                return undefined;
            }

            throw new Error('ctx.services.documentParser: the "SERVICE_DOCUMENT_PARSER" service binding is not bound');
        },
    },
);

const prompt: LanguageModelV3CallOptions = { prompt: [{ content: [{ text: "ping", type: "text" }], role: "user" }] };

describe("lib/services", () => {
    it("routes a call to the ctx's binding, invoked on the binding", async () => {
        const gateway = new FakeBinding();
        const fetch = serviceFetch(servicesCtx({ llmGateway: gateway }), "llmGateway");

        // Passing the binding's method detached is exactly what throws in workerd.
        await expect(gateway.fetch.call(undefined, "https://x/")).rejects.toThrow("Illegal invocation");

        await fetch(`${SERVICE_ORIGIN.llmGateway}/internal/route`, { body: "{}", method: "POST" });

        expect(gateway.calls).toHaveLength(1);
        expect(gateway.calls[0]?.url).toBe("https://llm-gateway.internal/internal/route");
    });

    it("looks the binding up at call time, so building a client never throws", async () => {
        const ctx = servicesCtx({ documentParser: unboundStandIn as never });
        const fetch = serviceFetch(ctx, "documentParser");

        await expect(fetch("https://document-parser.internal/extract")).rejects.toThrow("SERVICE_DOCUMENT_PARSER");
    });

    it("tells a bound service from Lunora's unbound stand-in", () => {
        expect(isServiceBound(servicesCtx({ nsfwChecker: new FakeBinding() }), "nsfwChecker")).toBe(true);
        expect(isServiceBound(servicesCtx({ nsfwChecker: unboundStandIn as never }), "nsfwChecker")).toBe(false);
    });

    it("gives a query or mutation ctx no gateway at all", async () => {
        const gateway = new FakeBinding();

        await gatewayFetchFor(servicesCtx({ llmGateway: gateway }))(`${SERVICE_ORIGIN.llmGateway}/internal/route`);
        expect(gateway.calls).toHaveLength(1);

        // A query/mutation ctx carries no `services`.
        expect(gatewayFetchFor({ db: {} })).toBe(NO_SERVICE_FETCH);
        await expect(NO_SERVICE_FETCH("https://llm-gateway.internal/internal/model/proxy")).rejects.toThrow("actions only");
    });

    it("puts a deadline on a binding call too", async () => {
        const slow = new FakeBinding(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 200);
            });

            return Response.json({});
        });
        const via = serviceFetch(servicesCtx({ browserRenderer: slow }), "browserRenderer");
        const spy = vi.spyOn(slow, "fetch");

        await fetchWithDeadline("https://browser-renderer.internal/action", { method: "POST", timeoutMs: 1000, via });

        // The deadline signal rides along to the binding.
        expect((spy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    });
});

describe("GatewayLanguageModel over the gateway binding", () => {
    it("posts generate calls to /internal/model/proxy, unsigned", async () => {
        const gateway = new FakeBinding(() =>
            Response.json(
                { content: [{ text: "pong", type: "text" }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, warnings: [] },
                { headers: { "x-gateway-cost-microdollars": "12" } },
            ),
        );
        const model = new GatewayLanguageModel({
            gateway: gatewayFetch(servicesCtx({ llmGateway: gateway })),
            modelApiId: "google/gemini-2.5-flash",
            modelId: "gemini-2.5-flash",
            provider: "openrouter",
            threadId: "t1",
            userId: "u1",
        });

        const result = await model.doGenerate(prompt);

        expect(result.content).toEqual([{ text: "pong", type: "text" }]);
        expect(gateway.calls).toHaveLength(1);
        expect(gateway.calls[0]?.url).toBe("https://llm-gateway.internal/internal/model/proxy");
        expect(gateway.calls[0]?.headers.get("X-Signature")).toBeNull();
        expect(gateway.calls[0]?.headers.get("traceparent")).toBeTruthy();
        expect(JSON.parse(gateway.calls[0]?.body ?? "{}")).toMatchObject({ action: "generate", modelId: "gemini-2.5-flash", threadId: "t1", userId: "u1" });
    });

    it("streams parts as the binding delivers them, before the response ends", async () => {
        const encoder = new TextEncoder();
        let release!: () => void;
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node >= 22.11; the configured range starts at 22.0
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const gateway = new FakeBinding(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        async start(controller) {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: "Hel", id: "1", type: "text-delta" })}\n\n`));
                            // The rest is held back until the test has read the first part.
                            await held;
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: "lo", id: "1", type: "text-delta" })}\n\n`));
                            controller.enqueue(
                                encoder.encode(
                                    `data: ${JSON.stringify({ finishReason: "stop", type: "finish", usage: { inputTokens: 1, outputTokens: 2 } })}\n\n`,
                                ),
                            );
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ cost: { microdollars: 7 }, type: "gateway-metadata" })}\n\n`));
                            controller.close();
                        },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                ),
        );
        const model = new GatewayLanguageModel({
            gateway: gatewayFetch(servicesCtx({ llmGateway: gateway })),
            modelApiId: "google/gemini-2.5-flash",
            modelId: "gemini-2.5-flash",
            provider: "openrouter",
        });

        const { stream } = await model.doStream(prompt);
        const reader = stream.getReader();

        // Arrives while the gateway is still holding the rest of its body.
        expect(await reader.read()).toEqual({ done: false, value: { delta: "Hel", id: "1", type: "text-delta" } });

        release();

        const rest: LanguageModelV3StreamPart[] = [];

        for (let part = await reader.read(); !part.done; part = await reader.read()) {
            rest.push(part.value);
        }

        expect(rest.map((part) => part.type)).toEqual(["text-delta", "finish"]);
        expect(JSON.parse(gateway.calls[0]?.body ?? "{}")).toMatchObject({ action: "stream" });
    });
});

describe("GatewayEmbeddingModel over the gateway binding", () => {
    it("posts to /internal/embeddings through the binding", async () => {
        const gateway = new FakeBinding(() => Response.json({ embeddings: [[0.1, 0.2]], usage: { totalTokens: 3 } }));
        const model = createGatewayEmbeddingModel(gatewayFetch(servicesCtx({ llmGateway: gateway })), { userId: "u1" });

        const result = await model.doEmbed({ values: ["hello"] });

        expect(result.embeddings).toEqual([[0.1, 0.2]]);
        expect(gateway.calls[0]?.url).toBe("https://llm-gateway.internal/internal/embeddings");
        expect(JSON.parse(gateway.calls[0]?.body ?? "{}")).toMatchObject({ input: ["hello"], userId: "u1" });
    });
});

describe("gateway-client over the gateway binding", () => {
    it("sends each admin call to the action's binding", async () => {
        const gateway = new FakeBinding((call) => (call.method === "GET" ? Response.json({ keys: [{ keyId: "k1" }] }) : Response.json({ id: "r1" })));
        const ctx = servicesCtx({ llmGateway: gateway }) as never;

        expect(await listGatewayKeys(ctx, "user 1")).toEqual([{ keyId: "k1" }]);
        await createNotificationRule(ctx, { metric: "daily_cost", name: "cap", threshold: 5, userId: "u1" });
        await revokeGatewayKey(ctx, "k/1");

        expect(gateway.calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`)).toEqual([
            "GET /internal/keys?userId=user%201",
            "POST /internal/notification-rules",
            "DELETE /internal/keys/k%2F1",
        ]);
        expect(gateway.calls.every((call) => call.headers.get("X-Signature") === null)).toBe(true);
    });

    it("keeps no client across requests: each ctx's own binding is used", async () => {
        const first = new FakeBinding(() => Response.json({ keys: [] }));
        const second = new FakeBinding(() => Response.json({ keys: [] }));

        await listGatewayKeys(servicesCtx({ llmGateway: first }) as never, "u1");
        await listGatewayKeys(servicesCtx({ llmGateway: second }) as never, "u2");

        expect(first.calls).toHaveLength(1);
        expect(second.calls).toHaveLength(1);
    });
});
