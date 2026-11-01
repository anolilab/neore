/**
 * `createTitleChat` / `createCategoryChat` send the user's first prompt to a model. That model follows the user's
 * model filter rules: the rules reach `getAgent`, an excluded default gives way to the next allowed model, and a
 * user whose rules allow none keeps the default title and no category (the job ends quietly, nothing is sent).
 */
import { DEFAULT_TITLE_GENERATION_MODEL } from "@neore/ai/constants";
import type { ModelFilterRules } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { UTILITY_FALLBACK_MODELS } from "../lib/utility-model";
import { createCategoryChat, createTitleChat } from "./functions";

const registry = vi.hoisted(() => new Map<string, unknown>());
const state = vi.hoisted(() => {
    return { rules: {} as ModelFilterRules };
});
const getAgent = vi.hoisted(() => vi.fn());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("./lib/get-agent", () => {
    return { default: getAgent };
});
vi.mock("./lib/model-filter-rules", () => {
    return { loadModelFilterRules: async () => state.rules };
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
        async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, status: "active", title: "New Chat", updatedAt: 1, userId: "user-1" }),
    );
});

afterEach(() => {
    harness.close();
});

const runTitle = async () => await harness.action(async (context: any) => await context.runAction(createTitleChat, { prompt: "hi", threadId }));
const runCategory = async () => await harness.action(async (context: any) => await context.runAction(createCategoryChat, { prompt: "hi", threadId }));

describe.each([
    ["createTitleChat", runTitle],
    ["createCategoryChat", runCategory],
])("%s under the user's model filter rules", (_name, run) => {
    it("uses the default model, and passes the rules on, when the rules allow it", async () => {
        state.rules = { requireZDR: true };

        await expect(run()).rejects.toThrow(REACHED);

        expect(getAgent).toHaveBeenCalledWith(DEFAULT_TITLE_GENERATION_MODEL, expect.objectContaining({ modelFilterRules: { requireZDR: true } }));
    });

    it("uses the next allowed model when the rules exclude the default", async () => {
        state.rules = { blockedModels: [DEFAULT_TITLE_GENERATION_MODEL] };

        await expect(run()).rejects.toThrow(REACHED);

        expect(getAgent).toHaveBeenCalledWith(UTILITY_FALLBACK_MODELS[0], expect.anything());
    });

    it("ends quietly, without reaching any model, when the rules allow none", async () => {
        state.rules = { allowedModels: ["some/other-model"] };

        await expect(run()).resolves.toBeUndefined();

        expect(getAgent).not.toHaveBeenCalled();
    });
});
