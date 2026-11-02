/**
 * The page agent sends the page OWNER's content, so a collaborator's edit must honour both users' model filter rules.
 */
import { DEFAULT_PROMPT_IMPROVEMENT_MODEL } from "@neore/ai/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { proposePageEditHandler } from "./agent";

const generateText = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("@neore/ai/providers", async () => {
    const { MODEL_REGISTRY } = await import("@neore/ai/models");

    return { buildAgents: () => Object.fromEntries(MODEL_REGISTRY.map((model) => [model.id, { chat: { modelId: model.id } }])) };
});
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});

const owner = "owner-1";
const caller = "caller-1";
const rulesByUser: Record<string, object> = {};

const ctx = {
    log: { event: vi.fn() },
    runQuery: vi.fn(async (reference: unknown, args: { userId?: string }) => {
        const name = JSON.stringify(reference) + String(reference);

        if (name.includes("getPageForAgent")) {
            return { content: "# Notes", ownerId: owner, title: "Notes" };
        }

        if (name.includes("getUserRunPlanQuery")) {
            return { isAdmin: false, plan: null };
        }

        return { modelFilterRules: rulesByUser[args.userId ?? ""] ?? {} };
    }),
    user: { userId: caller },
} as never;

beforeEach(() => {
    generateText.mockReset();
    generateText.mockResolvedValue({ text: "# Better notes", usage: { inputTokens: 1, outputTokens: 1 } });

    for (const key of Object.keys(rulesByUser)) {
        delete rulesByUser[key];
    }
});

describe("proposePageEditHandler", () => {
    it("uses the default model when neither user restricts it", async () => {
        await proposePageEditHandler(ctx, { instruction: "tidy", pageId: "page-1" as never });

        expect(generateText.mock.calls[0]![0].model.modelId).toBe(DEFAULT_PROMPT_IMPROVEMENT_MODEL);
    });

    it("does not send the owner's page to a model the owner forbids, though the caller allows it", async () => {
        rulesByUser[owner] = { blockedModels: [DEFAULT_PROMPT_IMPROVEMENT_MODEL] };

        await proposePageEditHandler(ctx, { instruction: "tidy", pageId: "page-1" as never });

        expect(generateText.mock.calls[0]![0].model.modelId).not.toBe(DEFAULT_PROMPT_IMPROVEMENT_MODEL);
    });
});
