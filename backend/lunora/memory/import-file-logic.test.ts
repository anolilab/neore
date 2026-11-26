import { describe, expect, it } from "vitest";

import { REDACTED } from "../lib/secret-redaction";
import { importDedupKey } from "./import-logic";
import {
    MEMORY_FILE_BATCH_SIZE,
    MEMORY_FILE_DEFAULT_TYPE,
    MEMORY_FILE_ENTRY_MAX_CHARS,
    MEMORY_FILE_MAX_BYTES,
    MEMORY_FILE_MAX_ENTRIES,
    type MemoryFileError,
    parseMemoryFile,
    toBatches,
} from "./import-file-logic";

/** Assembled at runtime so the file holds no literal that reads as a real credential. */
const KEY = ["sk", "-", "Zq8LmV2xR7tYw4KpN3bC9dF6"].join("");

/** A fact of exactly `length` characters made of words, which no secret rule reads as a key. */
const factOfLength = (length: number): string =>
    "The user likes tea. "
        .repeat(Math.ceil(length / 20))
        .slice(0, length)
        .trimEnd()
        .padEnd(length, "x");

const fact = (index: number): string => `The user likes pattern number ${String(index)} a lot`;
const lines = (count: number): string => Array.from({ length: count }, (_, index) => fact(index)).join("\n");

const refusal = (content: string, format: "json" | "text"): MemoryFileError | undefined => {
    try {
        parseMemoryFile(content, format);
    } catch (error) {
        return error as MemoryFileError;
    }

    return undefined;
};

describe("parseMemoryFile: text", () => {
    it("keeps one memory per non-empty line, without bullets, numbers or blank lines", () => {
        const parsed = parseMemoryFile("- The user is a nurse in Hamburg\n\n2. The user likes green tea\r\n\r\n* The user owns a bike\n", "text");

        expect(parsed.batches.flat()).toStrictEqual([
            { memory: "The user is a nurse in Hamburg", type: MEMORY_FILE_DEFAULT_TYPE },
            { memory: "The user likes green tea", type: MEMORY_FILE_DEFAULT_TYPE },
            { memory: "The user owns a bike", type: MEMORY_FILE_DEFAULT_TYPE },
        ]);
        expect(parsed).toMatchObject({ duplicates: 0, entries: 3, invalid: 0, tooLong: 0, total: 3 });
    });

    it("treats a blank-line-separated paragraph as separate lines, not one memory", () => {
        const parsed = parseMemoryFile("The user is a nurse in Hamburg\nand works nights on a ward\n\nThe user likes green tea", "text");

        expect(parsed.entries).toBe(3);
    });

    it("ignores a leading byte order mark", () => {
        expect(parseMemoryFile("\u{FEFF}The user is a nurse in Hamburg", "text").batches.flat()[0]?.memory).toBe("The user is a nurse in Hamburg");
    });

    it("counts a short line and a secret as invalid, and keeps the rest", () => {
        const parsed = parseMemoryFile(`Too short\nMy key is ${KEY}\nThe user is a nurse in Hamburg`, "text");

        expect(parsed).toMatchObject({ entries: 1, invalid: 2, total: 3 });
    });

    it.each([
        ["U+2028", "\u{2028}"],
        ["U+2029", "\u{2029}"],
        ["a bare CR", "\r"],
        ["a form feed", "\f"],
    ])("redacts a quoted secret split on %s, and keeps no part of it", (_name, separator) => {
        // The second line reads as an ordinary fact; only the redaction before the split keeps it out.
        const continuation = "the user keeps this tail of the secret";
        const parsed = parseMemoryFile(`The user lives in Lisbon\nDB_PASSWORD="alpha${separator}${continuation}"\nThe user likes green tea`, "text");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon", "The user likes green tea"]);
    });

    it("keeps no line of a quoted secret that runs past 1000 characters", () => {
        const value = "abcdefghij\n".repeat(150).trimEnd();
        const parsed = parseMemoryFile(`The user lives in Lisbon\nDB_PASSWORD="${value}"\nThe user likes green tea`, "text");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon", "The user likes green tea"]);
    });

    it("keeps no line after a quoted secret that runs past 4000 characters without closing", () => {
        const value = "abcdefghij\n".repeat(500);
        const parsed = parseMemoryFile(`The user lives in Lisbon\nDB_PASSWORD="${value}The user likes green tea`, "text");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon"]);
    });

    it("refuses a file with only blank lines", () => {
        expect(refusal("\n  \n\t\n", "text")).toMatchObject({ code: "empty" });
        expect(refusal("", "text")).toMatchObject({ code: "empty" });
    });
});

