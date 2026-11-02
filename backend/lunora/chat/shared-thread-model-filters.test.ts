/**
 * A summary or follow-ups job can be started by someone the thread is shared with, but the messages it sends to a
 * model are the OWNER's: the owner's model filter rules pick the model, not the collaborator's. The follow-ups prompt
 * also carries the caller's own profile, so there both users' rules apply.
 */
import type { ModelFilterRules } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { withPaidPlanGrant } from "../lib/utility-model";
import { createSummarizeChat, generateFollowupSuggestionsForThread } from "./functions";

const OWNER = "owner-user";
const COLLABORATOR = "collaborator-user";

const registry = vi.hoisted(() => new Map<string, unknown>());
const state = vi.hoisted(() => {
    return { rules: {} as Record<string, ModelFilterRules> };
});
const getAgent = vi.hoisted(() => vi.fn());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("./lib/get-agent", () => {
    return { default: getAgent };
});
vi.mock("./lib/model-filter-rules", async (importOriginal) => {
    const original = await importOriginal<typeof import("./lib/model-filter-rules")>();
    const load = async (_ctx: unknown, userId: string) => state.rules[userId] ?? {};

    return {
        ...original,
        loadModelFilterRules: load,
        loadSharedModelFilterRules: async (ctx: unknown, callerId: string, ownerId: string | undefined) =>
            ownerId && ownerId !== callerId ? original.mergeModelFilterRules(await load(ctx, callerId), await load(ctx, ownerId)) : await load(ctx, callerId),
    };
});
vi.mock("../lib/services", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/services")>()), gatewayFetch: () => async () => new Response("{}") };
});

const REACHED = "getAgent reached";

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "auth_functions", await import("../auth/functions"));
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    state.rules = {};
    getAgent.mockReset();
    getAgent.mockRejectedValue(new Error(REACHED));
    threadId = await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, status: "active", title: "T", updatedAt: 1, userId: OWNER }),
    );
});

afterEach(() => {
    harness.close();
});

const summarize = async () => await harness.action(async (context: any) => await context.runAction(createSummarizeChat, { threadId, userId: COLLABORATOR }));
const followups = async () =>
    await harness.action(async (context: any) => await context.runAction(generateFollowupSuggestionsForThread, { threadId, userId: COLLABORATOR }));

describe.each([
    ["createSummarizeChat", summarize],
    ["generateFollowupSuggestionsForThread", followups],
])("%s on a thread the caller does not own", (_name, run) => {
    it("sends nothing to a model when the owner's rules allow none, though the caller's would", async () => {
        state.rules = { [COLLABORATOR]: {}, [OWNER]: { allowedModels: ["some/other-model"] } };

        await run();

        expect(getAgent).not.toHaveBeenCalled();
    });

    it("passes the owner's rules on", async () => {
        state.rules = { [COLLABORATOR]: {}, [OWNER]: { requireZDR: true } };

        // The follow-ups job swallows its own errors; the summary rejects with the stubbed agent's.
        await run().catch((error: unknown) => expect(String(error)).toContain(REACHED));

        expect(getAgent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ modelFilterRules: { requireZDR: true } }));
    });

    it("leaves the platform's own default model unmetered, as it always was", async () => {
        state.rules = { [COLLABORATOR]: {}, [OWNER]: {} };

        await run().catch((error: unknown) => expect(String(error)).toContain(REACHED));

        expect(getAgent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ userId: undefined }));
    });

    it("meters a paid fallback to the caller whose plan authorized it", async () => {
        const paid = "anthropic/claude-haiku-4.5";

        state.rules = { [COLLABORATOR]: withPaidPlanGrant({ allowedModels: [paid] }, true), [OWNER]: withPaidPlanGrant({ allowedModels: [paid] }, true) };

        await run().catch((error: unknown) => expect(String(error)).toContain(REACHED));

        expect(getAgent).toHaveBeenCalledWith(paid, expect.objectContaining({ userId: COLLABORATOR }));
    });
});

describe("generateFollowupSuggestionsForThread, whose prompt carries the caller's profile", () => {
    it("sends nothing to a model the caller forbids, though the owner would allow it", async () => {
        state.rules = { [COLLABORATOR]: { allowedModels: ["some/other-model"] }, [OWNER]: {} };

        await followups();

        expect(getAgent).not.toHaveBeenCalled();
    });

    it("applies both users' rules to the one model", async () => {
        state.rules = { [COLLABORATOR]: { requireZDR: true }, [OWNER]: { denyDataCollection: true } };

        await followups().catch(() => undefined);

        expect(getAgent).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ modelFilterRules: { denyDataCollection: true, requireZDR: true } }),
        );
    });
});

describe("createSummarizeChat, which never shows the caller's profile", () => {
    it("is not narrowed by the caller's rules", async () => {
        state.rules = { [COLLABORATOR]: { allowedModels: ["some/other-model"] }, [OWNER]: {} };

        await summarize().catch((error: unknown) => expect(String(error)).toContain(REACHED));

        expect(getAgent).toHaveBeenCalled();
    });
});
