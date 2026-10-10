import { describe, expect, it, vi } from "vitest";

import { GROUP_CHAT_MODES, GROUP_MODE_COPY, groupModeOptionsFor, isGroupChatMode, isStructuredMode } from "./group-mode";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted); the copy is only checked for presence.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

describe("groupModeOptionsFor", () => {
    it("sends no options for the modes that do not read them", () => {
        expect(groupModeOptionsFor("supervisor", ["a", "b"], { debateRounds: 3, synthesizerSkillId: "a" })).toStrictEqual({});
    });

    it("keeps a synthesizer only while it is a participant", () => {
        expect(groupModeOptionsFor("parallel", ["a", "b"], { synthesizerSkillId: "a" })).toStrictEqual({ synthesizerSkillId: "a" });
        // Removing the synthesizer from the group drops it rather than failing the update.
        expect(groupModeOptionsFor("parallel", ["b"], { synthesizerSkillId: "a" })).toStrictEqual({});
    });

    it("always sends the debate rounds, defaulting them", () => {
        expect(groupModeOptionsFor("debate", ["a", "b"], {})).toStrictEqual({ debateRounds: 2 });
        expect(groupModeOptionsFor("debate", ["a", "b", "c"], { debateRounds: 3, synthesizerSkillId: "c" })).toStrictEqual({
            debateRounds: 3,
            synthesizerSkillId: "c",
        });
    });
});

describe("group modes", () => {
    it("has copy for every mode and recognises only known ones", () => {
        for (const mode of GROUP_CHAT_MODES) {
            expect(GROUP_MODE_COPY[mode]).toBeDefined();
            expect(isGroupChatMode(mode)).toBe(true);
        }

        expect(isGroupChatMode("chaos")).toBe(false);
        expect(GROUP_CHAT_MODES.filter((mode) => isStructuredMode(mode))).toStrictEqual(["parallel", "debate"]);
    });
});
