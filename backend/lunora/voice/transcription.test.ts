/**
 * `transcribeClip` sends a recorded clip to a paid speech-to-text call, so:
 * guests are refused, the daily allowance is charged by the clip's seconds
 * before the gateway is reached, the user's own OpenAI key rides along for BYOK
 * billing, and neither the audio nor the text is saved.
 *
 * `gatewayFetch` is pointed at a fake binding; the global `fetch` throws.
 */
import { lunoraTest } from "@lunora/testing";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internalQuery } from "../_generated/server";
import { createRatelimit } from "../lib/rate-limiter";
import schema from "../schema";
import { MAX_CLIP_SECONDS, TRANSCRIPTION_DAILY_LIMIT_MESSAGE, TRANSCRIPTION_GUEST_MESSAGE, transcribeClip } from "./transcription";

const { binding, providerKeys, registry, sessionFrom, users } = vi.hoisted(() => {
    return {
        /** The fake `SERVICE_LLM_GATEWAY` binding: what `ctx.services.llmGateway.fetch` would reach. */
        binding: { contexts: [] as unknown[], fetch: undefined as unknown as (input: Request | string | URL, init?: RequestInit) => Promise<Response> },
        providerKeys: { current: {} as Record<string, string> },
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, plan: null, role: null, userId: context.auth.userId }
                : null,
        users: new Map<string, { isAnonymous?: boolean; role?: string }>(),
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../lib/services", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/services")>()),
        gatewayFetch: (ctx: unknown) => {
            binding.contexts.push(ctx);

            return async (input: Request | string | URL, init?: RequestInit) => await binding.fetch(input, init);
        },
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

// The per-minute bucket is not under test; the daily charge goes through `applyRateLimit`.
vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

// `user` is a `.global()` (D1) table the in-memory harness cannot write.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            const user = users.get(userId);

            return user ? { _id: userId, ...user } : null;
        },
    };
});

const MEMBER = "member-1";
const GUEST = "guest-1";
const GATEWAY = "https://llm-gateway.internal";
const AUDIO = btoa("fake m4a bytes");

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
const gatewayCalls: { body: Record<string, unknown>; url: string }[] = [];

const transcribe = async (userId: string, durationMs = 2500): Promise<{ text: string }> =>
    (await harness.withIdentity({ userId } as never).action(transcribeClip as never, { audio: AUDIO, durationMs } as never)) as { text: string };

const remainingSeconds = async (userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { remaining } = await createRatelimit("voice/dailyTranscribeSeconds:free", ctx.db as never).getRemaining(userId);

        return remaining;
    });

beforeAll(async () => {
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));
    // Decrypting real BYOK ciphertext is not under test: answer with plaintext keys.
    registry.set(
        "auth_functions:getDecryptedProviderKeysQuery",
        internalQuery
            .input({ userId: v.string() })
            .output(v.record(v.string(), v.string()))
            .query(async () => providerKeys.current),
    );
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    users.set(MEMBER, {});
    users.set(GUEST, { isAnonymous: true });
    providerKeys.current = {};
    binding.contexts.length = 0;
    binding.fetch = async (input, init) => {
        gatewayCalls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, url: String(input) });

        return Response.json({ costMicrodollars: 300, text: "  hello there  " });
    };
    vi.stubGlobal("fetch", async () => {
        throw new Error("transcribeClip called the global fetch instead of the gateway's service binding");
    });
});

afterEach(() => {
    harness.close();
    users.clear();
    gatewayCalls.length = 0;
    vi.unstubAllGlobals();
});

describe("transcribeClip", () => {
    it("refuses a guest before charging or calling the gateway", async () => {
        const before = await remainingSeconds(GUEST);

        await expect(transcribe(GUEST)).rejects.toThrow(TRANSCRIPTION_GUEST_MESSAGE);
        expect(gatewayCalls).toHaveLength(0);
        expect(await remainingSeconds(GUEST)).toBe(before);
    });

    it("returns the trimmed text, charges the clip's seconds, sends the user's own key, and saves nothing", async () => {
        providerKeys.current = { fal: "other", openai: "user-openai-key" };
        const before = await remainingSeconds(MEMBER);

        await expect(transcribe(MEMBER, 2500)).resolves.toEqual({ text: "hello there" });

        expect(await remainingSeconds(MEMBER)).toBe(before - 3);
        expect(gatewayCalls).toEqual([
            {
                body: expect.objectContaining({ audio: AUDIO, durationSeconds: 3, providerApiKey: "user-openai-key", userId: MEMBER }),
                url: `${GATEWAY}/internal/transcription`,
            },
        ]);

        const rows = await harness.run(async (ctx: any) => [...(await ctx.db.query("messages").take(1)), ...(await ctx.db.query("chatFiles").take(1))]);

        expect(rows).toEqual([]);
    });

    it("refuses once the daily allowance cannot cover the clip, without calling the gateway", async () => {
        await harness.run(async (ctx: any) => {
            const limiter = createRatelimit("voice/dailyTranscribeSeconds:free", ctx.db as never);
            const { remaining } = await limiter.getRemaining(MEMBER);

            await limiter.limit(MEMBER, { count: remaining - 1 });
        });

        await expect(transcribe(MEMBER, 5000)).rejects.toThrow(TRANSCRIPTION_DAILY_LIMIT_MESSAGE);
        expect(gatewayCalls).toHaveLength(0);
    });

    it("refuses a clip longer than the cap", async () => {
        await expect(transcribe(MEMBER, (MAX_CLIP_SECONDS + 5) * 1000)).rejects.toThrow("too long");
        expect(gatewayCalls).toHaveLength(0);
    });

    it("surfaces a gateway failure", async () => {
        binding.fetch = async () => Response.json({ error: "boom" }, { status: 502 });

        await expect(transcribe(MEMBER)).rejects.toThrow("Transcription gateway error");
    });
});
