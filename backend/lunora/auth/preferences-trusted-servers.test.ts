/**
 * A saved MCP server that is removed takes its quick-check trust with it, so adding the same name and url again starts untrusted.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mcpTrustId } from "../chat/lib/low-risk-trust";
import { updateAIUserPreferences } from "./functions";
import { schemaWithShardedTables } from "../lib/test-schema";

const USER = "user-trusted-servers";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, userId } : null;
        },
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
        getSessionUserWithAnonymous: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

// `userSettings` is audited; its trigger writes a `.global()` table the harness cannot hold.
vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const URL = "https://files.example/mcp";
const SERVER = { enabled: true, name: "Files", protocol: "http", url: URL };

const asUser = () => harness.withIdentity({ userId: USER } as never);
const saveServers = async (mcpServers: unknown[]) => await asUser().mutation(updateAIUserPreferences as never, { mcpServers } as never);
const trusted = async (): Promise<string[] | undefined> =>
    await harness.run(async (ctx: any) => {
        const row = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q: any) => q.eq("userId", USER))
            .unique();

        return row?.lowRiskTrustedServers;
    });

beforeEach(() => {
    harness = lunoraTest(schemaWithShardedTables([]) as never);
});

afterEach(() => {
    harness.close();
});

describe("trusted servers in the saved MCP server list", () => {
    it("drops the trust of a server that was removed, so adding it again starts untrusted, and keeps a connector's", async () => {
        await saveServers([SERVER]);
        await harness.run(async (ctx: any) => {
            const row = await ctx.db
                .query("aiUserPreferences")
                .withIndex("by_userId", (q: any) => q.eq("userId", USER))
                .unique();

            await ctx.db.patch(row._id, { lowRiskTrustedServers: [mcpTrustId("Files", URL), "connector:notion"] });
        });

        await saveServers([SERVER]);
        expect(await trusted()).toStrictEqual([mcpTrustId("Files", URL), "connector:notion"]);

        await saveServers([]);
        await saveServers([SERVER]);

        expect(await trusted()).toStrictEqual(["connector:notion"]);
    });
});
