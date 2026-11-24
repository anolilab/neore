import { describe, expect, it } from "vitest";

import { endedOnStepCap } from "./cap-wrap-up";

describe("endedOnStepCap", () => {
    it("is true when the cap's last step was a tool step", () => {
        expect(endedOnStepCap({ finishReason: "tool-calls", maxSteps: 5, stepsRun: 5 })).toBe(true);
    });

    it("is false when the reply answered in text on its last step, even at the cap", () => {
        expect(endedOnStepCap({ finishReason: "stop", maxSteps: 5, stepsRun: 5 })).toBe(false);
    });

    it("is false before the cap: a tool step that ended the loop for another reason", () => {
        expect(endedOnStepCap({ finishReason: "tool-calls", maxSteps: 5, stepsRun: 3 })).toBe(false);
    });

    it("is false when the finish reason is unknown", () => {
        expect(endedOnStepCap({ finishReason: undefined, maxSteps: 5, stepsRun: 5 })).toBe(false);
    });
});
