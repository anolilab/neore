/**
 * The public trigger and group create procedures take no plugin marker, so a marker a caller sends never reaches a row.
 * Each call goes through the registered procedure, so a refusal is the procedure's own, not the sign-in's.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import { schemaWithShardedTables } from "../lib/test-schema";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const sessionFrom = vi.hoisted(() => async (context: { auth: { userId?: string | null } }) => {
    const { userId } = context.auth;

    return userId ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, plan: "premium", userId } : null;
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

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

// The route table is `.global()` (D1), which the harness cannot store; routing is not under test here.
vi.mock("../lib/shard-routes", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-routes")>()),
        deleteShardRoute: async () => undefined,
        setShardRoute: async () => undefined,
    };
});

const MODULES = {
    chat_group_functions: async () => await import("../chat/group/functions"),
    triggers_functions: async () => await import("./functions"),
} as const;

beforeAll(async () => {
    for (const [module, load] of Object.entries(MODULES)) {
        const exports = await load();

        for (const [name, value] of Object.entries(exports)) {
            registry.set(`${module}:${name}`, value);
        }
    }
}, 60_000);

const procedureAt = (module: keyof typeof MODULES, name: string): never => {
    const procedure = registry.get(`${module}:${name}`);

    if (!procedure) {
        throw new Error(`public-refusals.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

const OWNER = "owner-a";
const MARKER = "install-1:trigger:daily";

describe("public create procedures take no plugin marker", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "userSkills", "skillHistory", "triggers", "threads"]) as never);
    });

    afterEach(() => {
        harness.close();
    });

    const triggersWithMarker = async () =>
        await harness.run(
            async (context: any) =>
                await context.db
                    .query("triggers")
                    .withIndex("by_plugin_marker", (q: any) => q.eq("pluginMarker", MARKER))
                    .collect(),
        );

    it("a public trigger never stores a marker a caller sends", async () => {
        const outcome = await harness
            .withIdentity({ userId: OWNER } as never)
            .mutation(procedureAt("triggers_functions", "createTrigger"), {
                cronExpression: "0 9 * * *",
                model: "claude-haiku-5-5",
                name: "Daily",
                pluginMarker: MARKER,
                type: "schedule",
            } as never)
            .then(
                () => "stored without the marker",
                () => "refused",
            );

        // Each case states the outcome it expects; the marker check must hold either way.
        expect(outcome).toBe("stored without the marker");
        expect(await triggersWithMarker()).toHaveLength(0);
    });

    it("a public group chat never stores a marker a caller sends", async () => {
        const outcome = await harness
            .withIdentity({ userId: OWNER } as never)
            .mutation(procedureAt("chat_group_functions", "createGroupChat"), {
                mode: "round-robin",
                model: "claude-haiku-5-5",
                pluginMarker: MARKER,
                skillIds: [],
                title: "Panel",
            } as never)
            .then(
                () => "stored without the marker",
                () => "refused",
            );

        // Each case states the outcome it expects; the marker check must hold either way.
        expect(outcome).toBe("refused");
        expect(
            await harness.run(
                async (context: any) =>
                    await context.db
                        .query("threads")
                        .withIndex("by_plugin_marker", (q: any) => q.eq("pluginMarker", MARKER))
                        .collect(),
            ),
        ).toHaveLength(0);
    });
});
