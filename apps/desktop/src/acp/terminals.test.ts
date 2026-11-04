import { describe, expect, it } from "vitest";

import { createRequestOf, shellQuote, shownLine, terminalLine } from "./terminals";

describe(shellQuote, () => {
    it("leaves a plain word bare and quotes anything the shell would read differently", () => {
        expect(shellQuote("src/a.ts")).toBe("src/a.ts");
        expect(shellQuote("two words")).toBe("'two words'");
        expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
        expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`);
        expect(shellQuote("")).toBe("''");
    });
});

describe("the line a terminal runs", () => {
    it("keeps the command as sent and quotes each argument after it", () => {
        expect(terminalLine("npm run", ["test", "--", "a b"])).toBe("npm run test -- 'a b'");
    });

    it("shows the variables the agent sets in front of it", () => {
        expect(shownLine("make", [["CI", "1"], ["MSG", "a b"]])).toBe("CI=1 MSG='a b' make");
    });
});

describe(createRequestOf, () => {
    it("reads a request whole", () => {
        expect(createRequestOf({ args: ["x"], command: " ls ", cwd: "/work", env: [{ name: "A", value: "1" }], outputByteLimit: 500 })).toEqual({
            cwd: "/work",
            env: [["A", "1"]],
            line: "ls x",
            outputByteLimit: 500,
            shown: "A=1 ls x",
        });
    });

    it("refuses what it cannot run as asked", () => {
        for (const params of [
            {},
            { command: "  " },
            { args: [1], command: "ls" },
            { command: "ls", cwd: "relative" },
            { command: "ls", env: [{ name: "1BAD", value: "x" }] },
            { command: "ls", env: [{ name: "A", value: "a\0b" }] },
            { command: "x".repeat(4001) },
            // The line fits, but not with the variables in front of it: the person must read whole what they allow.
            { command: "ls", env: Array.from({ length: 10 }, (_, index) => { return { name: `V${String(index)}`, value: "v".repeat(400) }; }) },
        ]) {
            expect(() => createRequestOf(params)).toThrow();
        }
    });

    it("ignores an output limit that is not a positive whole number", () => {
        expect(createRequestOf({ command: "ls", outputByteLimit: -1 })).not.toHaveProperty("outputByteLimit");
    });
});
