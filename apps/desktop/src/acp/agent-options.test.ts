import { describe, expect, it } from "vitest";

import { configOptionsOf, isOffered, MAX_CHOICES, MAX_OPTIONS, optionsOf, resolveOptions, withCurrentMode, withOptionValue } from "./agent-options";

const plain = (text: string): string => text;

const select = (id: string, extra: Record<string, unknown> = {}) => {
    return {
        category: "model",
        currentValue: "a",
        id,
        name: id.toUpperCase(),
        options: [
            { name: "A", value: "a" },
            { name: "B", value: "b" },
        ],
        type: "select",
        ...extra,
    };
};

describe("configOptionsOf", () => {
    it("ignores a nonempty list that holds no usable option, and clears the choices only for an empty list", () => {
        expect(configOptionsOf([null, 3, { id: "x", type: "boolean" }], plain)).toBeUndefined();
        expect(configOptionsOf([], plain)).toEqual([]);
    });

    it("reads a list option with its category, current value and choices", () => {
        expect(configOptionsOf([select("m")], plain)).toEqual([
            {
                category: "model",
                choices: [
                    { name: "A", value: "a" },
                    { name: "B", value: "b" },
                ],
                currentValue: "a",
                id: "m",
                name: "M",
            },
        ]);
    });

    it("flattens grouped choices into one list", () => {
        const grouped = select("m", {
            options: [
                { group: "g1", name: "G1", options: [{ name: "A", value: "a" }] },
                { group: "g2", name: "G2", options: [{ name: "B", value: "b" }] },
            ],
        });

        expect(configOptionsOf([grouped], plain)?.[0]?.choices).toEqual([
            { name: "A", value: "a" },
            { name: "B", value: "b" },
        ]);
    });

    it("leaves out a boolean option and one without a usable id or value", () => {
        expect(
            configOptionsOf([select("b", { currentValue: true, type: "boolean" }), select("", {}), select("x", { currentValue: "" }), "junk", null], plain),
        ).toBeUndefined();
    });

    it("keeps at most 20 options and 100 choices, and one of each id", () => {
        const many = Array.from({ length: 30 }, (_unused, index) => select(`o${String(index)}`));
        const longChoices = Array.from({ length: 150 }, (_unused, index) => {
            return { name: "C", value: `c${String(index)}` };
        });
        const long = select("l", { options: longChoices });

        expect(configOptionsOf(many, plain)).toHaveLength(MAX_OPTIONS);
        expect(configOptionsOf([long], plain)?.[0]?.choices).toHaveLength(MAX_CHOICES);
        expect(configOptionsOf([select("m"), select("m")], plain)).toHaveLength(1);
        expect(
            configOptionsOf(
                [
                    select("m", {
                        options: [
                            { name: "A", value: "a" },
                            { name: "A2", value: "a" },
                        ],
                    }),
                ],
                plain,
            )?.[0]?.choices,
        ).toHaveLength(1);
    });

    it("keeps an id of up to 128 UTF-8 bytes, and drops one the computer would refuse", () => {
        // 64 two-byte characters are 128 bytes: kept. 65 are 130 bytes, which the computer refuses after the change is sent.
        const offered = (id: string) => configOptionsOf([select(id)], plain);

        expect(offered("é".repeat(64))).toHaveLength(1);
        expect(offered("é".repeat(65))).toBeUndefined();
    });

    it("cuts the options by bytes as well as by count, so the post stays under the ingest cap", () => {
        // A name is cut at 200 characters, which is 400 bytes here: 20 options of 100 such choices would be far over the cap.
        const wide = Array.from({ length: 20 }, (_unused, index) =>
            select(`w${String(index)}`, {
                options: Array.from({ length: 100 }, (_inner, choice) => {
                    return { name: "é".repeat(200), value: `w${String(index)}-${String(choice)}-${"x".repeat(100)}` };
                }),
            }));
        const options = configOptionsOf(wide, plain) ?? [];

        expect(new TextEncoder().encode(JSON.stringify(options)).length).toBeLessThanOrEqual(64 * 1024);
        expect(options[0]?.choices.length).toBeGreaterThan(0);
    });

    it("cuts a legacy mode or model list by bytes too", () => {
        const modes = {
            availableModes: Array.from({ length: 100 }, (_unused, index) => {
                return { id: `m${String(index)}`, name: "é".repeat(200) };
            }),
            currentModeId: "m0",
        };
        const report = optionsOf({ modes }, plain);

        expect(new TextEncoder().encode(JSON.stringify(report.modes)).length).toBeLessThanOrEqual(32 * 1024);
        expect(report.modes?.available.length).toBeGreaterThan(0);
    });

    it("scrubs every text, cuts names, and drops an id the scrub would change", () => {
        const scrub = (text: string) => text.replaceAll("SECRET", "");
        const [option]
            = configOptionsOf(
                [
                    select("m", {
                        name: `aSECRETb${"n".repeat(300)}`,
                        options: [
                            { name: "x SECRET", value: "v" },
                            { name: "y", value: "SECRET-v" },
                        ],
                    }),
                ],
                scrub,
            ) ?? [];

        expect(option?.name).toHaveLength(200);
        expect(option?.name.startsWith("ab")).toBe(true);
        expect(option?.choices).toEqual([{ name: "x ", value: "v" }]);
        expect(configOptionsOf([select("SECRET-id")], scrub)).toBeUndefined();
        const tooLong = select("m", { id: "x".repeat(129) });

        expect(configOptionsOf([tooLong], plain)).toBeUndefined();
    });

    it("is undefined for anything that is not a list", () => {
        expect(configOptionsOf(undefined, plain)).toBeUndefined();
        expect(configOptionsOf({}, plain)).toBeUndefined();
    });
});

