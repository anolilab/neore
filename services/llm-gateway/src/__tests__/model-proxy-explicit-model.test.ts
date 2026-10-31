/**
 * A chat run names its model and `/internal/model/proxy` runs exactly that one: routing
 * (tier scoring, momentum, the downgrade policy) belongs to `/internal/route` and the public
 * `model: "auto"`, which a run never calls. A thread's agent switch relies on this — the model it
 * switched to stays the model of every later turn, however long the conversation has grown.
 */
import { PROMPT_CACHE_COLD_START_TOKENS } from "@neore/ai/models";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProviderModelForEnv } from "../providers/factory.js";
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

describe("POST /internal/model/proxy", () => {
    afterEach(() => {
        vi.mocked(createProviderModelForEnv).mockReset();
    });

    it("runs the named model on a conversation far above the routing policy's cache threshold", async () => {
        const failing = async () => {
            throw new Error("stop here: only the model that was asked for matters");
        };

        vi.mocked(createProviderModelForEnv).mockResolvedValueOnce({ doGenerate: failing, doStream: failing } as never);

        const longPrompt = "x".repeat(PROMPT_CACHE_COLD_START_TOKENS * 4 * 3);

        await fetchApp(
            new Request("http://localhost/internal/model/proxy", {
                body: JSON.stringify({
                    action: "generate",
                    callOptions: { prompt: [{ content: [{ text: longPrompt, type: "text" }], role: "user" }] },
                    modelApiId: "gemini-2.5-flash",
                    modelId: "gemini-2.5-flash",
                    provider: "google",
                    requestId: "req-explicit-1",
                    userId: "user-1",
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
            bindingEnv(createMockEnv()),
        );

        expect(vi.mocked(createProviderModelForEnv)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(createProviderModelForEnv).mock.calls[0]?.slice(0, 3)).toStrictEqual([expect.anything(), "google", "gemini-2.5-flash"]);
    });
});
