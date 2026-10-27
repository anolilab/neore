/**
 * The backend closes its end of a proxied stream when it receives an error event. That close reaches the proxy as
 * a cancel, and must not turn the failed call into a user stop: a stop is billed from the cancelled-reply
 * estimate and counts no health failure, an error is billed as one and records the provider failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProviderModelForEnv } from "../providers/factory.js";
import { ProviderHealthService } from "../providers/health.js";
import { UsageReporter } from "../usage/reporter.js";
import { UsageTracker } from "../usage/tracker.js";
import { bindingEnv } from "./helpers/internal.js";
import { createMockEnv } from "./helpers/mock-env.js";
import { useTrackedAppFetch } from "./helpers/tracked-app-fetch.js";

vi.mock("../providers/factory.js", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../providers/factory.js")>()),
        createProviderModelForEnv: vi.fn(),
        resolveApiKey: vi.fn().mockReturnValue("test-api-key"),
    };
});

const fetchApp = useTrackedAppFetch();

const recordSpy = vi.spyOn(UsageTracker.prototype, "record");
const failureSpy = vi.spyOn(ProviderHealthService.prototype, "recordFailure");
const successSpy = vi.spyOn(ProviderHealthService.prototype, "recordSuccess");
const reportSpy = vi.spyOn(UsageReporter.prototype, "report");

/** A provider stream that has sent `parts` and then stays open, as a live provider connection does. */
const openStream = async (
    parts: unknown[],
    { closes = false }: { closes?: boolean } = {},
    prompt: unknown = [{ content: [{ text: "hello there", type: "text" }], role: "user" }],
) => {
    vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({
        doStream: async () => {
            return {
                stream: new ReadableStream({
                    start(controller) {
                        for (const part of parts) controller.enqueue(part);

                        if (closes) controller.close();
                    },
                }),
            };
        },
    } as never);

    return await fetchApp(
        new Request("http://localhost/internal/model/proxy", {
            body: JSON.stringify({
                action: "stream",
                callOptions: { prompt },
                modelApiId: "gpt-test-1",
                modelId: "gpt-test",
                provider: "openai",
                requestId: "req-cancel-1",
                userId: "user-1",
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        }),
        bindingEnv(createMockEnv()),
    );
};

/** Reads events until one of `type` has arrived, then closes the response as the backend does. */
const closeAfter = async (response: Response, type: string) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";

    while (!seen.includes(`"type":"${type}"`)) {
        const { done, value } = await reader.read();

        if (done) break;

        seen += decoder.decode(value);
    }

    await reader.cancel();
};

const firstEntry = () => recordSpy.mock.calls[0]?.[0];

afterEach(() => {
    recordSpy.mockClear();
    failureSpy.mockClear();
    successSpy.mockClear();
    reportSpy.mockClear();
    vi.mocked(createProviderModelForEnv).mockReset();
});

describe("a client closing a proxied stream", () => {
    const PROMPT_TOKENS = Math.ceil("hello there".length / 4);

    it("is a provider failure, not a stop, when it follows an error event, and bills what the provider consumed", async () => {
        const response = await openStream([
            { delta: "partial", id: "t1", type: "text-delta" },
            { error: Object.assign(new Error("overloaded"), { statusCode: 529 }), type: "error" },
        ]);

        await closeAfter(response, "error");
        await vi.waitFor(() => expect(reportSpy).toHaveBeenCalled());

        // The status and health stay an error's: no "cancelled", one failure recorded.
        expect(firstEntry()?.errorCode).toBe("PROVIDER_ERROR");
        expect(firstEntry()?.finishReason).not.toBe("cancelled");
        expect(failureSpy).toHaveBeenCalledTimes(1);
        expect(successSpy).not.toHaveBeenCalled();
        // Usage is the estimate a cancelled stream gets, recorded and billed alike: the prompt and the 7 characters sent.
        expect(firstEntry()).toMatchObject({ completionTokens: Math.ceil("partial".length / 4), promptTokens: PROMPT_TOKENS });
        expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ completionTokens: Math.ceil("partial".length / 4), promptTokens: PROMPT_TOKENS });
    });

    it("bills the prompt when the error comes before any output", async () => {
        const response = await openStream([{ error: Object.assign(new Error("overloaded"), { statusCode: 529 }), type: "error" }]);

        await closeAfter(response, "error");
        await vi.waitFor(() => expect(reportSpy).toHaveBeenCalled());

        expect(firstEntry()).toMatchObject({ completionTokens: 0, errorCode: "PROVIDER_ERROR", promptTokens: PROMPT_TOKENS });
        expect(firstEntry()?.finishReason).not.toBe("cancelled");
        expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({ completionTokens: 0, promptTokens: PROMPT_TOKENS });
        expect(failureSpy).toHaveBeenCalledTimes(1);
    });

    it("records no usage, as before, for an errored stream nobody cancelled and that sent no usage", async () => {
        const response = await openStream(
            [
                { delta: "partial", id: "t1", type: "text-delta" },
                { error: Object.assign(new Error("overloaded"), { statusCode: 529 }), type: "error" },
            ],
            { closes: true },
        );

        await response.text();
        await vi.waitFor(() => expect(reportSpy).toHaveBeenCalled());

        expect(firstEntry()).toMatchObject({ completionTokens: 0, errorCode: "PROVIDER_ERROR", promptTokens: 0 });
        expect(failureSpy).toHaveBeenCalledTimes(1);
    });

    it("is still a stop, billed from the estimate, when the user cancels a healthy stream", async () => {
        const response = await openStream([{ delta: "partial", id: "t1", type: "text-delta" }]);

        await closeAfter(response, "text-delta");
        await vi.waitFor(() => expect(recordSpy).toHaveBeenCalled());

        expect(firstEntry()?.finishReason).toBe("cancelled");
        expect(firstEntry()?.promptTokens).toBeGreaterThan(0);
        expect(firstEntry()).not.toHaveProperty("errorCode");
        expect(failureSpy).not.toHaveBeenCalled();
        expect(successSpy).not.toHaveBeenCalled();
    });
});

describe("classifying a failure on a malformed prompt", () => {
    it("still sends the structured error when the prompt holds a null entry", async () => {
        vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({
            doGenerate: async () => {
                throw Object.assign(new Error("overloaded"), { statusCode: 529 });
            },
        } as never);

        const response = await fetchApp(
            new Request("http://localhost/internal/model/proxy", {
                body: JSON.stringify({
                    action: "generate",
                    callOptions: { prompt: [null, 3, { content: "hi", role: "user" }] },
                    modelApiId: "gpt-test-1",
                    modelId: "gpt-test",
                    provider: "openai",
                    requestId: "req-bad-prompt-1",
                    userId: "user-1",
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
            bindingEnv(createMockEnv()),
        );
        const body = (await response.json()) as { error: { code: string; fallbackReason?: string } };

        expect(response.status).toBe(502);
        expect(body.error).toMatchObject({ code: "PROVIDER_ERROR", fallbackReason: "infra" });
    });
});
