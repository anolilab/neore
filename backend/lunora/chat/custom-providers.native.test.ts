/**
 * Provider-native accounts (Gemini, Azure OpenAI, Bedrock, Mistral) through the
 * real `saveCustomProvider`: the key is shape-checked and encrypted, the host
 * is pinned whatever URL the client sends, and a stored key never follows a
 * change of region, access key id or provider without being re-entered.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    // `lib/encryption.ts` reads the key at import.
    process.env.ENCRYPTION_KEY ??= btoa(String.fromCodePoint(...Array.from({ length: 32 }, (_, index) => index + 1)));
});

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

// eslint-disable-next-line import/first -- the mocks above must be hoisted before these load
import schema from "../schema";
// eslint-disable-next-line import/first
import { getDecryptedCustomProvider, listCustomProviders, saveCustomProvider } from "./custom-providers";

/** Fake AWS credentials assembled at runtime, so no literal in this file looks like a real key to a secret scanner. */
const AWS_KEY_PREFIX = ["AK", "IA"].join("");
const ACCESS_KEY_ID = `${AWS_KEY_PREFIX}${"Q".repeat(16)}`;
const OTHER_ACCESS_KEY_ID = `${AWS_KEY_PREFIX}${"R".repeat(16)}`;
const AWS_SECRET_KEY = `${"s".repeat(20)}/${"S".repeat(19)}`;

const GEMINI_KEY = `AIza${"G".repeat(35)}`;
const AWS_SECRET = AWS_SECRET_KEY;
const USER = "user-a";

let harness: ReturnType<typeof lunoraTest>;

const as = () => harness.withIdentity({ userId: USER } as never);
const save = async (args: Record<string, unknown>): Promise<{ id: string }> =>
    (await as().mutation(saveCustomProvider as never, { enabled: true, models: [{ id: "m" }], name: "Mine", supportsTools: true, ...args } as never)) as {
        id: string;
    };
const decrypted = async (providerId: string): Promise<Record<string, unknown> | null> =>
    (await harness.run(async (ctx: any) => await ctx.runQuery(getDecryptedCustomProvider, { providerId, userId: USER }))) as Record<string, unknown> | null;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("saveCustomProvider — provider-native accounts", () => {
    it("pins Gemini to Google's API whatever URL is sent, and stores the key encrypted", async () => {
        const { id } = await save({ apiKey: GEMINI_KEY, baseUrl: "https://attacker.example.com", type: "google" });
        const listed = (await as().query(listCustomProviders as never, {} as never)) as Record<string, unknown>[];

        expect(listed).toStrictEqual([
            expect.objectContaining({ baseUrl: "https://generativelanguage.googleapis.com/v1beta", hasApiKey: true, last4: "GGGG", type: "google" }),
        ]);
        expect(JSON.stringify(listed)).not.toContain(GEMINI_KEY);
        expect(await decrypted(id)).toMatchObject({ apiKey: GEMINI_KEY, baseUrl: "https://generativelanguage.googleapis.com/v1beta", type: "google" });
    });

    it("refuses a key of the wrong shape, and a native account with no key at all", async () => {
        await expect(save({ apiKey: "sk-proj-openai-key", baseUrl: "https://x.example.com", type: "google" })).rejects.toThrow("AIza");
        await expect(save({ baseUrl: "https://x.example.com", type: "mistral" })).rejects.toThrow("Enter the API key");
    });

    it("stores an Azure resource with its api-version, defaulting to v1, and refuses a host off Azure", async () => {
        const { id } = await save({ apiKey: "a".repeat(32), baseUrl: "https://my-res.openai.azure.com/openai/v1", type: "azure" });

        expect(await decrypted(id)).toMatchObject({ apiVersion: "v1", baseUrl: "https://my-res.openai.azure.com", type: "azure" });
        await expect(save({ apiKey: "a".repeat(32), baseUrl: "https://proxy.example.com", type: "azure" })).rejects.toThrow("Azure");
        await expect(save({ apiKey: "a".repeat(32), apiVersion: "latest", baseUrl: "https://my-res.openai.azure.com", type: "azure" })).rejects.toThrow(
            "API version",
        );
    });

    it("derives Bedrock's host from the region and keeps the access key id with its secret", async () => {
        const { id } = await save({
            accessKeyId: ACCESS_KEY_ID,
            apiKey: AWS_SECRET,
            baseUrl: "https://ignored.example.com",
            region: "eu-central-1",
            type: "bedrock",
        });

        expect(await decrypted(id)).toMatchObject({
            accessKeyId: ACCESS_KEY_ID,
            apiKey: AWS_SECRET,
            baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com",
            region: "eu-central-1",
            type: "bedrock",
        });
    });

    it("refuses a Bedrock region that is not one, and an access key id that is not one", async () => {
        await expect(save({ apiKey: `ABSK${"x".repeat(40)}`, baseUrl: "https://x.example.com", region: "evil.example.com/", type: "bedrock" })).rejects.toThrow(
            "region",
        );
        await expect(
            save({ accessKeyId: "not-an-id", apiKey: AWS_SECRET, baseUrl: "https://x.example.com", region: "us-east-1", type: "bedrock" }),
        ).rejects.toThrow("access key id");
    });

    it("does not carry a stored key over to another region, access key id or provider", async () => {
        const base = { accessKeyId: ACCESS_KEY_ID, baseUrl: "https://x.example.com", region: "us-east-1", type: "bedrock" };
        const { id } = await save({ ...base, apiKey: AWS_SECRET });

        // Omitting the key keeps it — only while nothing it is bound to moves.
        await expect(save({ ...base, id })).resolves.toStrictEqual({ id });
        await expect(save({ ...base, id, region: "eu-west-1" })).rejects.toThrow("Re-enter");
        await expect(save({ ...base, accessKeyId: OTHER_ACCESS_KEY_ID, id })).rejects.toThrow("Re-enter");
        await expect(save({ ...base, id, type: "mistral" })).rejects.toThrow("Re-enter");
    });
});
