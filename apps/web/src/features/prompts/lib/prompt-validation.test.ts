import type { GatewayModel } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import validatePromptSettings from "./prompt-validation";

const mockModels: GatewayModel[] = [
    {
        filterCapabilities: ["reasoning", "effort_control", "vision"],
        id: "gpt-4",
        name: "GPT-4",
    } as unknown as GatewayModel,
    {
        filterCapabilities: ["fast"],
        id: "gpt-3.5",
        name: "GPT-3.5",
    } as unknown as GatewayModel,
    {
        filterCapabilities: ["reasoning", "effort_control", "vision", "code"],
        id: "claude-3",
        name: "Claude 3",
    } as unknown as GatewayModel,
];

describe("validatePromptSettings", () => {
    describe("no model specified", () => {
        it("should return valid when modelId is undefined", () => {
            const result = validatePromptSettings(undefined, undefined, undefined, mockModels);

            expect(result.isValid).toBe(true);
            expect(result.errors).toEqual({});
        });
    });

    describe("model validation", () => {
        it("should return valid for existing model with no extra settings", () => {
            const result = validatePromptSettings("gpt-4", undefined, undefined, mockModels);

            expect(result.isValid).toBe(true);
        });

        it("should return error for non-existent model", () => {
            const result = validatePromptSettings("non-existent", undefined, undefined, mockModels);

            expect(result.isValid).toBe(false);
            expect(result.errors.model).toContain("no longer available");
        });
    });

    describe("reasoning effort validation", () => {
        it("should accept valid reasoning effort for supporting model", () => {
            const result = validatePromptSettings("gpt-4", 2, undefined, mockModels);

            expect(result.isValid).toBe(true);
        });

        it("should reject reasoning effort for non-supporting model", () => {
            const result = validatePromptSettings("gpt-3.5", 2, undefined, mockModels);

            expect(result.isValid).toBe(false);
            expect(result.errors.reasoningEffort).toContain("does not support reasoning effort");
        });

        it("should accept reasoning effort at maximum for supporting model", () => {
            const result = validatePromptSettings("gpt-4", 4, undefined, mockModels);

            expect(result.isValid).toBe(true);
        });

        it("should accept max reasoning effort for Claude", () => {
            const result = validatePromptSettings("claude-3", 4, undefined, mockModels);

            expect(result.isValid).toBe(true);
        });

        it("should reject negative reasoning effort", () => {
            const result = validatePromptSettings("gpt-4", -1, undefined, mockModels);

            expect(result.isValid).toBe(false);
            expect(result.errors.reasoningEffort).toContain("between 0 and 4");
        });

        it("should reject reasoning effort above 4", () => {
            const result = validatePromptSettings("claude-3", 5, undefined, mockModels);

            expect(result.isValid).toBe(false);
        });
    });

    describe("feature validation", () => {
        it("should accept supported features", () => {
            const result = validatePromptSettings("gpt-4", undefined, ["vision"], mockModels);

            expect(result.isValid).toBe(true);
        });

        it("should reject unsupported features", () => {
            const result = validatePromptSettings("gpt-3.5", undefined, ["vision", "code"], mockModels);

            expect(result.isValid).toBe(false);
            expect(result.errors.enabledFeatures).toHaveLength(2);
        });

        it("should skip reserved features (fast, effort_control, reasoning)", () => {
            const result = validatePromptSettings("gpt-3.5", undefined, ["fast", "effort_control", "reasoning"], mockModels);

            expect(result.isValid).toBe(true);
        });

        it("should accept empty features array", () => {
            const result = validatePromptSettings("gpt-4", undefined, [], mockModels);

            expect(result.isValid).toBe(true);
        });
    });

    describe("combined validation", () => {
        it("should report multiple errors", () => {
            const result = validatePromptSettings("gpt-3.5", 2, ["vision"], mockModels);

            expect(result.isValid).toBe(false);
            expect(result.errors.reasoningEffort).toBeDefined();
            expect(result.errors.enabledFeatures).toBeDefined();
        });
    });
});
