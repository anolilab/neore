/**
 * A workflow node on a provider's own SDK never reaches the gateway, so the runner's model filters are checked before
 * the call: a node naming a model they exclude fails instead of running.
 */
import { describe, expect, it, vi } from "vitest";

import { AI_NODE_DEFAULT_MODEL, directModelRefusal, workflowModelRefusals } from "./executor";

const withRules = (modelFilterRules: Record<string, unknown>) =>
    ({
        runQuery: vi.fn(async () => {
            return { modelFilterRules };
        }),
    }) as never;

describe(directModelRefusal, () => {
    it("refuses a model the rules exclude", async () => {
        await expect(directModelRefusal(withRules({ blockedModels: ["openai/gpt-5"] }), "user-1", "openai/gpt-5")).resolves.toContain(
            "Your model settings exclude this node's model.",
        );
        await expect(directModelRefusal(withRules({ blockedRegions: ["US"] }), "user-1", "openai/gpt-5")).resolves.toBeDefined();
    });

    it("allows a model the rules allow, and a user with no rules", async () => {
        await expect(directModelRefusal(withRules({ blockedModels: ["openai/o3"] }), "user-1", "openai/gpt-5")).resolves.toBeUndefined();
        await expect(directModelRefusal(withRules({}), "user-1", "openai/gpt-5")).resolves.toBeUndefined();
    });

    it("fails closed when the rules cannot be read", async () => {
        const unreadable = {
            runQuery: vi.fn(async () => {
                return { readFailed: true };
            }),
        } as never;

        await expect(directModelRefusal(unreadable, "user-1", "openai/gpt-5")).rejects.toThrow();
    });
});

describe(workflowModelRefusals, () => {
    const aiNode = (model?: string) => ({ data: model === undefined ? {} : { model }, id: model ?? "default", type: "ai" }) as never;
    const imageNode = { data: { model: "fal-ai/flux-2-pro" }, id: "image", type: "image" } as never;

    it("refuses a run before any node when an AI node's model is excluded, once per model", async () => {
        const refusals = await workflowModelRefusals(withRules({ blockedRegions: ["US"] }), "user-1", [
            imageNode,
            aiNode("cf-kimi-k2.5"),
            aiNode("cf-kimi-k2.5"),
        ]);

        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toContain("Your model settings exclude this node's model.");
    });

    it("leaves a model the registry does not know to the node itself", async () => {
        await expect(workflowModelRefusals(withRules({ blockedModels: [AI_NODE_DEFAULT_MODEL] }), "user-1", [aiNode()])).resolves.toStrictEqual([]);
    });

    it("passes a graph whose models the rules allow, and one with no AI node without reading the rules", async () => {
        const noRead = { runQuery: vi.fn() } as never;

        await expect(workflowModelRefusals(withRules({ blockedModels: ["openai/o3"] }), "user-1", [aiNode("openai/gpt-5")])).resolves.toStrictEqual([]);
        await expect(workflowModelRefusals(noRead, "user-1", [imageNode])).resolves.toStrictEqual([]);
    });

    it("refuses the run when the rules cannot be read", async () => {
        const unreadable = {
            runQuery: vi.fn(async () => {
                return { readFailed: true };
            }),
        } as never;

        await expect(workflowModelRefusals(unreadable, "user-1", [aiNode("openai/gpt-5")])).resolves.toStrictEqual([
            "Your model settings could not be read; try again.",
        ]);
    });
});
