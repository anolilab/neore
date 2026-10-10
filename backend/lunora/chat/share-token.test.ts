/**
 * `/chat/<id>` of someone else's PUBLIC thread sends a signed-in viewer to its
 * share page. The thread lives on its owner's shard, not the viewer's, so the
 * token comes from `getThreadShareToken`, which follows the `thread-share`
 * route that `toggleThreadVisibility` keeps (docs/plans/per-user-sharding.md).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { getThreadShareToken, toggleThreadVisibility } from "./sharing";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "chat_sharing", await import("./sharing"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "lib_shard_routes", await import("../lib/shard-routes"));
});

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? {
                      activeOrganization: null,
                      email: `${context.auth.userId}@example.com`,
                      id: context.auth.userId,
                      isAdmin: false,
                      name: context.auth.userId,
                      userId: context.auth.userId,
                  }
                : null,
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

const OWNER = "owner";
const STRANGER = "stranger";

let harness: ReturnType<typeof lunoraTest>;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const newThread = async (): Promise<string> =>
    await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

const setPublic = async (threadId: string, isPublic: boolean): Promise<string | undefined> => {
    const result = (await as(OWNER).mutation(toggleThreadVisibility as never, { isPublic, threadId } as never)) as { publicAccessToken?: string };

    return result.publicAccessToken;
};

const tokenFor = async (userId: string, threadId: string): Promise<unknown> => await as(userId).action(getThreadShareToken as never, { threadId } as never);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("getThreadShareToken", () => {
    it("hands a stranger the share token of a public thread", async () => {
        const threadId = await newThread();
        const token = await setPublic(threadId, true);

        expect(token).toEqual(expect.any(String));
        await expect(tokenFor(STRANGER, threadId)).resolves.toBe(token);
    });

    it("answers null once the thread is private again", async () => {
        const threadId = await newThread();

        await setPublic(threadId, true);
        await setPublic(threadId, false);

        await expect(tokenFor(STRANGER, threadId)).resolves.toBeNull();
    });

    it("answers null for a thread that was never public, and to its owner", async () => {
        const threadId = await newThread();

        await expect(tokenFor(STRANGER, threadId)).resolves.toBeNull();

        await setPublic(threadId, true);

        await expect(tokenFor(OWNER, threadId)).resolves.toBeNull();
    });

    it("answers null for a public thread that was deleted", async () => {
        const threadId = await newThread();

        await setPublic(threadId, true);
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { deleted: true }));

        await expect(tokenFor(STRANGER, threadId)).resolves.toBeNull();
    });
});
