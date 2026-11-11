import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** LF-normalised. The path is a variable on purpose: Vite rewrites a literal `new URL("….css", import.meta.url)` into an asset import. */
const readRelative = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replaceAll("\r\n", "\n");

const CSS_PATH = "./native-shell.css";
const COMMENT = /\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g;
const WHITESPACE = /\s+/g;
const LEADING_SPACE = /^\s/;
const SPELLCHECK_ON = /\bspellCheck(?:\s|=\{true\}|\/>)/;

const CSS = readRelative(CSS_PATH).replaceAll(COMMENT, "");

/** The selector of the one rule whose body declares `declaration`. */
const selectorOf = (declaration: string): string => {
    const rules = CSS.split("}")
        .map((rule) => rule.split("{"))
        .filter(([, body]) => body?.includes(declaration));

    expect(rules, declaration).toHaveLength(1);

    return (rules[0]?.[0] ?? "").replaceAll(WHITESPACE, " ").trim();
};

describe("native-shell.css selection rules", () => {
    const chrome = selectorOf("user-select: none");
    const optBack = selectorOf("user-select: text");

    beforeEach(() => {
        document.documentElement.dataset.native = "";
        document.body.innerHTML = `
            <header><button id="header-button">New</button><button class="select-text" id="selectable-button">id-123</button></header>
            <div class="message-text"><p>See <button data-streamdown="link" id="message-link">the docs</button></p></div>
            <div class="prose"><span role="button" id="prose-button">term</span></div>
        `;
    });

    afterEach(() => {
        delete document.documentElement.dataset.native;
        document.body.replaceChildren();
    });

    const byId = (id: string): Element => {
        const element = document.querySelector(`#${id}`);

        expect(element, id).not.toBeNull();

        return element as Element;
    };

    it("keeps chrome buttons unselectable", () => {
        expect(byId("header-button").matches(chrome)).toBe(true);
    });

    it("leaves a link Streamdown renders as a button in a message selectable", () => {
        expect(byId("message-link").matches(chrome)).toBe(false);
        expect(byId("prose-button").matches(chrome)).toBe(false);
    });

    it("lets `select-text` opt a chrome element back in", () => {
        expect(byId("selectable-button").matches(chrome)).toBe(false);
        expect(byId("selectable-button").matches(optBack)).toBe(true);
    });
});

/** Raw `<textarea>`s that are not prose: read-only output. */
const NOT_PROSE = /\breadOnly\b/;

/** Each `<textarea …/>` element in `source`, from its tag to its self-closing `/>` (attributes hold `=>`, so no regex). */
const textareaElements = (source: string): string[] =>
    source
        .split("<textarea")
        .slice(1)
        .filter((rest) => LEADING_SPACE.test(rest))
        .map((rest) => `<textarea${rest.slice(0, rest.indexOf("/>") + 2)}`);

const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.") && !entry.name.includes(".stories."))
        .map((entry) => join(entry.parentPath, entry.name));

describe("prose fields under the shell's spellcheck=false", () => {
    // <html spellcheck="false"> in the shell is inherited, so every raw prose <textarea> opts back in itself
    // (`<Textarea>` from @neore/ui does so by default).
    const roots = ["../..", "../../../../../packages/chat-ui/src"].map((path) => fileURLToPath(new URL(path, import.meta.url)));
    const textareas = roots
        .flatMap((root) => sourceFiles(root))
        .flatMap((file) => {
            const source = readFileSync(file, "utf8");

            return textareaElements(source).map((element) => [file, element] as const);
        });

    it("finds the raw textareas", () => {
        expect(textareas.length).toBeGreaterThanOrEqual(7);
    });

    it.each(textareas.filter(([, element]) => !NOT_PROSE.test(element)).map(([file, element]) => [file.slice(file.indexOf("src")), element]))(
        "%s turns spellcheck back on",
        (_file, element) => {
            expect(element).toMatch(SPELLCHECK_ON);
        },
    );
});
