/**
 * Scoped API key creation: what is validated before better-auth mints the key,
 * and what the creation state reports.
 *
 * `createScopedApiKey` runs its handler against a hand-built action context
 * with a fake better-auth `createApiKey`, so no key is minted anywhere. The
 * creation-state query runs on the real in-memory harness.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";

const createApiKey = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => {
    return { current: undefined as unknown };
});

vi.mock("../auth", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../auth")>()), getAuth: () => ({ api: { createApiKey } }) };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const fake = async () => session.current;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: fake,
        getSessionUserForQuery: fake,
        getSessionUserForQueryLite: fake,
        getSessionUserWithAnonymous: fake,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

const { ALLOWED_EXPIRY_DAYS, MAX_API_KEYS_PER_USER, createScopedApiKey, getApiKeyCreationState } = await import("./api-keys");

const USER = "user-1";

interface State {
    existingKeys: number;
    isAnonymous: boolean;
}

describe("createScopedApiKey", () => {
    let state: State;
    let identity: unknown;

    const context = () => {
        return {
            auth: { getIdentity: async () => identity, userId: USER },
            db: {},
            log: { event: vi.fn() },
            runQuery: vi.fn(async () => state),
        };
    };

    type Args = { expiresInDays?: number | null; name: string; scopes: string[] };

    const create = async (args: Args) =>
        await (createScopedApiKey as unknown as { handler: (ctx: object, args: object) => Promise<unknown> }).handler(context(), args);

    beforeEach(() => {
        state = { existingKeys: 0, isAnonymous: false };
        identity = null;
        session.current = { activeOrganization: null, email: "u@example.com", id: USER, isAdmin: false, name: "U", userId: USER };
        createApiKey.mockReset();
        createApiKey.mockResolvedValue({ expiresAt: null, id: "key_1", key: "neore_secret", name: "CI", start: "neore_" });
    });

    it("stores the scopes on the key, as the plugin's resource to actions map", async () => {
        const result = await create({ name: "CI", scopes: ["threads:read", "chat:write", "threads:write"] });

        expect(createApiKey).toHaveBeenCalledExactlyOnceWith({
            body: { name: "CI", permissions: { chat: ["write"], threads: ["read", "write"] }, userId: USER },
        });
        expect(result).toStrictEqual({
            expiresAt: null,
            id: "key_1",
            key: "neore_secret",
            name: "CI",
            scopes: ["chat:write", "threads:read", "threads:write"],
            start: "neore_",
        });
    });

    it("keeps write apart from read: a write-only key gets no read", async () => {
        await create({ name: "CI", scopes: ["threads:write"] });

        expect(createApiKey.mock.calls[0]?.[0].body.permissions).toStrictEqual({ threads: ["write"] });
    });

    it.each([
        ["an unknown resource", ["billing:read"]],
        ["an unknown action", ["threads:delete"]],
        ["a missing action", ["threads"]],
        ["an extra segment", ["threads:read:extra"]],
    ])("refuses %s, and one bad entry refuses the lot rather than narrowing the key", async (_, scopes) => {
        await expect(create({ name: "CI", scopes })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(create({ name: "CI", scopes: ["threads:read", ...scopes] })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        expect(createApiKey).not.toHaveBeenCalled();
    });

    it("refuses a key with no scope at all", async () => {
        await expect(create({ name: "CI", scopes: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        expect(createApiKey).not.toHaveBeenCalled();
    });

    it.each(["", "   ", "x".repeat(33)])("refuses the name %j", async (name) => {
        await expect(create({ name, scopes: ["threads:read"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        expect(createApiKey).not.toHaveBeenCalled();
    });

    it("trims the name", async () => {
        await create({ name: "  CI  ", scopes: ["threads:read"] });

        expect(createApiKey.mock.calls[0]?.[0].body.name).toBe("CI");
    });

    it.each(ALLOWED_EXPIRY_DAYS)("converts a %i-day expiry to seconds", async (days) => {
        createApiKey.mockResolvedValue({ expiresAt: new Date(2_000_000_000_000), id: "key_1", key: "k", name: "CI", start: null });

        const result = (await create({ expiresInDays: days, name: "CI", scopes: ["threads:read"] })) as { expiresAt: number };

        expect(createApiKey.mock.calls[0]?.[0].body.expiresIn).toBe(days * 86_400);
        expect(result.expiresAt).toBe(2_000_000_000_000);
    });

    it("sends no expiry for a key that never expires", async () => {
        await create({ expiresInDays: null, name: "CI", scopes: ["threads:read"] });

        expect(createApiKey.mock.calls[0]?.[0].body).not.toHaveProperty("expiresIn");
    });

    it.each([0, 1, 31, 400, -7])("refuses the expiry of %i days", async (days) => {
        await expect(create({ expiresInDays: days, name: "CI", scopes: ["threads:read"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        expect(createApiKey).not.toHaveBeenCalled();
    });

    it("refuses a guest account", async () => {
        state = { existingKeys: 0, isAnonymous: true };

        await expect(create({ name: "CI", scopes: ["threads:read"] })).rejects.toMatchObject({ code: "FORBIDDEN" });

        expect(createApiKey).not.toHaveBeenCalled();
    });

    it("refuses a key minted by an API key", async () => {
        identity = { apiKeyId: "key_0", apiKeyScopes: { threads: ["read"] }, authMethod: "api_key" };

        await expect(create({ name: "CI", scopes: ["threads:read"] })).rejects.toMatchObject({ code: "FORBIDDEN" });

        expect(createApiKey).not.toHaveBeenCalled();
    });

    it("allows the last free slot and refuses the one after", async () => {
        state = { existingKeys: MAX_API_KEYS_PER_USER - 1, isAnonymous: false };

        await expect(create({ name: "CI", scopes: ["threads:read"] })).resolves.toBeDefined();

        state = { existingKeys: MAX_API_KEYS_PER_USER, isAnonymous: false };

        await expect(create({ name: "CI", scopes: ["threads:read"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(createApiKey).toHaveBeenCalledOnce();
    });
});

describe("getApiKeyCreationState", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const stateOf = async (seed: (ctx: any) => Promise<string>): Promise<State> =>
        (await harness.run(async (ctx: any) => {
            const userId = await seed(ctx);

            return await ctx.runQuery(getApiKeyCreationState, { userId });
        })) as State;

    const insertUser = async (ctx: any, overrides: object = {}): Promise<string> =>
        await ctx.db.insert("user", { createdAt: 1, email: `${Math.random()}@example.com`, emailVerified: true, name: "U", updatedAt: 1, ...overrides });

    const insertKeys = async (ctx: any, referenceId: string, count: number): Promise<void> => {
        for (let index = 0; index < count; index += 1) {
            await ctx.db.insert("apikey", { configId: "default", createdAt: 1, key: `${referenceId}-${String(index)}`, referenceId, updatedAt: 1 });
        }
    };

    it("counts only the caller's keys", async () => {
        const result = await stateOf(async (ctx) => {
            const me = await insertUser(ctx);
            const other = await insertUser(ctx);

            await insertKeys(ctx, me, 2);
            await insertKeys(ctx, other, 5);

            return me;
        });

        expect(result).toStrictEqual({ existingKeys: 2, isAnonymous: false });
    });

    it("reports a guest account", async () => {
        const result = await stateOf(async (ctx) => await insertUser(ctx, { isAnonymous: true }));

        expect(result).toStrictEqual({ existingKeys: 0, isAnonymous: true });
    });

    it("stops counting one past the limit, which is all the limit check needs", async () => {
        const result = await stateOf(async (ctx) => {
            const me = await insertUser(ctx);

            await insertKeys(ctx, me, MAX_API_KEYS_PER_USER + 5);

            return me;
        });

        expect(result.existingKeys).toBe(MAX_API_KEYS_PER_USER + 1);
    });

    it("reports a limit-reaching count at exactly the limit", async () => {
        const result = await stateOf(async (ctx) => {
            const me = await insertUser(ctx);

            await insertKeys(ctx, me, MAX_API_KEYS_PER_USER);

            return me;
        });

        expect(result.existingKeys).toBe(MAX_API_KEYS_PER_USER);
    });
});
