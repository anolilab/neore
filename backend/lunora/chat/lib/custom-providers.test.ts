import { describe, expect, it } from "vitest";

import {
    buildModelsRequestHeaders,
    buildModelsUrl,
    generateCustomProviderId,
    isLocalBrowserProvider,
    isNativeProvider,
    parseGoogleModelsResponse,
    parseModelsResponse,
    toGatewayFormat,
    validateCustomEndpointUrl,
    validateEndpointUrlForType,
} from "./custom-providers";

describe(validateCustomEndpointUrl, () => {
    it("normalises a public https URL", () => {
        expect.assertions(1);
        expect(validateCustomEndpointUrl("  https://ollama.example.com/v1/?x=1#y ")).toStrictEqual({ url: "https://ollama.example.com/v1" });
    });

    it.each([
        // Built at runtime: a lint autofix rewrites literal insecure URLs to https.
        ["plain http", ["http", "//ollama.example.com/v1"].join(":")],
        ["loopback", "https://127.0.0.1:11434/v1"],
        ["localhost", "https://localhost:11434/v1"],
        ["subdomain of localhost", "https://ollama.localhost/v1"],
        ["mDNS name", "https://my-mac.local/v1"],
        ["single-label host", "https://ollama/v1"],
        ["private range", "https://10.0.0.5/v1"],
        ["link-local metadata", "https://169.254.169.254/latest"],
        ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/v1"],
        ["IPv6 loopback", "https://[::1]/v1"],
        ["dotless-decimal loopback", "https://2130706433/v1"],
        ["credentials in URL", "https://user:pass@ollama.example.com/v1"], // secret-scanner:allow
        ["garbage", "not a url"],
    ])("rejects %s", (_label, url) => {
        expect.assertions(1);
        expect(validateCustomEndpointUrl(url)).toHaveProperty("error");
    });
});

describe(parseModelsResponse, () => {
    it("reads the OpenAI shape, dedupes and sorts", () => {
        expect.assertions(1);
        expect(parseModelsResponse({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { id: "  " }, null], object: "list" })).toStrictEqual([
            { id: "a" },
            { id: "b" },
        ]);
    });

    it("keeps Anthropic display names", () => {
        expect.assertions(1);
        expect(parseModelsResponse({ data: [{ display_name: "Claude X", id: "claude-x" }] })).toStrictEqual([{ id: "claude-x", name: "Claude X" }]);
    });

    it("accepts Ollama's native /api/tags shape", () => {
        expect.assertions(1);
        expect(parseModelsResponse({ models: [{ model: "llama3.1:8b", name: "llama3.1:8b" }] })).toStrictEqual([{ id: "llama3.1:8b" }]);
    });

    it("returns nothing for an unrecognised body", () => {
        expect.assertions(3);
        expect(parseModelsResponse("nope")).toStrictEqual([]);
        expect(parseModelsResponse({ data: "x" })).toStrictEqual([]);
        expect(parseModelsResponse(null)).toStrictEqual([]);
    });

    it("caps the list", () => {
        expect.assertions(1);
        expect(
            parseModelsResponse({
                data: Array.from({ length: 500 }, (_, i) => {
                    return { id: `m${i}` };
                }),
            }),
        ).toHaveLength(200);
    });
});

describe(buildModelsRequestHeaders, () => {
    it("uses a bearer token for OpenAI-compatible endpoints", () => {
        expect.assertions(2);
        expect(buildModelsRequestHeaders("openai", "sk-1").authorization).toBe("Bearer sk-1");
        expect(buildModelsRequestHeaders("openai", undefined)).not.toHaveProperty("authorization");
    });

    it("uses x-api-key and a version header for Anthropic", () => {
        expect.assertions(2);

        const headers = buildModelsRequestHeaders("anthropic", "k");

        expect(headers["x-api-key"]).toBe("k");
        expect(headers["anthropic-version"]).toBeDefined();
    });
});

describe(buildModelsUrl, () => {
    it("appends /models to an OpenAI-compatible base URL", () => {
        expect.assertions(1);
        expect(buildModelsUrl("openai", "https://ollama.example.com/v1")).toBe("https://ollama.example.com/v1/models");
    });

    it.each([
        ["server root", "https://api.deepseek.com/anthropic", "https://api.deepseek.com/anthropic/v1/models?limit=1000"],
        ["root that already ends in /v1", "https://api.anthropic.com/v1", "https://api.anthropic.com/v1/models?limit=1000"],
    ])("resolves /v1/models for an Anthropic %s", (_label, baseUrl, expected) => {
        expect.assertions(1);
        expect(buildModelsUrl("anthropic", baseUrl)).toBe(expected);
    });
});

