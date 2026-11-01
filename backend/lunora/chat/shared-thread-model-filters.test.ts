/**
 * A summary or follow-ups job can be started by someone the thread is shared with, but the messages it sends to a
 * model are the OWNER's: the owner's model filter rules pick the model, not the collaborator's.
 */
import type { ModelFilterRules } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
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
vi.mock("./lib/model-filter-rules", () => {
    return { loadModelFilterRules: async (_ctx: unknown, userId: string) => state.rules[userId] ?? {} };
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

    it("passes the owner's rules on, not the caller's", async () => {
        state.rules = { [COLLABORATOR]: { requireZDR: false }, [OWNER]: { requireZDR: true } };

        // The follow-ups job swallows its own errors; the summary rejects with the stubbed agent's.
        await run().catch((error: unknown) => expect(String(error)).toContain(REACHED));

        expect(getAgent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ modelFilterRules: { requireZDR: true } }));
    });
});
