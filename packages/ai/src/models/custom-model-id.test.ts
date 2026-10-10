import { describe, expect, it } from "vitest";

import { buildCustomModelId, isCustomModelId, parseCustomModelId } from "./custom-model-id";

describe(parseCustomModelId, () => {
    it("splits provider and model on the first slash", () => {
        expect.assertions(1);
        expect(parseCustomModelId("custom:ollama/llama3.1:8b")).toStrictEqual({ modelId: "llama3.1:8b", providerId: "ollama" });
    });

    it("keeps slashes inside the upstream model id", () => {
        expect.assertions(1);
        expect(parseCustomModelId("custom:vllm-1/meta-llama/Llama-3.1-8B")).toStrictEqual({ modelId: "meta-llama/Llama-3.1-8B", providerId: "vllm-1" });
    });

    it.each([
        ["registry id", "openrouter/anthropic/claude-3.5-sonnet"],
        ["missing model", "custom:ollama/"],
        ["missing provider", "custom:/llama3"],
        ["no slash", "custom:ollama"],
        ["uppercase provider", "custom:Ollama/llama3"],
        ["provider with dot", "custom:a.b/llama3"],
        ["padded model", "custom:ollama/ llama3"],
        ["overlong model", `custom:ollama/${"x".repeat(201)}`],
        ["undefined", undefined],
        ["null", null],
    ])("rejects %s", (_label, input) => {
        expect.assertions(1);
        expect(parseCustomModelId(input)).toBeNull();
    });

    it("round-trips through buildCustomModelId", () => {
        expect.assertions(2);

        const id = buildCustomModelId("lmstudio", "qwen/qwen2.5-7b");

        expect(id).toBe("custom:lmstudio/qwen/qwen2.5-7b");
        expect(parseCustomModelId(id)).toStrictEqual({ modelId: "qwen/qwen2.5-7b", providerId: "lmstudio" });
    });
});

describe(isCustomModelId, () => {
    it("matches only the custom prefix", () => {
        expect.assertions(3);
        expect(isCustomModelId("custom:x/y")).toBe(true);
        expect(isCustomModelId("openai/gpt-4o")).toBe(false);
        expect(isCustomModelId(undefined)).toBe(false);
    });
});

describe(buildCustomModelId, () => {
    it("refuses a provider id that would break parsing", () => {
        expect.assertions(1);
        expect(() => buildCustomModelId("a/b", "m")).toThrow("Invalid custom provider id");
    });
});
