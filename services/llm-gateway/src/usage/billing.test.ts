import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BYOK_FEE_RATE, isHostedProviderUrl, resolveBillingMode, resolveByokFeeRate } from "./billing";

describe(resolveBillingMode, () => {
    it("is platform without a user key", () => {
        expect(resolveBillingMode({ isCustom: false })).toBe("platform");
        expect(resolveBillingMode({ isCustom: false, providerApiKey: "" })).toBe("platform");
    });

    it("is byok with a user key", () => {
        expect(resolveBillingMode({ isCustom: false, providerApiKey: "sk-user" })).toBe("byok");
    });

    it("is custom for a custom endpoint, key or not", () => {
        expect(resolveBillingMode({ isCustom: true, providerApiKey: "sk-user" })).toBe("custom");
        expect(resolveBillingMode({ customFormat: "openai-chat", isCustom: true })).toBe("custom");
        expect(resolveBillingMode({ customFormat: "anthropic", isCustom: true })).toBe("custom");
    });

    it.each(["google", "azure", "bedrock", "mistral"] as const)("is byok for a native %s account — the user's own key for that provider", (customFormat) => {
        expect(resolveBillingMode({ customFormat, isCustom: true })).toBe("byok");
    });
});

const HOSTED_PROVIDER_URLS = [
    "https://api.openai.com/v1",
    "https://eu.api.openai.com/v1",
    "https://api.anthropic.com",
    "https://api.anthropic.com/v1",
    "https://api.mistral.ai/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai/",
    "https://us-central1-aiplatform.googleapis.com/v1",
    "https://aiplatform.googleapis.com/v1",
    "https://my-resource.openai.azure.com/openai/v1",
    "https://my-resource.cognitiveservices.azure.com/openai",
    "https://my-project.services.ai.azure.com/models",
    "https://bedrock-runtime.us-east-1.amazonaws.com",
    "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
    "https://api.groq.com/openai/v1",
    "https://api.x.ai/v1",
    "https://openrouter.ai/api/v1",
    "https://api.deepseek.com",
    "https://api.together.xyz/v1",
    "https://api.together.ai/v1",
    "https://api.fireworks.ai/inference/v1",
    "https://api.cerebras.ai/v1",
    "https://api.perplexity.ai",
    "https://api.deepinfra.com/v1/openai",
    "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1",
    // Case, port and a trailing root dot do not change the host.
    "https://API.OpenAI.com:443/v1",
    "https://api.openai.com./v1",
    // Userinfo is not the host: this request really goes to api.openai.com.
    "https://evil.test@api.openai.com/v1",
] as const;

const NOT_HOSTED_PROVIDER_URLS = [
    // Look-alikes: the provider's name is a label, not the registrable domain.
    "https://api.openai.com.evil.test/v1",
    "https://api.openai.com@evil.test/v1",
    "https://api.openai.com:pw@evil.test/v1",
    "https://evilopenai.com/v1",
    "https://openai.com-proxy.example/v1",
    "https://api-openai.com/v1",
    "https://generativelanguage.googleapis.com.evil.test/v1",
    "https://anthropic.example.com/v1",
    // Shared clouds: a user's own host there is not a provider.
    "https://my-vllm.us-east-1.elb.amazonaws.com/v1",
    "https://ec2-1-2-3-4.compute-1.amazonaws.com/v1",
    "https://bedrock-runtime.us-east-1.amazonaws.com.evil.test",
    "https://my-app.azurewebsites.net/v1",
    "https://storage.googleapis.com/v1",
    // Self-hosted.
    "http://localhost:11434/v1",
    "https://llm.internal.example/v1",
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- a self-hosted endpoint is the point of this fixture
    "http://10.0.0.5:8000/v1",
    // Unparseable.
    "not a url",
    "",
] as const;

describe(isHostedProviderUrl, () => {
    it.each(HOSTED_PROVIDER_URLS)("recognises %s", (url) => {
        expect(isHostedProviderUrl(url)).toBe(true);
    });

    it.each(NOT_HOSTED_PROVIDER_URLS)("does not recognise %s", (url) => {
        expect(isHostedProviderUrl(url)).toBe(false);
    });
});

describe("resolveBillingMode for compatible-format custom rows", () => {
    it.each(HOSTED_PROVIDER_URLS)("bills a row pointed at %s as byok", (customBaseUrl) => {
        expect(resolveBillingMode({ customBaseUrl, customFormat: "openai-chat", isCustom: true })).toBe("byok");
        expect(resolveBillingMode({ customBaseUrl, customFormat: "anthropic", isCustom: true })).toBe("byok");
    });

    it.each(NOT_HOSTED_PROVIDER_URLS)("keeps a row pointed at %s custom", (customBaseUrl) => {
        expect(resolveBillingMode({ customBaseUrl, customFormat: "openai-chat", isCustom: true })).toBe("custom");
        expect(resolveBillingMode({ customBaseUrl, customFormat: "anthropic", isCustom: true })).toBe("custom");
    });

    it("keeps a native format byok whatever its base URL", () => {
        expect(resolveBillingMode({ customBaseUrl: "http://localhost:8080", customFormat: "azure", isCustom: true })).toBe("byok");
    });
});

describe(resolveByokFeeRate, () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("defaults to 10% when unset or blank", () => {
        expect(resolveByokFeeRate(undefined)).toBe(DEFAULT_BYOK_FEE_RATE);
        expect(resolveByokFeeRate(" ")).toBe(DEFAULT_BYOK_FEE_RATE);
    });

    it("accepts values in 0..1, including 0", () => {
        expect(resolveByokFeeRate("0")).toBe(0);
        expect(resolveByokFeeRate("0.25")).toBe(0.25);
        expect(resolveByokFeeRate("1")).toBe(1);
    });

    it.each(["abc", "-0.1", "1.5", "NaN", "Infinity"])("falls back to the default and logs for %s", (raw) => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(resolveByokFeeRate(raw)).toBe(DEFAULT_BYOK_FEE_RATE);
        expect(error).toHaveBeenCalledOnce();
    });
});
