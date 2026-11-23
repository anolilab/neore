import { GOAL_DEFAULT_ROUNDS } from "@neore/backend/chat/goals";
import { beforeEach, describe, expect, it } from "vitest";

import { goalForMessage, useGoalComposer } from "./goal-store";

const pinned = { maxRounds: 10, text: "Ship the report" };

beforeEach(() => {
    useGoalComposer.getState().setEnabled(false);
    useGoalComposer.getState().setMaxRounds(GOAL_DEFAULT_ROUNDS);
});

describe("goalForMessage", () => {
    it("carries no goal when nothing is armed and the chat has no pin", () => {
        expect(goalForMessage("Fix the tests")).toBeUndefined();
    });

    it("makes the message a goal with the composer's rounds when a goal is armed", () => {
        useGoalComposer.getState().setEnabled(true);
        useGoalComposer.getState().setMaxRounds(3);

        expect(goalForMessage("  Fix the tests  ")).toEqual({ maxRounds: 3, text: "Fix the tests" });
    });

    it("applies the chat's pin to a message with no goal armed", () => {
        expect(goalForMessage("Continue", pinned)).toEqual({ maxRounds: 10, text: "Ship the report" });
    });

    it("lets a goal armed for one message override the pin", () => {
        useGoalComposer.getState().setEnabled(true);
        useGoalComposer.getState().setMaxRounds(3);

        expect(goalForMessage("Something else", pinned)).toEqual({ maxRounds: 3, text: "Something else" });
    });

    it("carries no goal for blank text, pinned or armed", () => {
        useGoalComposer.getState().setEnabled(true);

        expect(goalForMessage(" ".repeat(3), pinned)).toBeUndefined();
        expect(goalForMessage("")).toBeUndefined();
    });

    it("treats a chat with no pin as unpinned", () => {
        expect(goalForMessage("Continue", null)).toBeUndefined();
    });
});
