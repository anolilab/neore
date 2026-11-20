/**
 * Sub-agent roles against the real schema: the settings a dispatch resolves (the user's, a project's overrides), and
 * the role an admitted run keeps on its row.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_REGISTRY, requiresPaidPlan } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { admitSubAgentRun, resolveRunRole } from "./functions";
import { getRoleCatalogForRun } from "./role-settings";
import { isRoleModelAllowed } from "./roles";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let userId: string;

const insertUser = async () =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", { createdAt: 0, email: `u${String(Math.random())}@example.com`, emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;

const insertThread = async (fields: Record<string, unknown> = {}) =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId, ...fields }))) as string;

const setUserRoles = async (subAgentRoles: Record<string, unknown>) =>
    await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { subAgentRoles, userId }));

const insertProject = async (subAgentRoles: Record<string, unknown>) =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("projects", { createdAt: 0, subAgentRoles, title: "P", userId }))) as string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    userId = await insertUser();
});

afterEach(() => {
    harness.close();
});

describe("resolveRunRole", () => {
    it("launches a role with the user's model", async () => {
        await setUserRoles({ review: { instructions: "Check auth.", model: DEFAULT_CHAT_MODEL } });
        const parentThreadId = await insertThread();

        expect(await harness.run(async (ctx: any) => await resolveRunRole(ctx, { parentThreadId, userId }, "review"))).toStrictEqual({
            role: { instructions: "Check auth.", model: DEFAULT_CHAT_MODEL, name: "review" },
        });
    });

    it("refuses a role the user never gave a model", async () => {
        const parentThreadId = await insertThread();

        expect(await harness.run(async (ctx: any) => await resolveRunRole(ctx, { parentThreadId, userId }, "security"))).toStrictEqual({
            error: expect.stringContaining("security role has no model"),
        });
    });

    it("applies the parent thread's project overrides, field by field", async () => {
        await setUserRoles({ review: { instructions: "Check auth.", model: "no-such-model" } });
        const projectId = await insertProject({ review: { model: DEFAULT_CHAT_MODEL, reasoningEffort: 90 } });
        const parentThreadId = await insertThread({ projectId });

        expect(await harness.run(async (ctx: any) => await resolveRunRole(ctx, { parentThreadId, userId }, "review"))).toStrictEqual({
            role: { instructions: "Check auth.", model: DEFAULT_CHAT_MODEL, name: "review", reasoningEffort: 90 },
        });
    });

    it("refuses a paid-plan model for a user without the plan or a key, before anything is charged", async () => {
        const paid = MODEL_REGISTRY.find((model) => requiresPaidPlan(model) && isRoleModelAllowed(model.id));

        expect(paid).toBeDefined();

        await setUserRoles({ review: { model: paid!.id } });
        const parentThreadId = await insertThread();

        expect(await harness.run(async (ctx: any) => await resolveRunRole(ctx, { parentThreadId, userId }, "review"))).toStrictEqual({
            error: expect.stringContaining("needs a Pro plan"),
        });
    });

    it("refuses a model that cannot run sub-agents rather than switching to another", async () => {
        await setUserRoles({ review: { model: "no-such-model" } });
        const parentThreadId = await insertThread();

        expect(await harness.run(async (ctx: any) => await resolveRunRole(ctx, { parentThreadId, userId }, "review"))).toStrictEqual({
            error: expect.stringContaining("(no-such-model) cannot run sub-agents"),
        });
    });
});

describe("resolveRunRole with a custom endpoint", () => {
    const setEndpoints = async (customAIProviders: Record<string, unknown>) =>
        await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { customAIProviders, userId }));

    it.each([
        ["one the user does not have", {}, "not one of your enabled custom endpoints"],
        ["a switched-off one", { mine: { enabled: false, endpoint: "https://llm.example.com", type: "openai" } }, "not one of your enabled custom endpoints"],
        ["one the browser runs", { mine: { enabled: true, endpoint: "http://127.0.0.1:11434", type: "local-browser" } }, "runs in your browser"],
    ])("refuses %s before anything is charged", async (_label, providers, reason) => {
        await setEndpoints(providers);
        await setUserRoles({ review: { model: "custom:mine/llama" } });
        const parentThreadId = await insertThread();

        expect(await harness.run(async (ctx: any) => await resolveRunRole(ctx, { parentThreadId, userId }, "review"))).toStrictEqual({
            error: expect.stringContaining(reason),
        });
    });

    it("launches on the user's own enabled server-side endpoint", async () => {
        await setEndpoints({ mine: { enabled: true, endpoint: "https://llm.example.com", type: "openai" } });
        await setUserRoles({ review: { model: "custom:mine/llama" } });
        const parentThreadId = await insertThread();

        expect(await harness.run(async (ctx: any) => await resolveRunRole(ctx, { parentThreadId, userId }, "review"))).toStrictEqual({
            role: { model: "custom:mine/llama", name: "review" },
        });
    });
});

describe("admitSubAgentRun with a role", () => {
    it("keeps the resolved role on the row", async () => {
        const parentThreadId = await insertThread();
        const role = { model: DEFAULT_CHAT_MODEL, name: "research" as const };
        const result = await harness.run(async (ctx: any) => await admitSubAgentRun(ctx, { parentThreadId, role, task: "Find it", toolCallId: "c1", userId }));

        expect(result).toMatchObject({ row: { role } });
    });
});

describe("getRoleCatalogForRun", () => {
    it("is null until a role has a model, then lists it", async () => {
        const run = async () => await harness.query(async (ctx: any) => await ctx.runQuery(getRoleCatalogForRun, { userId }));

        expect(await run()).toBeNull();

        await setUserRoles({ test: { model: DEFAULT_CHAT_MODEL } });

        expect(await run()).toContain("- test (prefer):");
    });
});
