import { describe, expect, it } from "vitest";

import {
    bedrockRuntimeUrl,
    isAwsAccessKeyId,
    isAwsRegion,
    isAzureApiVersion,
    isBillingMode,
    isDatedAzureApiVersion,
    isNativeProviderFormat,
    parseAzureOpenAIEndpoint,
    toAnthropicApiBase,
    validateNativeProviderKey,
} from "./gateway";

/** Fake AWS credentials assembled at runtime, so no literal in this file looks like a real key to a secret scanner. */
const AWS_KEY_PREFIX = ["AK", "IA"].join("");
const ACCESS_KEY_ID = `${AWS_KEY_PREFIX}${"Q".repeat(16)}`;
const AWS_SECRET_KEY = `${"s".repeat(20)}/${"S".repeat(19)}`;

describe(toAnthropicApiBase, () => {
    it.each([
        ["https://api.deepseek.com/anthropic", "https://api.deepseek.com/anthropic/v1"],
        ["https://api.anthropic.com/v1", "https://api.anthropic.com/v1"],
    ])("maps %s to %s", (input, expected) => {
        expect.assertions(1);
        expect(toAnthropicApiBase(input)).toBe(expected);
    });
});

describe(isBillingMode, () => {
    it("accepts the three modes and nothing else", () => {
        expect.assertions(5);
        expect(isBillingMode("platform")).toBe(true);
        expect(isBillingMode("byok")).toBe(true);
        expect(isBillingMode("custom")).toBe(true);
        expect(isBillingMode("free")).toBe(false);
        expect(isBillingMode(undefined)).toBe(false);
    });
});

describe(isNativeProviderFormat, () => {
    it("covers the four provider-native formats and not the compatible ones", () => {
        expect.assertions(6);
        expect(isNativeProviderFormat("google")).toBe(true);
        expect(isNativeProviderFormat("azure")).toBe(true);
        expect(isNativeProviderFormat("bedrock")).toBe(true);
        expect(isNativeProviderFormat("mistral")).toBe(true);
        expect(isNativeProviderFormat("openai-chat")).toBe(false);
        expect(isNativeProviderFormat("anthropic")).toBe(false);
    });
});

describe(validateNativeProviderKey, () => {
    const gemini = `AIza${"a".repeat(35)}`;
    const secret = AWS_SECRET_KEY;

    it.each([
        ["google", gemini],
        ["mistral", "abcdefghijklmnopqrstuvwxyz012345"],
        ["azure", "0123456789abcdef0123456789abcdef"],
        ["bedrock", `ABSK${"Q".repeat(40)}`],
        ["bedrock", `bedrock-api-key-${"x".repeat(40)}`],
    ] as const)("accepts a well-formed %s key", (format, key) => {
        expect.assertions(1);
        expect(validateNativeProviderKey(format, key)).toBeNull();
    });

    it.each([
        ["google", "sk-proj-not-a-gemini-key-000000000000000"],
        ["google", gemini.slice(0, 20)],
        ["mistral", "sk-ant-api03-short"],
        ["azure", "not a key"],
        ["bedrock", secret],
    ] as const)("rejects a %s key of the wrong shape: %s", (format, key) => {
        expect.assertions(1);
        expect(validateNativeProviderKey(format, key)).toEqual(expect.any(String));
    });

    it("reads a Bedrock key as the secret access key when an access key id is given", () => {
        expect.assertions(2);
        expect(validateNativeProviderKey("bedrock", secret, { accessKeyId: ACCESS_KEY_ID })).toBeNull();
        expect(validateNativeProviderKey("bedrock", `ABSK${"Q".repeat(40)}`, { accessKeyId: ACCESS_KEY_ID })).toEqual(expect.any(String));
    });

    it("ignores surrounding whitespace from a paste", () => {
        expect.assertions(1);
        expect(validateNativeProviderKey("google", `  ${gemini}\n`)).toBeNull();
    });
});

describe(parseAzureOpenAIEndpoint, () => {
    it.each([
        ["https://my-res.openai.azure.com", "https://my-res.openai.azure.com"],
        ["https://my-res.openai.azure.com/", "https://my-res.openai.azure.com"],
        ["https://My-Res.openai.azure.com/openai/v1", "https://my-res.openai.azure.com"],
        ["https://my-res.cognitiveservices.azure.com", "https://my-res.cognitiveservices.azure.com"],
        ["https://proj.services.ai.azure.com", "https://proj.services.ai.azure.com"],
    ])("normalises %s", (input, expected) => {
        expect.assertions(1);
        expect(parseAzureOpenAIEndpoint(input)).toStrictEqual({ url: expected });
    });

    it.each([
        // Plain http is exactly what this case refuses.
        // eslint-disable-next-line sonarjs/no-clear-text-protocols, unicorn/prefer-https
        "http://my-res.openai.azure.com",
        "https://evil.example.com",
        "https://openai.azure.com.evil.example.com",
        "https://my-res.openai.azure.com:8443",
        "https://user:pw@my-res.openai.azure.com",
        "https://a.b.openai.azure.com",
        "not a url",
    ])("refuses %s", (input) => {
        expect.assertions(1);
        expect(parseAzureOpenAIEndpoint(input)).toHaveProperty("error");
    });
});

describe("azure api-version", () => {
    it("accepts v1, preview and dated versions", () => {
        expect.assertions(6);
        expect(isAzureApiVersion("v1")).toBe(true);
        expect(isAzureApiVersion("preview")).toBe(true);
        expect(isAzureApiVersion("2024-10-21")).toBe(true);
        expect(isAzureApiVersion("2025-04-01-preview")).toBe(true);
        expect(isAzureApiVersion("latest")).toBe(false);
        expect(isAzureApiVersion("2024-10-21&x=1")).toBe(false);
    });

    it("marks only dated versions as deployment-URL versions", () => {
        expect.assertions(2);
        expect(isDatedAzureApiVersion("2024-10-21")).toBe(true);
        expect(isDatedAzureApiVersion("v1")).toBe(false);
    });
});

describe("aws", () => {
    it("validates regions and builds the runtime host from one", () => {
        expect.assertions(5);
        expect(isAwsRegion("us-east-1")).toBe(true);
        expect(isAwsRegion("us-gov-west-1")).toBe(true);
        expect(isAwsRegion("eu-central-2")).toBe(true);
        expect(isAwsRegion("evil.com/x")).toBe(false);
        expect(bedrockRuntimeUrl("eu-central-1")).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
    });

    it("accepts only long-term access key ids", () => {
        expect.assertions(3);
        expect(isAwsAccessKeyId(ACCESS_KEY_ID)).toBe(true);
        expect(isAwsAccessKeyId("ASIAIOSFODNN7EXAMPLE")).toBe(false);
        expect(isAwsAccessKeyId("akiaiosfodnn7example")).toBe(false);
    });
});