describe("optionsOf", () => {
    it("reads the options and the legacy mode and model states of an answer", () => {
        const raw = optionsOf(
            {
                configOptions: [select("m")],
                models: { availableModels: [{ modelId: "m1", name: "M1" }], currentModelId: "m1" },
                modes: { availableModes: [{ id: "ask", name: "Ask" }], currentModeId: "ask" },
                sessionId: "s",
            },
            plain,
        );

        expect(raw.configOptions).toHaveLength(1);
        expect(raw.modes).toEqual({ available: [{ id: "ask", name: "Ask" }], current: "ask" });
        expect(raw.models).toEqual({ available: [{ id: "m1", name: "M1" }], current: "m1" });
    });

    it("reads nothing from an answer with none of them, or a malformed one", () => {
        expect(optionsOf({ sessionId: "s" }, plain)).toEqual({});
        expect(optionsOf(null, plain)).toEqual({});
        expect(optionsOf({ models: { currentModelId: "" }, modes: { availableModes: "x", currentModeId: "ask" } }, plain)).toEqual({});
    });
});

describe("resolveOptions", () => {
    const raw = optionsOf({ configOptions: [select("m")], modes: { availableModes: [{ id: "ask", name: "Ask" }], currentModeId: "ask" } }, plain);

    it("takes the options over the legacy states", () => {
        expect(Object.keys(resolveOptions(raw))).toEqual(["configOptions"]);
    });

    it("uses the legacy states when the agent sent no options, or an empty list", () => {
        expect(Object.keys(resolveOptions({ modes: raw.modes }))).toEqual(["modes"]);
        // An empty list is sent too, so the options stored before are replaced.
        expect(Object.keys(resolveOptions({ configOptions: [], modes: raw.modes }))).toEqual(["configOptions", "modes"]);
        expect(resolveOptions({ configOptions: [] })).toEqual({ configOptions: [] });
        expect(resolveOptions({})).toEqual({});
    });
});

describe("a change the agent reports", () => {
    const raw = optionsOf(
        {
            configOptions: [
                select("mode", {
                    category: "mode",
                    options: [
                        { name: "Ask", value: "ask" },
                        { name: "Code", value: "code" },
                    ],
                }),
            ],
            modes: {
                availableModes: [
                    { id: "ask", name: "Ask" },
                    { id: "code", name: "Code" },
                ],
                currentModeId: "ask",
            },
        },
        plain,
    );

    it("moves the legacy mode and the mode option with a current_mode_update", () => {
        const next = withCurrentMode(raw, "code", plain);

        expect(next.modes?.current).toBe("code");
        expect(next.configOptions?.[0]?.currentValue).toBe("code");
    });

    it("ignores a current mode that is not an id, and leaves a mode option that lacks the choice", () => {
        expect(withCurrentMode(raw, 3, plain)).toBe(raw);
        expect(withCurrentMode(raw, "other", plain).configOptions?.[0]?.currentValue).toBe("a");
    });

    it("replaces the value of one option", () => {
        expect(withOptionValue(raw, "mode", "code").configOptions?.[0]?.currentValue).toBe("code");
    });
});

describe("isOffered", () => {
    const raw = optionsOf({ configOptions: [select("m")] }, plain);
    const legacy = optionsOf({ modes: { availableModes: [{ id: "ask", name: "Ask" }], currentModeId: "ask" } }, plain);

    it("accepts a choice of an option, and nothing else", () => {
        expect(isOffered(raw, "m", "b")).toBe(true);
        expect(isOffered(raw, "m", "z")).toBe(false);
        expect(isOffered(raw, "other", "a")).toBe(false);
    });

    it("accepts a legacy mode only when the agent sent no options", () => {
        expect(isOffered(legacy, undefined, "ask")).toBe(true);
        expect(isOffered(legacy, undefined, "code")).toBe(false);
        expect(isOffered({ ...legacy, ...raw }, undefined, "ask")).toBe(false);
    });
});
