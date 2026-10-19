/**
 * What reaches the OTLP collector for one chat call, through the real app. A non-streamed
 * reply records its usage inside the handler; a streamed one records after the body ends,
 * once the middleware has already flushed. Both must export the GenAI span and the token
 * counter exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../../index.js";
import { createMockCtx, createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";

const TOKEN = "gk_otel_export_integration_test";
const COLLECTOR = "https://otel.example.com";

interface OtlpAttribute {
    key: string;
    value: Record<string, boolean | number | string>;
}

interface OtlpSpan {
    attributes: OtlpAttribute[];
    name: string;
    parentSpanId?: string;
    spanId: string;
}

interface OtlpMetric {
    name: string;
    sum?: { dataPoints: { asInt?: string; attributes: OtlpAttribute[] }[] };
}

interface CollectorExport {
    body: unknown;
    path: "/v1/metrics" | "/v1/traces";
}

const attribute = (attributes: OtlpAttribute[], key: string): string | undefined => {
    const value = attributes.find((entry) => entry.key === key)?.value;

    return value === undefined ? undefined : String(Object.values(value)[0]);
};

const makeEnv = async () => {
    const row = await makeVirtualKeyRow(TOKEN, { tier: "pro" });

    return {
        ...createMockEnv({ apiKeyCacheRows: [row], nodeEnv: "development" }),
        MOCK_LLM: "1",
        OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR,
    } as never;
};

const chatRequest = (isStreaming: boolean): Request =>
    new Request("http://localhost/v1/chat/completions", {
        body: JSON.stringify({ messages: [{ content: "ping", role: "user" }], model: "mock/echo", stream: isStreaming }),
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
    });

describe.each([
    { isStreaming: false, label: "a non-streamed reply" },
    { isStreaming: true, label: "a streamed reply, recorded after the middleware's flush" },
])("OTLP export of $label", ({ isStreaming }) => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** Every request the exporter has sent to the collector so far. */
    const collectorExports = (): CollectorExport[] => {
        const exported: CollectorExport[] = [];

        for (const [url, init] of fetchMock.mock.calls) {
            const target = String(url);

            if (URL.canParse(target) && new URL(target).origin === COLLECTOR) {
                exported.push({
                    body: JSON.parse(String((init as RequestInit).body)),
                    path: new URL(target).pathname as CollectorExport["path"],
                });
            }
        }

        return exported;
    };

    /** Settle background exports until the number of collector requests stops growing. */
    const settle = async (ctx: ReturnType<typeof createMockCtx>): Promise<void> => {
        let seen = -1;

        while (collectorExports().length !== seen) {
            seen = collectorExports().length;
            await ctx.flush();
        }
    };

    it("exports the GenAI span and the token counter exactly once", async () => {
        const ctx = createMockCtx();
        const res = await app.fetch(chatRequest(isStreaming), await makeEnv(), ctx as unknown as ExecutionContext);

        expect(res.status).toBe(200);

        if (isStreaming) {
            await res.text();
        } else {
            await res.json();
        }

        await settle(ctx);

        const exported = collectorExports();
        const spans = exported
            .filter((entry) => entry.path === "/v1/traces")
            .flatMap((entry) => (entry.body as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }).resourceSpans)
            .flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
        const metrics = exported
            .filter((entry) => entry.path === "/v1/metrics")
            .flatMap((entry) => (entry.body as { resourceMetrics: { scopeMetrics: { metrics: OtlpMetric[] }[] }[] }).resourceMetrics)
            .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));

        const server = spans.filter((span) => span.name === "POST /v1/chat/completions");
        const chat = spans.filter((span) => span.name.startsWith("chat "));
        const tokens = metrics.filter((metric) => metric.name === "gateway.tokens_total");

        expect(server).toHaveLength(1);
        expect(chat).toHaveLength(1);
        expect(chat[0]?.parentSpanId).toBe(server[0]?.spanId);
        expect(attribute(chat[0]?.attributes ?? [], "gen_ai.operation.name")).toBe("chat");

        expect(tokens).toHaveLength(1);

        const prompt = tokens[0]?.sum?.dataPoints.find((point) => attribute(point.attributes, "kind") === "prompt");

        expect(Number(prompt?.asInt)).toBeGreaterThan(0);
        expect(prompt?.asInt).toBe(attribute(chat[0]?.attributes ?? [], "gen_ai.usage.input_tokens"));
    });
});
