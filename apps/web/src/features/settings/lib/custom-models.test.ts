import type { I18n } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";

import type { CustomProviderView } from "./custom-models";
import { findLocalModelTarget, parseModelListInput, toCustomGatewayModels } from "./custom-models";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted); a descriptor carries its English source.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray, ...values: unknown[]) => {
            const text = String.raw({ raw: strings }, ...values);

            return { id: text, message: text };
        },
    };
});

const provider = (overrides: Partial<CustomProviderView> = {}): CustomProviderView => {
    return {
        baseUrl: "https://ollama.example.com/v1",
        enabled: true,
        hasApiKey: false,
        id: "ollama",
        models: [{ id: "llama3.1:8b" }, { id: "qwen/qwen2.5", name: "Qwen 2.5" }],
        name: "Home Ollama",
        supportsTools: false,
        type: "openai",
        ...overrides,
    };
};

/** Echoes a descriptor's source message — enough to assert on the English wording. */
const i18n = {
    _: (descriptor: unknown) => (typeof descriptor === "string" ? descriptor : ((descriptor as { message?: string }).message ?? "")),
} as Pick<I18n, "_">;

describe(toCustomGatewayModels, () => {
    it("namespaces ids and groups under the endpoint name", () => {
        expect.assertions(4);

        const models = toCustomGatewayModels([provider()], i18n);

        expect(models.map((m) => m.id)).toStrictEqual(["custom:ollama/llama3.1:8b", "custom:ollama/qwen/qwen2.5"]);
        expect(models[1]?.name).toBe("Qwen 2.5");
        expect(models[0]?.displayProvider).toBe("Home Ollama");
        expect(models.every((m) => m.mode === "text" && !m.supportsTools)).toBe(true);
    });

    it("skips disabled endpoints", () => {
        expect.assertions(1);
        expect(toCustomGatewayModels([provider({ enabled: false })], i18n)).toStrictEqual([]);
    });

    it("carries the tool opt-in", () => {
        expect.assertions(1);
        expect(toCustomGatewayModels([provider({ supportsTools: true })], i18n)[0]?.supportsTools).toBe(true);
    });

    it("tolerates a missing list", () => {
        expect.assertions(1);
        expect(toCustomGatewayModels(undefined, i18n)).toStrictEqual([]);
    });
});

describe(parseModelListInput, () => {
    it("splits on newlines and commas, trims and dedupes", () => {
        expect.assertions(1);
        expect(parseModelListInput("llama3, qwen2.5\n\n llama3 \nmeta-llama/Llama-3.1-8B")).toStrictEqual([
            { id: "llama3" },
            { id: "qwen2.5" },
            { id: "meta-llama/Llama-3.1-8B" },
        ]);
    });
});

describe("local-browser endpoints", () => {
    const local = provider({ baseUrl: ["http", "//localhost:11434/v1"].join(":"), id: "laptop", supportsTools: true, type: "local-browser" });

    it("lists their models without tools, whatever the stored flag says", () => {
        expect.assertions(2);

        const models = toCustomGatewayModels([local], i18n);

        expect(models.every((m) => !m.supportsTools)).toBe(true);
        expect(models[0]?.desc).toContain("not billed");
    });

    it("resolves a local model to its endpoint, and nothing else", () => {
        expect.assertions(4);
        expect(findLocalModelTarget([local], "custom:laptop/llama3.1:8b")).toStrictEqual({
            baseUrl: local.baseUrl,
            modelId: "llama3.1:8b",
            providerId: "laptop",
            providerName: "Home Ollama",
        });
        expect(findLocalModelTarget([provider()], "custom:ollama/llama3.1:8b")).toBeUndefined();
        expect(findLocalModelTarget([{ ...local, enabled: false }], "custom:laptop/llama3.1:8b")).toBeUndefined();
        expect(findLocalModelTarget([local], "gpt-4o")).toBeUndefined();
    });
});
