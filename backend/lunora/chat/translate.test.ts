/**
 * `translateMessage` is a model call on client-supplied text, so: guests are
 * refused, each cache MISS is charged to the daily text quota (a hit is free),
 * and the output budget follows the text's length.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { createRatelimit } from "../lib/rate-limiter";
import schema from "../schema";
import { MAX_TRANSLATION_OUTPUT_TOKENS, translationOutputTokens } from "./lib/translate-message";
import { TRANSLATE_GUEST_MESSAGE, translateMessage } from "./translate";

const { generateText, registry, sessionFrom, users } = vi.hoisted(() => {
    return {
        generateText: vi.fn(),
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, plan: null, role: null, userId: context.auth.userId }
                : null,
        users: new Map<string, { isAnonymous?: boolean }>(),
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});

vi.mock("../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return {};
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

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const translate = async (userId: string, text: string): Promise<{ cached: boolean; translation: string }> =>
    (await harness.withIdentity({ userId } as never).action(translateMessage as never, { messageId: "m1", targetLanguage: "de", text } as never)) as {
        cached: boolean;
        translation: string;
    };

const remainingText = async (userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { remaining } = await createRatelimit("chat/dailyText:free", ctx.db as never).getRemaining(userId);

        return remaining;
    });

beforeAll(async () => {
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));
    registerModule(registry, "lib_action_cache", await import("../lib/action-cache"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    users.set(MEMBER, {});
    users.set(GUEST, { isAnonymous: true });
    generateText.mockResolvedValue({ text: "Hallo Welt" });
});

afterEach(() => {
    harness.close();
    users.clear();
    generateText.mockReset();
});

describe("translateMessage", () => {
    it("refuses a guest before any model call", async () => {
        await expect(translate(GUEST, "Hello world")).rejects.toThrow(TRANSLATE_GUEST_MESSAGE);
        expect(generateText).not.toHaveBeenCalled();
    });

    it("charges the daily text quota on a miss, and not on a cache hit", async () => {
        const before = await remainingText(MEMBER);

        await expect(translate(MEMBER, "Hello world")).resolves.toMatchObject({ cached: false, translation: "Hallo Welt" });
        expect(await remainingText(MEMBER)).toBe(before - 1);

        await expect(translate(MEMBER, "Hello world")).resolves.toMatchObject({ cached: true });
        expect(await remainingText(MEMBER)).toBe(before - 1);
        expect(generateText).toHaveBeenCalledOnce();
    });

    it("sizes the output budget to the text, not the 8,000-token maximum", async () => {
        await translate(MEMBER, "Hello world");

        expect(generateText.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: translationOutputTokens("Hello world") });
    });
});

describe("translationOutputTokens", () => {
    it("scales with the text and stays within its floor and cap", () => {
        expect(translationOutputTokens("Hi")).toBe(256);
        expect(translationOutputTokens("x".repeat(4000))).toBe(2000);
        expect(translationOutputTokens("x".repeat(20_000))).toBe(MAX_TRANSLATION_OUTPUT_TOKENS);
    });
});
