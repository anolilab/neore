/**
 * Provider-native BYOK rows (`custom` provider with a `google` / `azure` /
 * `bedrock` / `mistral` format): the SDK each one builds, and — the security
 * property — the one host the user's key is ever sent to, whatever `baseUrl`
 * the request carries.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayError } from "../lib/errors.js";
import type { CustomProviderConfig } from "../providers/factory.js";
import { createProviderModel } from "../providers/factory.js";

/** Fake AWS credentials assembled at runtime, so no literal in this file looks like a real key to a secret scanner. */
const AWS_KEY_PREFIX = ["AK", "IA"].join("");
const ACCESS_KEY_ID = `${AWS_KEY_PREFIX}${"Q".repeat(16)}`;
const AWS_SECRET_KEY = `${"s".repeat(20)}/${"S".repeat(19)}`;

const SIGV4_AUTHORIZATION_RE = new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/`);

type Captured = { init?: RequestInit; url: string };

/** Record every outbound request and answer it with a provider error, so no call succeeds or leaves the process. */
const captureFetch = (): Captured[] => {
    const calls: Captured[] = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ init, url: input instanceof Request ? input.url : String(input) });

        return Response.json({ error: { message: "stop" } }, { status: 400 });
    });

    return calls;
};

const build = async (modelApiId: string, config: Omit<CustomProviderConfig, "id">) =>
    (await createProviderModel("custom", modelApiId, "", undefined, undefined, { ...config, id: "mine" })) as unknown as {
        doGenerate: (options: unknown) => Promise<unknown>;
        modelId: string;
        provider: string;
    };

const generate = async (model: Awaited<ReturnType<typeof build>>): Promise<void> => {
    await model.doGenerate({ prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }] }).catch(() => undefined);
};

const header = (call: Captured | undefined, name: string): string | null => new Headers(call?.init?.headers).get(name);

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createProviderModel — provider-native BYOK", () => {
    it("sends a Gemini key only to Google, ignoring the request's baseUrl", async () => {
        expect.assertions(4);

        const calls = captureFetch();
        const model = await build("gemini-2.5-flash", { apiKey: "AIza-user", baseUrl: "https://attacker.example.com", format: "google" });

        await generate(model);

        expect(model.provider).toBe("google.generative-ai");
        expect(model.modelId).toBe("gemini-2.5-flash");
        expect(new URL(calls[0]!.url).host).toBe("generativelanguage.googleapis.com");
        expect(header(calls[0], "x-goog-api-key")).toBe("AIza-user");
    });

    it("sends a Mistral key only to api.mistral.ai", async () => {
        expect.assertions(3);

        const calls = captureFetch();
        const model = await build("mistral-small-latest", { apiKey: "m-key", baseUrl: "https://attacker.example.com/v1", format: "mistral" });

        await generate(model);

        expect(model.provider).toBe("mistral.chat");
        expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/chat/completions");
        expect(header(calls[0], "authorization")).toBe("Bearer m-key");
    });

    it("calls an Azure deployment through the v1 API by default", async () => {
        expect.assertions(4);

        const calls = captureFetch();
        const model = await build("my-gpt4o", { apiKey: "az-key", baseUrl: "https://my-res.openai.azure.com", format: "azure" });

        await generate(model);

        const url = new URL(calls[0]!.url);

        expect(`${url.origin}${url.pathname}`).toBe("https://my-res.openai.azure.com/openai/v1/chat/completions");
        expect(url.searchParams.get("api-version")).toBe("v1");
        expect(header(calls[0], "api-key")).toBe("az-key");
        expect(JSON.parse(String(calls[0]?.init?.body)).model).toBe("my-gpt4o");
    });

    it("addresses the deployment by URL for a dated api-version", async () => {
        expect.assertions(2);

        const calls = captureFetch();

        await generate(await build("my-gpt4o", { apiKey: "az-key", apiVersion: "2024-10-21", baseUrl: "https://my-res.openai.azure.com", format: "azure" }));

        const url = new URL(calls[0]!.url);

        expect(`${url.origin}${url.pathname}`).toBe("https://my-res.openai.azure.com/openai/deployments/my-gpt4o/chat/completions");
        expect(url.searchParams.get("api-version")).toBe("2024-10-21");
    });

    it("sends a Bedrock API key as a bearer token to the region's runtime host", async () => {
        expect.assertions(3);

        const calls = captureFetch();

        await generate(
            await build("amazon.nova-pro-v1:0", { apiKey: "ABSK-user", baseUrl: "https://attacker.example.com", format: "bedrock", region: "eu-central-1" }),
        );

        const url = new URL(calls[0]!.url);

        expect(url.host).toBe("bedrock-runtime.eu-central-1.amazonaws.com");
        expect(url.pathname).toBe(`/model/${encodeURIComponent("amazon.nova-pro-v1:0")}/converse`);
        expect(header(calls[0], "authorization")).toBe("Bearer ABSK-user");
    });

    it("signs Bedrock requests with SigV4 when an access key id is set", async () => {
        expect.assertions(2);

        const calls = captureFetch();

        await generate(
            await build("amazon.nova-pro-v1:0", {
                accessKeyId: ACCESS_KEY_ID,
                apiKey: AWS_SECRET_KEY,
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                format: "bedrock",
                region: "us-east-1",
            }),
        );

        expect(new URL(calls[0]!.url).host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
        expect(header(calls[0], "authorization")).toMatch(SIGV4_AUTHORIZATION_RE);
    });

    it.each([
        ["an Azure endpoint off Azure's hosts", { apiKey: "k", baseUrl: "https://evil.example.com", format: "azure" }],
        // eslint-disable-next-line sonarjs/no-clear-text-protocols, unicorn/prefer-https -- plain http is the case under test
        ["an Azure endpoint over http", { apiKey: "k", baseUrl: "http://my-res.openai.azure.com", format: "azure" }],
        ["an invalid Azure api-version", { apiKey: "k", apiVersion: "latest&x=1", baseUrl: "https://my-res.openai.azure.com", format: "azure" }],
        ["a Bedrock region that is a host", { apiKey: "k", baseUrl: "https://x.example.com", format: "bedrock", region: "evil.example.com/x" }],
        ["a Bedrock row without a region", { apiKey: "k", baseUrl: "https://x.example.com", format: "bedrock" }],
        ["a native row without a key", { apiKey: "", baseUrl: "https://generativelanguage.googleapis.com/v1beta", format: "google" }],
    ] as const)("refuses %s", async (_label, config) => {
        expect.assertions(1);

        await expect(build("m", config as Omit<CustomProviderConfig, "id">)).rejects.toBeInstanceOf(GatewayError);
    });
});
