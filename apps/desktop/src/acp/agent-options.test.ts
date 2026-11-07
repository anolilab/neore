import { describe, expect, it } from "vitest";

import { applyOptionsUpdate, MAX_CHOICES, MAX_OPTIONS, optionsOf } from "./agent-options";
import { acpSchema } from "./testing/harness";

const keep = (text: string): string => text;

const MODE = {
    category: "mode",
    currentValue: "build",
    id: "mode",
    name: "Mode",
    options: [
        { name: "Plan", value: "plan" },
        { name: "Build", value: "build" },
    ],
    type: "select",
};
const MODEL = {
    category: "model",
    currentValue: "fast",
    id: "model",
    name: "Model",
    options: [
        {
            group: "g",
            name: "Group",
            options: [
                { name: "Fast", value: "fast" },
                { name: "Deep", value: "deep" },
            ],
        },
    ],
    type: "select",
};

describe("optionsOf", () => {
    it("reads list options from a session/new answer, groups flattened, and leaves the legacy modes out", () => {
        const answer = { configOptions: [MODE, MODEL], modes: { availableModes: [{ id: "x", name: "X" }], currentModeId: "x" }, sessionId: "s" };

        expect(acpSchema("NewSessionResponse").safeParse(answer).success).toBe(true);
        expect(optionsOf(answer, keep)).toEqual({
            configOptions: [
                {
                    category: "mode",
                    choices: [
                        { name: "Plan", value: "plan" },
                        { name: "Build", value: "build" },
                    ],
                    currentValue: "build",
                    id: "mode",
                    name: "Mode",
                },
                {
                    category: "model",
                    choices: [
                        { name: "Fast", value: "fast" },
                        { name: "Deep", value: "deep" },
                    ],
                    currentValue: "fast",
                    id: "model",
                    name: "Model",
                },
            ],
        });
    });

    it("falls back to the legacy mode list for an agent that sends no options", () => {
        const answer = {
            modes: {
                availableModes: [
                    { id: "ask", name: "Ask" },
                    { id: "code", name: "Code" },
                ],
                currentModeId: "ask",
            },
            sessionId: "s",
        };

        expect(acpSchema("NewSessionResponse").safeParse(answer).success).toBe(true);
        expect(optionsOf(answer, keep)).toEqual({
            modes: {
                available: [
                    { name: "Ask", value: "ask" },
                    { name: "Code", value: "code" },
                ],
                current: "ask",
            },
        });
    });

    it("names an option or choice the agent left unnamed after its id, cut to the length a name may have", () => {
        const id = "m".repeat(128);
        const read = optionsOf({ configOptions: [{ currentValue: id, id, options: [{ value: id }], type: "select" }], sessionId: "s" }, keep);

        expect(read.configOptions?.[0]?.name).toBe("m".repeat(120));
        expect(read.configOptions?.[0]?.choices[0]).toEqual({ name: "m".repeat(120), value: id });
    });

    it("reads nothing from an agent that advertises nothing", () => {
        expect(optionsOf({ sessionId: "s" }, keep)).toEqual({});
        expect(optionsOf(null, keep)).toEqual({});
    });

    it("drops a boolean option, an id the scrub would change, an id over 128 bytes and a duplicate, and caps the lists", () => {
        const choices = Array.from({ length: MAX_CHOICES + 5 }, (_, index) => {
            return { name: `C${String(index)}`, value: `c${String(index)}` };
        });
        const options = [
            { currentValue: true, id: "flag", name: "Flag", type: "boolean" },
            { currentValue: "a", id: "SECRET", name: "Masked", options: [{ name: "A", value: "a" }], type: "select" },
            { currentValue: "a", id: "é".repeat(65), name: "Long", options: [{ name: "A", value: "a" }], type: "select" },
            { currentValue: "c0", id: "big", name: "Big", options: choices, type: "select" },
            { currentValue: "c0", id: "big", name: "Again", options: choices, type: "select" },
            ...Array.from({ length: MAX_OPTIONS + 3 }, (_, index) => {
                return { currentValue: "a", id: `o${String(index)}`, name: "O", options: [{ name: "A", value: "a" }], type: "select" };
            }),
        ];
        const read = optionsOf({ configOptions: options, sessionId: "s" }, (text) => text.replace("SECRET", "***"));

        expect(read.configOptions?.map((option) => option.id)).toEqual(["big", ...Array.from({ length: MAX_OPTIONS - 1 }, (_, index) => `o${String(index)}`)]);
        expect(read.configOptions?.[0]?.choices).toHaveLength(MAX_CHOICES);
    });
});

describe("applyOptionsUpdate", () => {
    const start = optionsOf({ configOptions: [MODE, MODEL], sessionId: "s" }, keep);

    it("replaces the options whole on config_option_update", () => {
        const update = { configOptions: [{ ...MODE, currentValue: "plan" }], sessionUpdate: "config_option_update" };

        expect(acpSchema("SessionUpdate").safeParse(update).success).toBe(true);
        expect(applyOptionsUpdate(start, update, keep)?.configOptions?.map((option) => [option.id, option.currentValue])).toEqual([["mode", "plan"]]);
        // An explicitly empty list clears them; one with nothing usable in it changes nothing.
        expect(applyOptionsUpdate(start, { configOptions: [], sessionUpdate: "config_option_update" }, keep)).toEqual({ configOptions: [] });
        expect(applyOptionsUpdate(start, { configOptions: [{ id: 3 }], sessionUpdate: "config_option_update" }, keep)).toBeUndefined();
    });

    it("moves the mode option and the legacy mode on current_mode_update, only to a mode the agent listed", () => {
        const legacy = optionsOf(
            {
                modes: {
                    availableModes: [
                        { id: "ask", name: "Ask" },
                        { id: "code", name: "Code" },
                    ],
                    currentModeId: "ask",
                },
                sessionId: "s",
            },
            keep,
        );
        const update = { currentModeId: "plan", sessionUpdate: "current_mode_update" };

        expect(acpSchema("SessionUpdate").safeParse(update).success).toBe(true);
        expect(applyOptionsUpdate(start, update, keep)?.configOptions?.[0]?.currentValue).toBe("plan");
        expect(applyOptionsUpdate(legacy, { currentModeId: "code", sessionUpdate: "current_mode_update" }, keep)?.modes?.current).toBe("code");
        expect(applyOptionsUpdate(legacy, { currentModeId: "other", sessionUpdate: "current_mode_update" }, keep)?.modes?.current).toBe("ask");
    });

    it("ignores every other update", () => {
        expect(applyOptionsUpdate(start, { content: { text: "x", type: "text" }, sessionUpdate: "agent_message_chunk" }, keep)).toBeUndefined();
    });
});
