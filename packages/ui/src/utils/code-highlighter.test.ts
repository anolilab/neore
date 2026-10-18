import { describe, expect, it } from "vitest";

import { code } from "./code-highlighter";

const run = (source: string, language: string, themes: [string, string] = ["github-light", "github-dark"], isIncomplete = false) =>
    code.highlight({ code: source, isIncomplete, language, themes });

describe("code highlighter plugin", () => {
    it("emits Streamdown's dual-theme shape: the light colour on the token, the dark one in --shiki-dark", () => {
        const result = run("const a = 1;", "ts");
        const keyword = result?.tokens[0]?.find((token) => token.content === "const");

        expect(keyword?.color).toBe("#cf222e");
        expect(keyword?.htmlStyle?.["--shiki-dark"]).toBe("#ff7b72");
        expect(result?.bg).toBe("#ffffff");
        expect(result?.rootStyle).toBe("--shiki-dark:#c9d1d9;--shiki-dark-bg:#0d1117");
    });

    it("takes each slot's colours from the theme named for it, so the Appearance pairs keep their meaning", () => {
        const result = run("const a = 1;", "ts", ["catppuccin-latte", "catppuccin-mocha"]);
        const keyword = result?.tokens[0]?.find((token) => token.content === "const");

        expect(keyword?.color).toBe("#8839ef");
        expect(keyword?.htmlStyle?.["--shiki-dark"]).toBe("#cba6f7");
        expect(result?.bg).toBe("#eff1f5");
    });

    it("falls back to GitHub, by kind, for a theme name it does not know", () => {
        const result = run("const a = 1;", "ts", ["no-such-theme", "nor-this"]);

        expect(result?.bg).toBe("#ffffff");
        expect(result?.rootStyle).toContain("--shiki-dark-bg:#0d1117");
    });

    it("splits a token that spans lines, such as a template string, into lines", () => {
        const result = run("const s = `one\ntwo\nthree`;", "ts");

        expect(result?.tokens).toHaveLength(3);
        expect(result?.tokens.map((line) => line.map((token) => token.content).join(""))).toStrictEqual(["const s = `one", "two", "three`;"]);
    });

    it("keeps a trailing empty line, as Shiki does", () => {
        expect(run("a\n", "ts")?.tokens).toHaveLength(2);
        expect(run("a\n", "ts")?.tokens[1]).toStrictEqual([]);
    });

    it.each([
        ["py", true],
        ["sh", true],
        ["bash", true],
        ["zsh", true],
        ["console", true],
        ["yml", true],
        ["md", true],
        ["c", true],
        ["h", true],
        ["cs", true],
        ["kt", true],
        ["rb", true],
        ["jsonc", true],
        ["Dockerfile", true],
        ["text", true],
        ["xml", true],
        ["mjs", true],
        ["ini", true],
    ])("understands the alias %s", (language, supported) => {
        expect(code.supportsLanguage(language)).toBe(supported);
        expect(run("x", language)).not.toBeNull();
    });

    it.each(["r", "scala", "haskell", "elixir", "powershell", "graphql", "latex", "hcl", "zig", "julia", "objective-c", ""])(
        "leaves %s to Streamdown's plain rendering",
        (language) => {
            expect(code.supportsLanguage(language)).toBe(false);
            expect(run("x", language)).toBeNull();
        },
    );

    it("highlights C with the C++ grammar", () => {
        const keyword = run("int main(void) { return 0; }", "c")?.tokens[0]?.find((token) => token.content === "return");

        expect(keyword?.color).toBe("#cf222e");
    });

    it("returns the same object for a finished block and a fresh one while it is still streaming", () => {
        expect(run("let finished = 1;", "ts")).toBe(run("let finished = 1;", "ts"));
        expect(run("let streaming = 1;", "ts", undefined, true)).not.toBe(run("let streaming = 1;", "ts", undefined, true));
    });

    it("re-tokenizes a long streaming block fast enough to do it on every chunk", () => {
        const block = Array.from(
            { length: 2000 },
            (_, index) => `export const value${index}: Record<string, number> = { a: ${index}, b: "text ${index}" }; // comment`,
        ).join("\n");
        const start = performance.now();

        run(block, "ts", undefined, true);

        // A budget, not a benchmark: it takes ~50 ms on a laptop, and a starved 2-core runner has taken over 5 s,
        // so the ceiling only has to catch a quadratic regression (minutes at this size), not a slow machine.
        expect(performance.now() - start).toBeLessThan(15_000);
    });
});