describe("parseModelsResponse — Anthropic /v1/models", () => {
    it("reads the paginated list shape and keeps display names", () => {
        expect.assertions(1);
        expect(
            parseModelsResponse({
                data: [
                    { created_at: "2025-05-14T00:00:00Z", display_name: "Claude Sonnet 4", id: "claude-sonnet-4-20250514", type: "model" },
                    { created_at: "2024-10-22T00:00:00Z", display_name: "claude-3-5-haiku-20241022", id: "claude-3-5-haiku-20241022", type: "model" },
                ],
                first_id: "claude-sonnet-4-20250514",
                has_more: false,
                last_id: "claude-3-5-haiku-20241022",
            }),
        ).toStrictEqual([{ id: "claude-3-5-haiku-20241022" }, { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" }]);
    });
});

describe(generateCustomProviderId, () => {
    it("slugs the name", () => {
        expect.assertions(1);
        expect(generateCustomProviderId("My Ollama Box!", new Set())).toBe("my-ollama-box");
    });

    it("suffixes on collision", () => {
        expect.assertions(1);
        expect(generateCustomProviderId("ollama", new Set(["ollama"]), () => "abc123")).toBe("ollama-abc123");
    });

    it("falls back when the name has no usable characters", () => {
        expect.assertions(1);
        expect(generateCustomProviderId("🦙", new Set())).toBe("custom");
    });
});

describe(toGatewayFormat, () => {
    it("maps stored types to gateway wire formats", () => {
        expect.assertions(2);
        expect(toGatewayFormat(undefined)).toBe("openai-chat");
        expect(toGatewayFormat("anthropic")).toBe("anthropic");
    });
});

describe(validateEndpointUrlForType, () => {
    const loopback = ["http", "//localhost:11434/v1"].join(":");

    it("holds a local-browser endpoint to loopback and nothing else", () => {
        expect.assertions(3);
        expect(validateEndpointUrlForType("local-browser", loopback)).toStrictEqual({ url: loopback });
        expect(validateEndpointUrlForType("local-browser", "https://ollama.example.com/v1")).toHaveProperty("error");
        expect(validateEndpointUrlForType("local-browser", ["http", "//192.168.1.5:11434/v1"].join(":"))).toHaveProperty("error");
    });

    it("keeps the server-side kinds on public https, so loopback stays refused there", () => {
        expect.assertions(3);
        expect(validateEndpointUrlForType("openai", loopback)).toHaveProperty("error");
        expect(validateEndpointUrlForType("anthropic", loopback)).toHaveProperty("error");
        expect(validateEndpointUrlForType("openai", "https://ollama.example.com/v1")).toStrictEqual({ url: "https://ollama.example.com/v1" });
    });
});

describe(isLocalBrowserProvider, () => {
    it("recognises only the local-browser kind", () => {
        expect.assertions(3);
        expect(isLocalBrowserProvider("local-browser")).toBe(true);
        expect(isLocalBrowserProvider("openai")).toBe(false);
        expect(isLocalBrowserProvider(undefined)).toBe(false);
    });
});

describe("provider-native accounts", () => {
    it("pins each native kind's URL regardless of what the client sent", () => {
        expect.assertions(4);
        expect(validateEndpointUrlForType("google", "https://attacker.example.com")).toStrictEqual({ url: "https://generativelanguage.googleapis.com/v1beta" });
        expect(validateEndpointUrlForType("mistral", "https://attacker.example.com")).toStrictEqual({ url: "https://api.mistral.ai/v1" });
        expect(validateEndpointUrlForType("bedrock", "https://attacker.example.com", { region: "eu-west-1" })).toStrictEqual({
            url: "https://bedrock-runtime.eu-west-1.amazonaws.com",
        });
        expect(validateEndpointUrlForType("azure", "https://my-res.openai.azure.com/openai/v1")).toStrictEqual({ url: "https://my-res.openai.azure.com" });
    });

    it("refuses an Azure host off Azure and a Bedrock row without a real region", () => {
        expect.assertions(3);
        expect(validateEndpointUrlForType("azure", "https://proxy.example.com")).toHaveProperty("error");
        expect(validateEndpointUrlForType("bedrock", "https://x.example.com")).toHaveProperty("error");
        expect(validateEndpointUrlForType("bedrock", "https://x.example.com", { region: "x.example.com" })).toHaveProperty("error");
    });

    it("maps native kinds to their own gateway format and nothing else to them", () => {
        expect.assertions(6);
        expect(toGatewayFormat("google")).toBe("google");
        expect(toGatewayFormat("azure")).toBe("azure");
        expect(toGatewayFormat("bedrock")).toBe("bedrock");
        expect(toGatewayFormat("mistral")).toBe("mistral");
        expect(toGatewayFormat("openai")).toBe("openai-chat");
        expect(isNativeProvider("local-browser")).toBe(false);
    });

    it("authenticates the models probe the way each provider expects", () => {
        expect.assertions(3);
        expect(buildModelsRequestHeaders("google", "AIza-k")["x-goog-api-key"]).toBe("AIza-k");
        expect(buildModelsRequestHeaders("azure", "az")["api-key"]).toBe("az");
        expect(buildModelsRequestHeaders("mistral", "m").authorization).toBe("Bearer m");
    });

    it("lists Gemini models from Google's shape, without embedders or the models/ prefix", () => {
        expect.assertions(2);
        expect(buildModelsUrl("google", "https://generativelanguage.googleapis.com/v1beta")).toBe(
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
        );
        expect(
            parseGoogleModelsResponse({
                models: [
                    { displayName: "Gemini 2.5 Flash", name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
                    { displayName: "Embedding", name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
                ],
            }),
        ).toStrictEqual([{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }]);
    });
});
