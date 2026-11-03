import { describe, expect, it } from "vitest";

import { MANAGED_SETTINGS, MAX_ALLOWED_MODELS, MAX_POLICY_CHARS, parseOrganizationPolicy, serializeOrganizationPolicy } from "./organization-policy";

const parse = (document: unknown) => parseOrganizationPolicy(typeof document === "string" ? document : JSON.stringify(document));

const rejected = (document: unknown): string => {
    const result = parse(document);

    if (result.ok) {
        throw new Error("expected the policy to be rejected");
    }

    return result.error;
};

describe("parseOrganizationPolicy", () => {
    it("accepts the smallest policy", () => {
        expect(parse({ schemaVersion: 1 })).toEqual({ ok: true, policy: { schemaVersion: 1 } });
    });

    it("accepts a model lock, setting rules and a permission cap", () => {
        const result = parse({
            models: { allowed: ["model-a", "model-b"] },
            permissionCap: "ask",
            schemaVersion: 1,
            settings: { memoryEnabled: { locked: true, value: false }, threadSummariesEnabled: { locked: false, value: true } },
        });

        expect(result).toEqual({
            ok: true,
            policy: {
                models: { allowed: ["model-a", "model-b"] },
                permissionCap: "ask",
                schemaVersion: 1,
                settings: { memoryEnabled: { locked: true, value: false }, threadSummariesEnabled: { locked: false, value: true } },
            },
        });
    });

    it("accepts every managed setting with its own type", () => {
        const settings = Object.fromEntries(Object.keys(MANAGED_SETTINGS).map((key) => [key, { locked: true, value: true }]));

        expect(parse({ schemaVersion: 1, settings }).ok).toBe(true);
    });

    describe("unknown keys", () => {
        it("rejects an unknown top-level key", () => {
            expect(rejected({ memberLimit: 3, schemaVersion: 1 })).toContain('unknown key "memberLimit"');
        });

        it("rejects an unknown key inside models", () => {
            expect(rejected({ models: { allowed: ["a"], blocked: ["b"] }, schemaVersion: 1 })).toContain('unknown key "blocked"');
        });

        it("rejects an unknown key inside a setting rule", () => {
            expect(rejected({ schemaVersion: 1, settings: { memoryEnabled: { extra: 1, locked: true, value: true } } })).toContain('unknown key "extra"');
        });

        it("rejects an inherited object property name as a top-level key", () => {
            expect(rejected('{"schemaVersion":1,"__proto__":{}}')).toContain("unknown key");
            expect(rejected({ constructor: {}, schemaVersion: 1 })).toContain("unknown key");
        });
    });

    describe("repeated keys", () => {
        it("rejects a repeated key whose last value would hide an unknown rule", () => {
            expect(rejected('{"schemaVersion":1,"models":{"blocked":["x"]},"models":{"allowed":["a"]}}')).toContain("repeats a key");
        });

        it("rejects a repeated key inside a nested object", () => {
            expect(rejected('{"schemaVersion":1,"settings":{"memoryEnabled":{"locked":true,"locked":false,"value":true}}}')).toContain("repeats a key");
        });

        it("rejects a repeated key inside an object held by an array", () => {
            expect(rejected('{"schemaVersion":1,"models":{"allowed":[{"id":"a","id":"b"}]}}')).toContain("repeats a key");
        });

        it("treats an escaped spelling of a key as the same key", () => {
            expect(rejected(String.raw`{"schemaVersion":1,"\u0073chemaVersion":1}`)).toContain("repeats a key");
        });

        it("does not repeat the key back in the error", () => {
            const key = `k${"x".repeat(400)}`;

            expect(rejected(`{"schemaVersion":1,"${key}":1,"${key}":2}`).length).toBeLessThan(120);
        });

        it("accepts the same key in two different objects", () => {
            const result = parse(
                '{"schemaVersion":1,"settings":{"memoryEnabled":{"locked":true,"value":true},"dailyBriefEnabled":{"locked":false,"value":false}}}',
            );

            expect(result.ok).toBe(true);
        });

        it("accepts a document with no repeated key and parses it as before", () => {
            expect(parse('{"schemaVersion":1,"models":{"allowed":["a"]},"permissionCap":"ask"}')).toEqual({
                ok: true,
                policy: { models: { allowed: ["a"] }, permissionCap: "ask", schemaVersion: 1 },
            });
        });

        it("does not mistake a string value that looks like a key for one", () => {
            const result = parse(String.raw`{"schemaVersion":1,"models":{"allowed":["\"schemaVersion\":1","a\",\"allowed\":"]}}`);

            expect(result).toEqual({ ok: true, policy: { models: { allowed: ['"schemaVersion":1', 'a","allowed":'] }, schemaVersion: 1 } });
        });
    });

    describe("schemaVersion", () => {
        it("rejects a missing schemaVersion", () => {
            expect(rejected({})).toContain("schemaVersion is required");
        });

        it("rejects an unknown schemaVersion", () => {
            expect(rejected({ schemaVersion: 2 })).toContain("schemaVersion must be 1");
            expect(rejected({ schemaVersion: 0 })).toContain("schemaVersion must be 1");
        });

        it("rejects a schemaVersion of the wrong type", () => {
            expect(rejected({ schemaVersion: "1" })).toContain("schemaVersion must be 1");
            expect(rejected({ schemaVersion: null })).toContain("schemaVersion must be 1");
        });
    });

    describe("wrong types", () => {
        it.each([["null"], ["[]"], ['"text"'], ["1"], ["not json"], [""]])("rejects %s as the whole document", (text) => {
            expect(parse(text).ok).toBe(false);
        });

        it("rejects models that are not an object, or allowed that is not a list", () => {
            expect(rejected({ models: ["a"], schemaVersion: 1 })).toContain("models must be an object");
            expect(rejected({ models: { allowed: "a" }, schemaVersion: 1 })).toContain("models.allowed must be a list");
            expect(rejected({ models: {}, schemaVersion: 1 })).toContain("models.allowed must be a list");
        });

        it("rejects a model id that is not a plain non-empty string", () => {
            for (const bad of [1, null, "", " padded", "padded ", { id: "a" }, "x".repeat(501)]) {
                expect(parse({ models: { allowed: [bad] }, schemaVersion: 1 }).ok).toBe(false);
            }
        });

        it("rejects an empty or oversized model list and a repeated model", () => {
            expect(rejected({ models: { allowed: [] }, schemaVersion: 1 })).toContain("must not be empty");
            expect(
                rejected({ models: { allowed: Array.from({ length: MAX_ALLOWED_MODELS + 1 }, (_, index) => `m${String(index)}`) }, schemaVersion: 1 }),
            ).toContain("more than");
            expect(rejected({ models: { allowed: ["a", "a"] }, schemaVersion: 1 })).toContain("twice");
        });

        it("rejects a permission cap that is not off, ask or auto", () => {
            for (const bad of ["always", "", 1, null, ["ask"]]) {
                expect(parse({ permissionCap: bad, schemaVersion: 1 }).ok).toBe(false);
            }
        });

        it("rejects settings that are not an object, and a rule that is not an object", () => {
            expect(rejected({ schemaVersion: 1, settings: [] })).toContain("settings must be an object");
            expect(rejected({ schemaVersion: 1, settings: { memoryEnabled: true } })).toContain("settings.memoryEnabled must be an object");
        });

        it("rejects a locked flag or value of the wrong type, or either one missing", () => {
            expect(rejected({ schemaVersion: 1, settings: { memoryEnabled: { locked: "yes", value: true } } })).toContain("locked must be true or false");
            expect(rejected({ schemaVersion: 1, settings: { memoryEnabled: { value: true } } })).toContain("locked must be true or false");
            expect(rejected({ schemaVersion: 1, settings: { memoryEnabled: { locked: true, value: "on" } } })).toContain("value must be a boolean");
            expect(rejected({ schemaVersion: 1, settings: { memoryEnabled: { locked: true } } })).toContain("value must be a boolean");
        });
    });

    describe("settings that are not managed", () => {
        it("rejects a lock on an unknown key", () => {
            expect(rejected({ schemaVersion: 1, settings: { selectedModel: { locked: true, value: true } } })).toContain("is not a managed setting");
        });

        it("rejects a default on an unknown key as well", () => {
            expect(rejected({ schemaVersion: 1, settings: { notASetting: { locked: false, value: false } } })).toContain("is not a managed setting");
        });

        it("does not treat inherited object properties as managed keys", () => {
            for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
                expect(rejected(`{"schemaVersion":1,"settings":{"${key}":{"locked":true,"value":true}}}`)).toContain("is not a managed setting");
            }
        });
    });

    describe("size", () => {
        it("rejects a document above the size cap before parsing it", () => {
            expect(rejected(" ".repeat(MAX_POLICY_CHARS + 1))).toContain("larger than");
        });

        it("does not repeat a long key back in the error", () => {
            expect(rejected({ [`k${"x".repeat(400)}`]: 1, schemaVersion: 1 }).length).toBeLessThan(120);
        });
    });
});

describe("serializeOrganizationPolicy", () => {
    it("writes equal policies as equal text, whatever the input key order", () => {
        const first = parse(
            '{"permissionCap":"off","schemaVersion":1,"settings":{"threadSummariesEnabled":{"value":true,"locked":true},"memoryEnabled":{"value":false,"locked":false}},"models":{"allowed":["a"]}}',
        );
        const second = parse({
            models: { allowed: ["a"] },
            permissionCap: "off",
            schemaVersion: 1,
            settings: { memoryEnabled: { locked: false, value: false }, threadSummariesEnabled: { locked: true, value: true } },
        });

        if (!first.ok || !second.ok) {
            throw new Error("both policies are valid");
        }

        expect(serializeOrganizationPolicy(first.policy)).toBe(serializeOrganizationPolicy(second.policy));
    });

    it("round-trips through the parser", () => {
        const first = parse({ models: { allowed: ["a", "b"] }, permissionCap: "auto", schemaVersion: 1 });

        if (!first.ok) {
            throw new Error("valid policy");
        }

        expect(parse(serializeOrganizationPolicy(first.policy))).toEqual(first);
    });
});
