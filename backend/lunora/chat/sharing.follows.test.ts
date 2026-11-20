/**
 * A member removed from a shared thread loses their follow row with their grant, including a row they wrote while the
 * grant was being removed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lunoraTest } from "@lunora/testing";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { internalMutation } from "../_generated/server";
import schema from "../schema";
import { removeThreadAccess } from "./sharing";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

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
const MEMBER = "member";
const GRANT_DELETE_KEY = "agent_sharing:deleteThreadAccess";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const followRowsOf = async (userId: string): Promise<unknown[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.threadFollows.findMany({ where: { threadId, userId } });

        return page;
    });

const grantsOf = async (userId: string): Promise<unknown[]> =>
    await harness.run(async (ctx: any) =>
        ((await ctx.db.query("threadAccess").collect()) as { threadId: string; userId: string }[]).filter(
            (row) => row.threadId === threadId && row.userId === userId,
        ),
    );

const remove = async () => await as(OWNER).mutation(removeThreadAccess as never, { targetUserId: MEMBER, threadId } as never);

beforeAll(async () => {
    registerModule(registry, "chat_sharing", await import("./sharing"));
    registerModule(registry, "agent_sharing", await import("../agent/sharing"));
    registerModule(registry, "chat_follows_functions", await import("./follows/functions"));
});

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

    await harness.run(async (ctx: any) => {
        await ctx.db.insert("threadAccess", { grantedAt: 1, grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: MEMBER });
        await ctx.db.insert("threadFollows", { createdAt: 1, state: "on", threadId, updatedAt: 1, userId: MEMBER });
    });
});

afterEach(async () => {
    const { deleteThreadAccess } = await import("../agent/sharing");

    registry.set(GRANT_DELETE_KEY, deleteThreadAccess);
    harness.close();
});

describe("sharing and follow rows", () => {
    it("removes the member's follow row with their grant", async () => {
        await remove();

        expect(await grantsOf(MEMBER)).toHaveLength(0);
        expect(await followRowsOf(MEMBER)).toHaveLength(0);
    });

    it("deletes a follow row the member wrote while the grant was being removed", async () => {
        registry.set(
            GRANT_DELETE_KEY,
            internalMutation
                .input({ accessId: v.id("threadAccess") })
                .output(v.null())
                .mutation(async ({ args, ctx }) => {
                    // The member's own change, landing between the first cleanup and the grant's delete.
                    await ctx.db.insert("threadFollows", { createdAt: 2, state: "muted", threadId: threadId as never, updatedAt: 2, userId: MEMBER });
                    await ctx.db.delete("threadAccess", args.accessId);

                    return null;
                }),
        );

        await remove();

        expect(await followRowsOf(MEMBER)).toHaveLength(0);
    });
});

describe("the order of writes that commit separately", () => {
    // The harness runs a nested mutation inside its caller's transaction, so a failure there rolls back both writes and
    // cannot show what production keeps. The order is read from source instead, by procedure name only.
    const source = readFileSync(join(import.meta.dirname, "sharing.ts"), "utf8");

    it("writes the sharer's follow default before the invite, so a failed follow write leaves no invite to block a retry", () => {
        expect(source.indexOf("ensureThreadFollowDefault(")).toBeLessThan(source.indexOf("internal.agent.sharing.createThreadInvite"));
    });

    it("deletes a removed member's follow row before their grant, so a failed cleanup keeps the grant for a retry", () => {
        expect(source.indexOf("deleteFollowRowOfRemovedMember")).toBeLessThan(source.indexOf("internal.agent.sharing.deleteThreadAccess"));
    });
});