describe("parseMemoryFile: JSON", () => {
    it("reads an array of strings", () => {
        const parsed = parseMemoryFile(JSON.stringify(["The user is a nurse in Hamburg", "The user likes green tea"]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user is a nurse in Hamburg", "The user likes green tea"]);
    });

    it("reads objects by content, text or memory, in that order, and honours a valid type", () => {
        const parsed = parseMemoryFile(
            JSON.stringify([
                { content: "The user is a nurse in Hamburg", type: "identity" },
                { text: "The user likes green tea", type: "not-a-type" },
                { memory: "The user owns a red bike" },
                { content: "The user prefers content first", memory: "ignored second field" },
            ]),
            "json",
        );

        expect(parsed.batches.flat()).toStrictEqual([
            { memory: "The user is a nurse in Hamburg", type: "identity" },
            { memory: "The user likes green tea", type: MEMORY_FILE_DEFAULT_TYPE },
            { memory: "The user owns a red bike", type: MEMORY_FILE_DEFAULT_TYPE },
            { memory: "The user prefers content first", type: MEMORY_FILE_DEFAULT_TYPE },
        ]);
    });

    it("keeps no part of a quoted secret with spaces and a line break inside one item", () => {
        const secret = ["correct horse", "\n", "battery staple"].join("");
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", `DB_PASSWORD="${secret}"`, { text: `API_TOKEN="${secret}"` }]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 2, total: 3 });
    });

    it("keeps no part of a quoted secret inside a longer item, and none of one opened on the next line", () => {
        const parsed = parseMemoryFile(
            JSON.stringify([
                'The user deploys the blog with DB_TOKEN="alpha beta\nprivate continuation" from CI',
                'DB_TOKEN=\n"alpha\nThe user keeps this private continuation"',
            ]),
            "json",
        );

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual([`The user deploys the blog with DB_TOKEN=${REDACTED} from CI`]);
    });

    it("counts an item of another shape as invalid", () => {
        const parsed = parseMemoryFile(JSON.stringify(["The user is a nurse in Hamburg", 42, null, { note: "no text field" }, [], { text: "  " }]), "json");

        expect(parsed).toMatchObject({ entries: 1, invalid: 5, total: 6 });
    });

    it("refuses text that is not JSON", () => {
        expect(refusal("{ not json", "json")).toMatchObject({ code: "bad_json" });
        expect(refusal("The user is a nurse in Hamburg", "json")).toMatchObject({ code: "bad_json" });
    });

    it("refuses a top-level value that is not an array", () => {
        expect(refusal(JSON.stringify({ memories: ["The user is a nurse"] }), "json")).toMatchObject({ code: "bad_shape" });
        expect(refusal('"The user is a nurse in Hamburg"', "json")).toMatchObject({ code: "bad_shape" });
        expect(refusal("null", "json")).toMatchObject({ code: "bad_shape" });
    });

    it("refuses an empty array", () => {
        expect(refusal("[]", "json")).toMatchObject({ code: "empty" });
        expect(refusal('["", "  "]', "json")).toMatchObject({ code: "empty" });
    });
});

describe("limits", () => {
    it("keeps an entry of exactly the length limit and skips, counted, one character over", () => {
        const atLimit = factOfLength(MEMORY_FILE_ENTRY_MAX_CHARS);
        const parsed = parseMemoryFile(`${atLimit}\n${atLimit}b`, "text");

        expect(parsed).toMatchObject({ entries: 1, tooLong: 1, total: 2 });
        expect(parsed.batches[0]?.[0]?.memory).toBe(atLimit);
    });

    it("measures the length after wrapping and extra whitespace are removed", () => {
        const padded = `- ${factOfLength(MEMORY_FILE_ENTRY_MAX_CHARS - 5)} ${" ".repeat(10)}bbbb`;

        expect(parseMemoryFile(padded, "text")).toMatchObject({ entries: 1, tooLong: 0 });
    });

    it("accepts a file of exactly the byte limit and refuses one byte over", () => {
        const line = `${factOfLength(MEMORY_FILE_ENTRY_MAX_CHARS)}\n`;
        const atLimit = line.repeat(Math.floor(MEMORY_FILE_MAX_BYTES / line.length)).padEnd(MEMORY_FILE_MAX_BYTES, "\n");

        // Too many entries for the entry limit, but past the size check: the size is not what refuses it.
        expect(atLimit).toHaveLength(MEMORY_FILE_MAX_BYTES);
        expect(refusal(atLimit, "text")?.code).not.toBe("too_large");
        expect(refusal(`${atLimit}\n`, "text")).toMatchObject({ code: "too_large" });
    });

    it("leaves room for the JSON escaping of quotes, backslashes and line breaks in the request that carries it", () => {
        // The runtime refuses a request body over 1,048,576 bytes with a 413; each of these escapes to two bytes.
        const escapedWorstCase = JSON.stringify({ content: '"'.repeat(MEMORY_FILE_MAX_BYTES), format: "text" });

        expect(new TextEncoder().encode(escapedWorstCase).length).toBeLessThan(1_048_576);
    });

    it("counts bytes, not characters, against the size limit", () => {
        // Three bytes per character: under the limit by length, over it by bytes.
        const wide = "语".repeat(Math.floor(MEMORY_FILE_MAX_BYTES / 3) + 1);

        expect(wide.length).toBeLessThan(MEMORY_FILE_MAX_BYTES);
        expect(refusal(wide, "text")).toMatchObject({ code: "too_large" });
    });

    it("accepts the entry limit and refuses one over it", () => {
        const atLimit = parseMemoryFile(lines(MEMORY_FILE_MAX_ENTRIES), "text");

        expect(atLimit.entries).toBe(MEMORY_FILE_MAX_ENTRIES);
        expect(refusal(lines(MEMORY_FILE_MAX_ENTRIES + 1), "text")).toMatchObject({ code: "too_many_entries" });
        expect(refusal(JSON.stringify(Array.from({ length: MEMORY_FILE_MAX_ENTRIES + 1 }, (_, index) => fact(index))), "json")).toMatchObject({
            code: "too_many_entries",
        });
    });

    it("does not count blank lines as entries", () => {
        expect(parseMemoryFile(`${lines(MEMORY_FILE_MAX_ENTRIES)}${"\n".repeat(50)}`, "text").entries).toBe(MEMORY_FILE_MAX_ENTRIES);
    });
});

describe("batches", () => {
    it.each([
        [0, []],
        [1, [1]],
        [MEMORY_FILE_BATCH_SIZE - 1, [MEMORY_FILE_BATCH_SIZE - 1]],
        [MEMORY_FILE_BATCH_SIZE, [MEMORY_FILE_BATCH_SIZE]],
        [MEMORY_FILE_BATCH_SIZE + 1, [MEMORY_FILE_BATCH_SIZE, 1]],
        [MEMORY_FILE_BATCH_SIZE * 2, [MEMORY_FILE_BATCH_SIZE, MEMORY_FILE_BATCH_SIZE]],
        [MEMORY_FILE_BATCH_SIZE * 2 + 1, [MEMORY_FILE_BATCH_SIZE, MEMORY_FILE_BATCH_SIZE, 1]],
    ])("splits %i entries into the right batch sizes", (count, sizes) => {
        expect(
            toBatches(
                Array.from({ length: count }, (_, index) => index),
                MEMORY_FILE_BATCH_SIZE,
            ).map((batch) => batch.length),
        ).toStrictEqual(sizes);
    });

    it("keeps file order across batches, with no entry lost or repeated", () => {
        const count = MEMORY_FILE_BATCH_SIZE * 2 + 3;
        const parsed = parseMemoryFile(lines(count), "text");

        expect(parsed.batches.map((batch) => batch.length)).toStrictEqual([MEMORY_FILE_BATCH_SIZE, MEMORY_FILE_BATCH_SIZE, 3]);
        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(Array.from({ length: count }, (_, index) => fact(index)));
    });

    it("finds a duplicate whose first copy is in an earlier batch", () => {
        const parsed = parseMemoryFile(`${lines(MEMORY_FILE_BATCH_SIZE)}\n${fact(0).toUpperCase()}`, "text");

        expect(parsed).toMatchObject({ duplicates: 1, entries: MEMORY_FILE_BATCH_SIZE, total: MEMORY_FILE_BATCH_SIZE + 1 });
    });
});

describe("duplicates in the file", () => {
    it("skips a repeat that differs by case or spacing, keeping the first wording", () => {
        const parsed = parseMemoryFile("The user likes Green Tea\nthe  user LIKES green   tea\n The user likes green tea ", "text");

        expect(parsed).toMatchObject({ duplicates: 2, entries: 1, total: 3 });
        expect(parsed.batches[0]?.[0]?.memory).toBe("The user likes Green Tea");
    });

    it("skips a repeat in Unicode compatibility form", () => {
        const parsed = parseMemoryFile("The user likes coffee\nＴｈｅ user likes ｃｏｆｆｅｅ", "text");

        expect(parsed).toMatchObject({ duplicates: 1, entries: 1 });
    });

    it("finds repeats across JSON strings and objects", () => {
        const parsed = parseMemoryFile(JSON.stringify(["The user likes coffee", { content: "THE USER LIKES COFFEE" }]), "json");

        expect(parsed).toMatchObject({ duplicates: 1, entries: 1 });
    });

    it("does not treat different facts as repeats", () => {
        expect(parseMemoryFile("The user likes coffee\nThe user likes tea", "text").duplicates).toBe(0);
    });
});

describe(importDedupKey, () => {
    it.each([
        ["  The   User\tLikes\nTea  ", "the user likes tea"],
        ["ＴＥＡ ｔｉｍｅ", "tea time"],
        ["ﬁne ﬂour", "fine flour"],
        ["é", "é"],
        ["é", "é"],
        ["a　b", "a b"],
        ["Ⅳ ½ ①", "ⅳ ½ ①"],
    ])("normalises %j to %j", (input, expected) => {
        expect(importDedupKey(input)).toBe(expected);
    });

    it("keeps different texts apart, symbols that only look alike included", () => {
        expect(importDedupKey("tea")).not.toBe(importDedupKey("tee"));
        expect(importDedupKey("The user means ① by the circled one")).not.toBe(importDedupKey("The user means 1 by the circled one"));
    });
});
