/**
 * The switch summary carries the thread owner's history, so a collaborator's switch must honour BOTH users'
 * model filter rules, not only the caller's.
 */
import { DEFAULT_MEMORY_EXTRACTION_MODEL } from "@neore/ai/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { summariseWith } from "./agent-switch";
import { MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE } from "./lib/model-filter-rules";

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

const rulesByUser: Record<string, object> = {};
const owner = "owner-1";
const caller = "caller-1";

const ctx = {
    runQuery: vi.fn(async (reference: unknown, args: { userId?: string }) => {
        const name = JSON.stringify(reference) + String(reference);

        if (name.includes("getThreadInternal")) {
            return { userId: owner };
        }

        if (name.includes("getUserRunPlanQuery")) {
            return { isAdmin: false, plan: null };
        }

        return { modelFilterRules: rulesByUser[args.userId ?? ""] ?? {} };
    }),
} as never;

const older = [{ role: "user", text: "hello" }] as never;

beforeEach(() => {
    generateText.mockReset();
    generateText.mockResolvedValue({ text: "A summary." });

    for (const key of Object.keys(rulesByUser)) {
        delete rulesByUser[key];
    }
});

describe("summariseWith", () => {
    it("uses the default utility model when neither user restricts it", async () => {
        await summariseWith(ctx, { threadId: "thread-1", userId: caller })(older, false);

        expect(generateText.mock.calls[0]![0].model.modelId).toBe(DEFAULT_MEMORY_EXTRACTION_MODEL);
    });

    it("does not summarise the owner's history on a model the owner forbids, though the caller allows it", async () => {
        rulesByUser[owner] = { blockedModels: [DEFAULT_MEMORY_EXTRACTION_MODEL] };

        await summariseWith(ctx, { threadId: "thread-1", userId: caller })(older, false);

        expect(generateText).toHaveBeenCalledOnce();
        expect(generateText.mock.calls[0]![0].model.modelId).not.toBe(DEFAULT_MEMORY_EXTRACTION_MODEL);
    });

    it("answers a readable BAD_REQUEST, not an internal error, when the rules allow no model", async () => {
        rulesByUser[caller] = { allowedModels: ["some/other-model"] };

        await expect(summariseWith(ctx, { threadId: "thread-1", userId: caller })(older, false)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(generateText).not.toHaveBeenCalled();
    });

    it("answers a readable BAD_REQUEST when the settings could not be read", async () => {
        const failing = {
            runQuery: vi.fn(async (reference: unknown) => {
                if (String(reference).includes("getThreadInternal") || JSON.stringify(reference).includes("getThreadInternal")) {
                    return { userId: owner };
                }

                return { readFailed: true };
            }),
        } as never;

        await expect(summariseWith(failing, { threadId: "thread-1", userId: caller })(older, false)).rejects.toMatchObject({
            code: "BAD_REQUEST",
            message: MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE,
        });
    });
});
