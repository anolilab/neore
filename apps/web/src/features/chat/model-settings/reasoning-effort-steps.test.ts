import { describe, expect, it } from "vitest";

import { EFFORT_STOPS, stepReasoningEffort, supportsReasoningEffort } from "./reasoning-effort-steps";

describe("stepReasoningEffort", () => {
    it("offers the slider's five stops", () => {
        expect(EFFORT_STOPS).toStrictEqual([0, 25, 50, 75, 100]);
    });

    it("steps up one stop at a time", () => {
        expect(stepReasoningEffort(0, "increase")).toBe(25);
        expect(stepReasoningEffort(25, "increase")).toBe(50);
        expect(stepReasoningEffort(50, "increase")).toBe(75);
        expect(stepReasoningEffort(75, "increase")).toBe(100);
    });

    it("steps down one stop at a time", () => {
        expect(stepReasoningEffort(100, "decrease")).toBe(75);
        expect(stepReasoningEffort(75, "decrease")).toBe(50);
        expect(stepReasoningEffort(50, "decrease")).toBe(25);
        expect(stepReasoningEffort(25, "decrease")).toBe(0);
    });

    it("clamps at the top and the bottom instead of wrapping", () => {
        expect(stepReasoningEffort(100, "increase")).toBe(100);
        expect(stepReasoningEffort(0, "decrease")).toBe(0);
    });

    it("starts from the selector's default of Medium when nothing is set", () => {
        expect(stepReasoningEffort(undefined, "increase")).toBe(75);
        expect(stepReasoningEffort(undefined, "decrease")).toBe(25);
    });

    it("moves a value between two stops to the stop on the requested side", () => {
        expect(stepReasoningEffort(60, "increase")).toBe(75);
        expect(stepReasoningEffort(60, "decrease")).toBe(50);
        expect(stepReasoningEffort(130, "increase")).toBe(100);
        expect(stepReasoningEffort(-5, "decrease")).toBe(0);
    });
});

describe("supportsReasoningEffort", () => {
    const models = [
        { filterCapabilities: ["reasoning"], id: "reasons" },
        { filterCapabilities: ["effort_control"], id: "effort-only" },
        { filterCapabilities: ["text"], id: "plain" },
        { id: "no-capabilities" },
    ];

    it("accepts both capabilities the backend takes an effort for", () => {
        expect(supportsReasoningEffort(models, "reasons")).toBe(true);
        expect(supportsReasoningEffort(models, "effort-only")).toBe(true);
    });

    it("refuses a model without either, an unknown model and no model", () => {
        expect(supportsReasoningEffort(models, "plain")).toBe(false);
        expect(supportsReasoningEffort(models, "no-capabilities")).toBe(false);
        expect(supportsReasoningEffort(models, "missing")).toBe(false);
        expect(supportsReasoningEffort(models, undefined)).toBe(false);
    });
});
