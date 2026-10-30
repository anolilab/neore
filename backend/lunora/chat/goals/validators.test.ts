import { describe, expect, it } from "vitest";

import { MAX_LENGTH, validate } from "../../lib/validators";
import { vGoalRunConfig } from "./validators";

const names = (count: number): string[] => Array.from({ length: count }, (_, index) => `name-${String(index)}`);

describe("vGoalRunConfig", () => {
    const ok = { enabledFeatures: ["a"], mcpServerNames: ["notes"], model: "gpt", reasoningEffort: 50, searchMode: "chat" };

    it("accepts what a real run sends", () => {
        expect(validate(vGoalRunConfig, ok)).toBe(true);
        expect(validate(vGoalRunConfig, { ...ok, origin: "outside_agent", skill: { rawArgs: "", slug: "summarize" } })).toBe(true);
    });

    it.each([
        ["a model id", { model: "m".repeat(MAX_LENGTH.short + 1) }],
        ["a system prompt", { customSystemPrompt: "p".repeat(MAX_LENGTH.text + 1) }],
        ["a search mode", { searchMode: "s".repeat(MAX_LENGTH.short + 1) }],
        ["a feature name", { enabledFeatures: ["f".repeat(MAX_LENGTH.short + 1)] }],
        ["an MCP server name", { mcpServerNames: ["n".repeat(MAX_LENGTH.short + 1)] }],
        ["a long list of features", { enabledFeatures: names(101) }],
        ["a long list of servers", { mcpServerNames: names(101) }],
        ["a reasoning effort above the scale", { reasoningEffort: 101 }],
        ["a negative reasoning effort", { reasoningEffort: -1 }],
        ["a reasoning effort that is not a number", { reasoningEffort: NaN }],
        ["a skill slug", { skill: { rawArgs: "", slug: "s".repeat(MAX_LENGTH.short + 1) } }],
        ["skill arguments", { skill: { rawArgs: "a".repeat(MAX_LENGTH.text + 1), slug: "x" } }],
        ["an origin the API does not produce", { origin: "lead" }],
    ])("refuses %s", (_name, patch) => {
        expect(validate(vGoalRunConfig, { ...ok, ...patch })).toBe(false);
    });
});
