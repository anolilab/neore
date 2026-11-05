/**
 * A workflow node on a provider's own SDK never reaches the gateway, so the runner's model filters are checked before
 * the call: a node naming a model they exclude fails instead of running.
 */
import { describe, expect, it, vi } from "vitest";

import { directModelRefusal } from "./executor";

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
