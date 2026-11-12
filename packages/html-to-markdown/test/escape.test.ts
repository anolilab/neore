import { describe, expect, it } from "vitest";

import { escapeMarkdown } from "../src/utilities";

/*
 * The escape chain as it was before the single-pass rewrite. It is the reference:
 * the rewrite must agree with it on every string.
 *
 * Two escapes were added with the `<` and `)` fixes. A `<` is escaped only before a
 * letter, `/`, `!` or `?`, the characters that can open raw HTML or an autolink. An
 * ordered-list delimiter is `.` or `)`, so both are escaped after a number that ends
 * the string or precedes a space, a tab or a line end. A `<` at the end of a text node is escaped by the
 * text rule in turndown.ts, which can see the next node.
 */
function referenceEscape(string: string): string {
    return string
        .replaceAll("\\", "\\\\")
        .replaceAll("*", String.raw`\*`)
        .replaceAll(/^-/g, String.raw`\-`)
        .replaceAll(/^\+ /g, String.raw`\+ `)
        .replaceAll(/^(=+)/g, String.raw`\$1`)
        .replaceAll(/^(#{1,6}) /g, String.raw`\$1 `)
        .replaceAll("`", "\\`")
        .replaceAll(/^~~~/g, String.raw`\~~~`)
        .replaceAll("[", String.raw`\[`)
        .replaceAll("]", String.raw`\]`)
        .replaceAll(/^>/g, String.raw`\>`)
        .replaceAll("_", String.raw`\_`)
        .replaceAll(/<(?=[a-z/!?])/gi, String.raw`\<`)
        .replaceAll(/^(\d+)([.)])(?=[ \t\n]|$)/g, String.raw`$1\$2`);
}

const ALPHABET = ["\\", "*", "`", "[", "]", "_", "-", "+", " ", "=", "#", "~", ">", "1", "9", ".", "a", "(", "\n", "\t", " ", ")", "<", "!", "/"];

// Park-Miller generator: arithmetic only, so the sequence is the same on every run.
const MODULUS = 2_147_483_647;
const MULTIPLIER = 48_271;
const CASES = 5000;
const MAX_LENGTH = 8;

function randomStrings(seed: number): string[] {
    let state = seed;
    const next = (): number => {
        state = (state * MULTIPLIER) % MODULUS;

        return state / MODULUS;
    };

    const strings: string[] = [];

    for (let index = 0; index < CASES; index += 1) {
        const length = Math.floor(next() * (MAX_LENGTH + 1));
        let text = "";

        for (let position = 0; position < length; position += 1) {
            text += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? "";
        }

        strings.push(text);
    }

    return strings;
}

describe("escapeMarkdown", () => {
    it.each([
        "",
        "plain text",
        "-item",
        "+ item",
        "=== title",
        "# heading",
        "####### seven hashes",
        "~~~ fence",
        "> quote",
        "1. item",
        "12. item",
        "a_b *c* `d` [e]",
        String.raw`\*`,
        "- - -",
        "\n-\n",
    ])("matches the reference for %j", (input) => {
        expect(escapeMarkdown(input)).toBe(referenceEscape(input));
    });

    it("matches the reference on random strings built from the characters that matter", () => {
        for (const input of randomStrings(20_261_112)) {
            if (escapeMarkdown(input) !== referenceEscape(input)) {
                expect.fail(`escapeMarkdown(${JSON.stringify(input)}) differs from the reference`);
            }
        }
    });
});
