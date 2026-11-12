import { describe, expect, it } from "vitest";

import { edgeWhitespace } from "../src/node";

// Upstream's regular expression, kept as the reference for the linear scan in node.ts.
// It is only ever run on strings of at most 12 characters.
// eslint-disable-next-line regexp/no-super-linear-backtracking, sonarjs/super-linear-regex -- the reference oracle, on short strings
const UPSTREAM_EDGES = /^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*?)([ \t\r\n]*))$/;

const ALPHABET = [" ", "\t", "\r", "\n", " ", "\u{2028}", "a", "b", "　"];

function reference(string: string) {
    const m = UPSTREAM_EDGES.exec(string) ?? [];

    return {
        leading: m[1] ?? "",
        leadingAscii: m[2] ?? "",
        leadingNonAscii: m[3] ?? "",
        trailing: m[4] ?? "",
        trailingAscii: m[6] ?? "",
        trailingNonAscii: m[5] ?? "",
    };
}

describe("edgeWhitespace matches upstream's regular expression", () => {
    it("on seeded random strings of up to 12 characters", () => {
        // A small linear congruential generator keeps the strings reproducible.
        let state = 7;

        const next = () => {
            state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

            return state / 2_147_483_648;
        };

        for (let index = 0; index < 3000; index += 1) {
            const length = Math.floor(next() * 13);
            let string = "";

            for (let position = 0; position < length; position += 1) {
                string += ALPHABET[Math.floor(next() * ALPHABET.length)];
            }

            expect(edgeWhitespace(string), JSON.stringify(string)).toEqual(reference(string));
        }
    });
});
