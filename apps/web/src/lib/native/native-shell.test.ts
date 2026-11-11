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

    describe("with the stylesheet applied", () => {
        // The cascade itself, not just the selectors: a later rule that overrides these would fail here.
        beforeEach(() => {
            const style = document.createElement("style");

            style.textContent = CSS;
            document.head.insertAdjacentElement("beforeend", style);
        });

        afterEach(() => {
            document.head.replaceChildren();
        });

        const userSelect = (id: string): string => getComputedStyle(byId(id)).getPropertyValue("user-select");

        it("computes `none` for chrome and `text` for content and opt-backs", () => {
            expect(userSelect("header-button")).toBe("none");
            expect(userSelect("message-link")).not.toBe("none");
            expect(userSelect("prose-button")).not.toBe("none");
            expect(userSelect("selectable-button")).toBe("text");
        });

        it("computes nothing outside the shell", () => {
            delete document.documentElement.dataset.native;

            expect(userSelect("header-button")).not.toBe("none");
        });
    });
});

describe("native-shell.css cursors", () => {
    // Tailwind's cursor utilities as the app builds them: layered, so any unlayered shell rule that matches beats them.
    const UTILITIES = String.raw`@layer utilities {
        .cursor-pointer { cursor: pointer; }
        .cursor-grab { cursor: grab; }
        .disabled\:cursor-not-allowed:disabled { cursor: not-allowed; }
    }`;

    beforeEach(() => {
        document.documentElement.dataset.native = "";

        const style = document.createElement("style");

        style.textContent = `${UTILITIES}\n${CSS}`;
        document.head.insertAdjacentElement("beforeend", style);
        document.body.innerHTML = `
            <button id="plain">New</button>
            <div class="cursor-pointer" id="pointer">Row</div>
            <button class="cursor-grab active:cursor-grabbing" draggable="true" id="draggable">Agent node</button>
            <button class="cursor-pointer disabled:cursor-not-allowed" disabled id="disabled">Send</button>
            <div aria-disabled="true" class="cursor-pointer" role="menuitem" id="aria-disabled">Delete</div>
            <div data-disabled="" role="option" id="data-disabled">Unavailable</div>
            <textarea disabled id="disabled-field"></textarea>
            <textarea id="field"></textarea>
        `;
    });

    afterEach(() => {
        delete document.documentElement.dataset.native;
        document.head.replaceChildren();
        document.body.replaceChildren();
    });

    const cursor = (id: string): string => getComputedStyle(document.querySelector(`#${id}`) as Element).cursor;

    it("replaces the hand with the arrow", () => {
        expect(cursor("plain")).toBe("default");
        expect(cursor("pointer")).toBe("default");
        expect(cursor("field")).toBe("text");
    });

    it("keeps a drag cursor a control asks for", () => {
        expect(cursor("draggable")).toBe("grab");
    });

    it.each(["disabled", "aria-disabled", "data-disabled", "disabled-field"])("shows not-allowed on a disabled control (%s)", (id) => {
        expect(cursor(id)).toBe("not-allowed");
    });

    it("leaves the utilities alone outside the shell", () => {
        delete document.documentElement.dataset.native;

        expect(cursor("pointer")).toBe("pointer");
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

describe("thread title fields under the shell's spellcheck=false", () => {
    // Titles are prose; the editors are `<InlineEdit>` and `<Input>`, which the textarea scan above does not see.
    it.each(["../../features/chat/header/chat-header.tsx", "../../features/chat/thread-list/rename-thread-dialog.tsx"])(
        "%s turns spellcheck back on",
        (path) => {
            expect(readRelative(path)).toMatch(SPELLCHECK_ON);
        },
    );
});
