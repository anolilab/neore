/**
 * Redeeming a thread invite only ever raises access: a grantee who redeems a
 * weaker link keeps what they have, and one who redeems a stronger link gets it.
 * Lowering access goes through the grant editors.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { acceptThreadInvite, createThreadInvite } from "./sharing";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "chat_sharing", await import("./sharing"));
    registerModule(registry, "agent_sharing", await import("../agent/sharing"));
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
const GRANTEE = "grantee";

let harness: ReturnType<typeof lunoraTest>;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const newThread = async (): Promise<string> =>
    await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

const giveAccess = async (threadId: string, permission: string): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("threadAccess", { grantedAt: Date.now(), grantedBy: OWNER, ownerId: OWNER, permission, threadId, userId: GRANTEE });
    });
};

const permissionOf = async (threadId: string): Promise<string | undefined> =>
    await harness.run(async (ctx: any) => {
        const rows = (await ctx.db.query("threadAccess").collect()) as { permission: string; threadId: string; userId: string }[];

        return rows.find((row) => row.threadId === threadId && row.userId === GRANTEE)?.permission;
    });

const redeem = async (threadId: string, permission: string): Promise<{ permission: string }> => {
    const { inviteToken } = (await as(OWNER).mutation(
        createThreadInvite as never,
        { expirationType: "1_day", invitedEmail: "grantee@example.com", permission, threadId } as never,
    )) as { inviteToken: string };

    return (await as(GRANTEE).mutation(acceptThreadInvite as never, { inviteToken } as never)) as { permission: string };
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("acceptThreadInvite", () => {
    it("keeps a write grant when a read invite is redeemed", async () => {
        const threadId = await newThread();

        await giveAccess(threadId, "write");

        await expect(redeem(threadId, "read")).resolves.toMatchObject({ permission: "write" });
        await expect(permissionOf(threadId)).resolves.toBe("write");
    });

    it("raises a read grant when a write invite is redeemed", async () => {
        const threadId = await newThread();

        await giveAccess(threadId, "read");

        await expect(redeem(threadId, "write")).resolves.toMatchObject({ permission: "write" });
        await expect(permissionOf(threadId)).resolves.toBe("write");
    });

    it("creates the grant when there is none", async () => {
        const threadId = await newThread();

        await expect(redeem(threadId, "read")).resolves.toMatchObject({ permission: "read" });
        await expect(permissionOf(threadId)).resolves.toBe("read");
    });
});
