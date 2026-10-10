/**
 * `synthesizeSpeech` is a paid TTS call on client-supplied text, so: guests are
 * refused, the text is capped per call and charged BY LENGTH to the daily
 * speech allowance before the gateway is reached, the user's own FAL key rides
 * along for BYOK billing, and nothing is written to the thread.
 *
 * The gateway is reached over its service binding (`ctx.services.llmGateway`),
 * which the in-memory harness does not build: `gatewayFetch` is pointed at a
 * fake binding here, and the global `fetch` throws, so a call that bypassed the
 * binding would fail the suite.
 */
import { DEFAULT_SPEECH_MODEL } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internalQuery } from "../_generated/server";
import { createRatelimit } from "../lib/rate-limiter";
import schema from "../schema";
import { MAX_SPEECH_CHARS, SPEECH_DAILY_LIMIT_MESSAGE, SPEECH_GUEST_MESSAGE, synthesizeSpeech } from "./speech";

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
const ADMIN = "admin-1";
const GATEWAY = "https://llm-gateway.internal";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
const gatewayCalls: { body: Record<string, unknown>; headers: Headers; url: string }[] = [];

const speak = async (userId: string, text: string, voice?: string): Promise<{ audio: string; mimeType: string }> =>
    (await harness.withIdentity({ userId } as never).action(synthesizeSpeech as never, { text, ...(voice && { voice }) } as never)) as {
        audio: string;
        mimeType: string;
    };

const remainingChars = async (userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { remaining } = await createRatelimit("voice/dailySpeechChars:free", ctx.db as never).getRemaining(userId);

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
    users.set(ADMIN, { role: "admin" });
    providerKeys.current = {};
    binding.contexts.length = 0;
    binding.fetch = async (input, init) => {
        gatewayCalls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers), url: String(input) });

        return new Response(new Uint8Array([104, 105]), { headers: { "content-type": "audio/mpeg" } });
    };
    // Nothing may go over the internet: the binding is the only way to the gateway.
    vi.stubGlobal("fetch", async () => {
        throw new Error("synthesizeSpeech called the global fetch instead of the gateway's service binding");
    });
});

afterEach(() => {
    harness.close();
    users.clear();
    gatewayCalls.length = 0;
    vi.unstubAllGlobals();
});

describe("synthesizeSpeech", () => {
    it("refuses a guest before charging or calling the gateway", async () => {
        await expect(speak(GUEST, "Hello")).rejects.toThrow(SPEECH_GUEST_MESSAGE);
        expect(gatewayCalls).toHaveLength(0);
    });

    it("returns the gateway's audio and saves nothing to the thread", async () => {
        await expect(speak(MEMBER, "Hello there.", "Calm_Woman")).resolves.toEqual({ audio: btoa("hi"), mimeType: "audio/mpeg" });

        expect(gatewayCalls).toHaveLength(1);
        expect(gatewayCalls[0]?.url).toBe(`${GATEWAY}/internal/speech`);
        // Nothing is signed: the binding is the authentication.
        expect(gatewayCalls[0]?.headers.get("X-Signature")).toBeNull();
        // The binding came from the action's own ctx.
        expect(binding.contexts).toHaveLength(1);
        expect(binding.contexts[0]).toMatchObject({ user: { userId: MEMBER } });
        expect(gatewayCalls[0]?.body).toMatchObject({ modelId: DEFAULT_SPEECH_MODEL, text: "Hello there.", userId: MEMBER, voice: "Calm_Woman" });
        expect(gatewayCalls[0]?.body.providerApiKey).toBeUndefined();

        const rows = await harness.run(async (ctx: any) => [...(await ctx.db.query("messages").take(1)), ...(await ctx.db.query("chatFiles").take(1))]);

        expect(rows).toEqual([]);
    });

    it("charges the daily allowance by the text's length", async () => {
        const before = await remainingChars(MEMBER);

        await speak(MEMBER, "  Twelve chars  ");

        expect(await remainingChars(MEMBER)).toBe(before - "Twelve chars".length);
    });

    it("refuses once the daily allowance cannot cover the text, without calling the gateway", async () => {
        await harness.run(async (ctx: any) => {
            const limiter = createRatelimit("voice/dailySpeechChars:free", ctx.db as never);
            const { remaining } = await limiter.getRemaining(MEMBER);

            await limiter.limit(MEMBER, { count: remaining - 3 });
        });

        await expect(speak(MEMBER, "Too long")).rejects.toThrow(SPEECH_DAILY_LIMIT_MESSAGE);
        expect(gatewayCalls).toHaveLength(0);
    });

    it("exempts platform admins from the daily allowance", async () => {
        const before = await remainingChars(ADMIN);

        await speak(ADMIN, "Hello");

        expect(await remainingChars(ADMIN)).toBe(before);
    });

    it("caps one call's text", async () => {
        await expect(speak(MEMBER, "x".repeat(MAX_SPEECH_CHARS + 1))).rejects.toThrow("too long");
        await expect(speak(MEMBER, " ".repeat(3))).rejects.toThrow("Nothing to speak");
        expect(gatewayCalls).toHaveLength(0);
    });

    it("sends the user's own FAL key for BYOK billing", async () => {
        providerKeys.current = { fal: "user-fal-key", openai: "other" };

        await speak(MEMBER, "Hello");

        expect(gatewayCalls[0]?.body.providerApiKey).toBe("user-fal-key");
    });

    it("surfaces a gateway failure", async () => {
        binding.fetch = async () => Response.json({ error: "boom" }, { status: 502 });

        await expect(speak(MEMBER, "Hello")).rejects.toThrow("Speech gateway error");
    });
});
