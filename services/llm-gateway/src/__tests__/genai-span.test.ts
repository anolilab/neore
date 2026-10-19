import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RequestTelemetry } from "../lib/otel/tracer.js";
import { SpanKind } from "../lib/otel/types.js";
import type { UsageLogEntry } from "../usage/tracker.js";
import { UsageTracker } from "../usage/tracker.js";

const config = { deploymentEnvironment: "test", endpoint: "https://otel.example.com", headers: {}, serviceName: "test-service", serviceVersion: "0.0.1" };

interface OtlpSpan {
    attributes: { key: string; value: Record<string, string | boolean> }[];
    endTimeUnixNano: string;
    kind: number;
    name: string;
    parentSpanId?: string;
    spanId: string;
    startTimeUnixNano: string;
    status: { code: number };
}

const entry = (overrides: Partial<UsageLogEntry> = {}): UsageLogEntry => {
    return {
        cachedTokens: 0,
        completionTokens: 40,
        costMicrodollars: 1200,
        isStreaming: false,
        latencyMs: 750,
        modelApiId: "gpt-test-1",
        modelId: "gpt-test",
        operation: "chat",
        promptTokens: 120,
        provider: "openai",
        reasoningTokens: 0,
        requestId: "req-1",
        source: "saas_api",
        userId: "user-secret",
        ...overrides,
    };
};

const attribute = (span: OtlpSpan, key: string): string | undefined => {
    const value = span.attributes.find((a) => a.key === key)?.value;

    return value === undefined ? undefined : String(Object.values(value)[0]);
};

describe("GenAI span for a model call", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 })) as any;
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    const exportedSpans = async (telemetry: RequestTelemetry): Promise<OtlpSpan[]> => {
        await telemetry.flush();

        const call = (fetchSpy.mock.calls as [string, { body: string }][]).find(([url]) => url.endsWith("/v1/traces"));

        return JSON.parse(call![1].body).resourceSpans[0].scopeSpans[0].spans as OtlpSpan[];
    };

    it("exports model, provider, token counts and latency under the GenAI keys", async () => {
        const telemetry = new RequestTelemetry(config);
        const root = telemetry.startSpan("POST /v1/chat/completions", { kind: SpanKind.SERVER });

        UsageTracker.recordMetrics(telemetry, entry());
        telemetry.endSpan(root);

        const spans = await exportedSpans(telemetry);
        const generation = spans.find((s) => s.name === "chat gpt-test-1")!;

        expect(generation!.kind).toBe(SpanKind.CLIENT);
        expect(generation!.parentSpanId).toBe(root.spanId);
        expect(attribute(generation!, "gen_ai.operation.name")).toBe("chat");
        expect(attribute(generation!, "gen_ai.provider.name")).toBe("openai");
        expect(attribute(generation!, "gen_ai.request.model")).toBe("gpt-test-1");
        expect(attribute(generation!, "gen_ai.response.model")).toBe("gpt-test-1");
        expect(attribute(generation!, "gen_ai.usage.input_tokens")).toBe("120");
        expect(attribute(generation!, "gen_ai.usage.output_tokens")).toBe("40");
        expect(Number(BigInt(generation!.endTimeUnixNano) - BigInt(generation!.startTimeUnixNano))).toBe(750_000_000);
    });

    it("reports the routed model as the response model when the gateway picked one", async () => {
        const telemetry = new RequestTelemetry(config);

        UsageTracker.recordMetrics(telemetry, entry({ routedModelId: "gpt-test-mini" }));

        const [generation] = await exportedSpans(telemetry);

        expect(attribute(generation!, "gen_ai.request.model")).toBe("gpt-test-1");
        expect(attribute(generation!, "gen_ai.response.model")).toBe("gpt-test-mini");
    });

    it("marks a failed call as an error span", async () => {
        const telemetry = new RequestTelemetry(config);

        UsageTracker.recordMetrics(telemetry, entry({ errorCode: "PROVIDER_ERROR" }));

        const [generation] = await exportedSpans(telemetry);

        expect(generation!.status.code).toBe(2);
    });

    it("leaves out output tokens for embeddings", async () => {
        const telemetry = new RequestTelemetry(config);

        UsageTracker.recordMetrics(telemetry, entry({ completionTokens: 0, modelApiId: "embed-1", operation: "embeddings" }));

        const [generation] = await exportedSpans(telemetry);

        expect(generation!.name).toBe("embeddings embed-1");
        expect(attribute(generation!, "gen_ai.usage.output_tokens")).toBeUndefined();
    });

    it("never attaches the caller's id", async () => {
        const telemetry = new RequestTelemetry(config);

        UsageTracker.recordMetrics(telemetry, entry());
        await telemetry.flush();

        const body = (fetchSpy.mock.calls as [string, { body: string }][]).map(([, init]) => init.body).join("");

        expect(body).not.toContain("user-secret");
    });

    it("exports no span for a call that has no operation (media, speech)", async () => {
        const telemetry = new RequestTelemetry(config);

        UsageTracker.recordMetrics(telemetry, entry({ operation: undefined }));
        await telemetry.flush();

        const traces = (fetchSpy.mock.calls as [string, unknown][]).filter(([url]) => url.endsWith("/v1/traces"));

        expect(traces).toHaveLength(0);
    });

    it("costs nothing when telemetry is off", () => {
        const telemetry = new RequestTelemetry(null);

        expect(() => UsageTracker.recordMetrics(telemetry, entry())).not.toThrow();
    });
});
