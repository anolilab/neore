import { describe, expect, it, vi } from "vitest";

import { importDedupKey, unwrapImportLine } from "./import-logic";
import {
    MEMORY_FILE_BATCH_SIZE,
    MEMORY_FILE_DEFAULT_TYPE,
    MEMORY_FILE_ENTRY_MAX_CHARS,
    MEMORY_FILE_INLINE_MAX_ENTRIES,
    MEMORY_FILE_MAX_BYTES,
    MEMORY_FILE_MAX_ENTRIES,
    type MemoryFileError,
    parseMemoryFile,
    toBatches,
} from "./import-file-logic";

// Passes every call through; lets a test see whether an entry reached the unwrapping step.
vi.mock("./import-logic", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./import-logic")>();

    return { ...actual, unwrapImportLine: vi.fn(actual.unwrapImportLine) };
});

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

const SECRET_WORDS = /amber|hunter|alpha|battery|horse/u;

const LABEL = "DB_PASSWORD=";
const VALUE = "hunter2"; // secret-scanner:allow

/** A secret whose value does not end on its line: an unclosed quote of either kind, a value on the next line, none. */
const SECRET_CONTINUES = [
    'DB_PASSWORD="first line\n"quoted phrase" \nThe continuation phrase is amber-orchid-9472', // secret-scanner:allow
    "DB_PASSWORD='correct horse\nbattery staple in vault'", // secret-scanner:allow
    'DB_TOKEN=\n"alpha beta"', // secret-scanner:allow
    "DB_PASSWORD=\nhunter2", // secret-scanner:allow
    [`${LABEL}${VALUE}\\`, "battery-staple-in-vault"].join("\n"),
];

/** A secret whose value opens with a typographic quote that nothing closes on its line, then goes on to the next. */
const NEXT_LINE = "\nThe continuation phrase is amber-orchid-9472"; // secret-scanner:allow
const SMART_QUOTE_CONTINUES = [
    `${LABEL}“${NEXT_LINE}`,
    `${LABEL}‘${VALUE}${NEXT_LINE}`,
    `${LABEL}«${VALUE}${NEXT_LINE}`,
    `${LABEL}„${VALUE}${NEXT_LINE}`,
    `${LABEL}‚${VALUE}${NEXT_LINE}`,
    // A closer that does not pair with the opener does not close it.
    `${LABEL}“${VALUE}»${NEXT_LINE}`,
];

/** A secret in a typographic quote that closes on its line. */
const SMART_QUOTE_CLOSED = [`${LABEL}“${VALUE}”`, `${LABEL}‘${VALUE}’`, `${LABEL}«${VALUE}»`, `${LABEL}„${VALUE}“`, `${LABEL}‚${VALUE}‘`];

/** A secret whose value ends in a doubled backslash: the backslash is escaped, so the value ends on its line. */
const ESCAPED_BACKSLASH = `${LABEL}${VALUE}\\\\`;

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

    it.each(SECRET_CONTINUES)("refuses a file with a secret whose value continues past its line (%#), naming the line and never the text", (input) => {
        const error = refusal(`The user lives in Lisbon\n${input}`, "text");

        expect(error).toMatchObject({ code: "secret_continues", message: expect.stringContaining("Line 2 holds a password or key") });
        expect(error?.message).not.toMatch(SECRET_WORDS);
    });

    it.each(SMART_QUOTE_CONTINUES)("refuses a secret opened with a typographic quote that is not closed on its line (%#)", (input) => {
        const error = refusal(`The user lives in Lisbon\n${input}`, "text");

        expect(error).toMatchObject({ code: "secret_continues", message: expect.stringContaining("Line 2 holds a password or key") });
        expect(error?.message).not.toMatch(SECRET_WORDS);
    });

    it.each(SMART_QUOTE_CLOSED)("keeps a secret in a typographic quote closed on its line, redacted as before (%#)", (input) => {
        const parsed = parseMemoryFile(`${input}\nThe user likes tea`, "text");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user likes tea"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 1, total: 2 });
    });

    it("reads a doubled apostrophe as part of a single-quoted secret value, so an unclosed one is refused and skipped", () => {
        const input = `DB_PASSWORD: 'it''s blue${NEXT_LINE}`; // secret-scanner:allow
        const error = refusal(`The user lives in Lisbon\n${input}`, "text");

        expect(error).toMatchObject({ code: "secret_continues", message: expect.stringContaining("Line 2 holds a password or key") });
        expect(error?.message).not.toMatch(SECRET_WORDS);
        expect(parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input]), "json")).toMatchObject({ entries: 1, invalid: 1, total: 2 });
    });

    it("keeps a single-quoted secret value with a doubled apostrophe that closes on its line, redacted as before", () => {
        const parsed = parseMemoryFile("DB_PASSWORD: 'it''s blue'\nThe user likes tea", "text"); // secret-scanner:allow

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user likes tea"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 1, total: 2 });
    });

    it("refuses a secret whose label is split by emphasis, reading the line as it will be stored, with the right line number", () => {
        const error = refusal('The user lives in Lisbon\nThe user likes tea\nDB_**PASSWORD**="alpha\nbeta-gamma-7731"', "text"); // secret-scanner:allow

        expect(error).toMatchObject({ code: "secret_continues", message: expect.stringContaining("Line 3 holds a password or key") });
        expect(error?.message).not.toMatch(SECRET_WORDS);
    });

    it("refuses a bulleted line whose emphasised label continues", () => {
        expect(refusal('- **DB_PASSWORD**="alpha\nbeta-gamma-7731"', "text")).toMatchObject({ message: expect.stringContaining("Line 1") }); // secret-scanner:allow
    });

    it("still imports an ordinary line with emphasis and no secret label", () => {
        const parsed = parseMemoryFile("The **user** likes green tea\n- The user lives in **Lisbon**", "text");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user likes green tea", "The user lives in Lisbon"]);
    });

    it("refuses a file over a line past the raw-length guard that holds a secret label, naming its line and never the text", () => {
        const long = `DB_PASSWORD="${"x".repeat(MEMORY_FILE_ENTRY_MAX_CHARS * 10)}`; // secret-scanner:allow
        const error = refusal(`The user likes green tea\n${long}\nThe continuation phrase is amber-orchid-9472`, "text"); // secret-scanner:allow

        expect(error).toMatchObject({ code: "secret_continues", message: expect.stringContaining("Line 2 holds a password or key") });
        expect(error?.message).not.toMatch(SECRET_WORDS);
    });

    it("skips, counted, a JSON item whose line past the raw-length guard holds a secret label", () => {
        const long = `DB_PASSWORD="${"x".repeat(MEMORY_FILE_ENTRY_MAX_CHARS * 10)}`; // secret-scanner:allow
        const input = `${long}\nThe continuation phrase is amber-orchid-9472`; // secret-scanner:allow
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input, { text: input }]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 2, tooLong: 0, total: 3 });
    });

    it("refuses a file over a line past the raw-length guard whose label is split by emphasis, and never unwraps that line", () => {
        const unwrap = vi.mocked(unwrapImportLine);
        const long = `DB_**PASSWORD**="${"x".repeat(MEMORY_FILE_ENTRY_MAX_CHARS * 10)}`; // secret-scanner:allow

        unwrap.mockClear();

        const error = refusal(`The user likes green tea\n${long}\nThe continuation phrase is amber-orchid-9472`, "text"); // secret-scanner:allow

        expect(error).toMatchObject({ code: "secret_continues", message: expect.stringContaining("Line 2 holds a password or key") });
        expect(unwrap.mock.calls.every(([line]) => line === "The user likes green tea")).toBe(true);
    });

    it("skips, counted, a JSON item whose oversized line has an emphasis-split label", () => {
        const long = `DB_**PASSWORD**="${"x".repeat(MEMORY_FILE_ENTRY_MAX_CHARS * 10)}`; // secret-scanner:allow
        const input = `${long}\nThe continuation phrase is amber-orchid-9472`; // secret-scanner:allow
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input, { text: input }]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 2, tooLong: 0, total: 3 });
    });

    it("refuses a file whose label has a name of 41 or more characters before the secret word", () => {
        const input = `${"a_very_long_service_name_for_the_database".repeat(2)}_PASSWORD="value\nThe continuation phrase is amber-orchid-9472`; // secret-scanner:allow
        const error = refusal(`The user lives in Lisbon\n${input}`, "text");

        expect(error).toMatchObject({ code: "secret_continues", message: expect.stringContaining("Line 2 holds a password or key") });
        expect(error?.message).not.toMatch(SECRET_WORDS);
    });

    it("skips, counted, a JSON item whose label has a name of 41 or more characters before the secret word", () => {
        const input = `${"a_very_long_service_name_for_the_database".repeat(2)}_PASSWORD="value\nThe continuation phrase is amber-orchid-9472`; // secret-scanner:allow
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input, { text: input }]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 2, total: 3 });
    });

    it.each([
        'DB_PASSWORD_PROD="value\nThe continuation phrase is amber-orchid-9472', // secret-scanner:allow
        '__DB_PASSWORD__="value\nThe continuation phrase is amber-orchid-9472', // secret-scanner:allow
    ])("refuses a text file whose label has a suffix or is wrapped in underscores (%#)", (input) => {
        expect(refusal(`The user lives in Lisbon\n${input}`, "text")).toMatchObject({ code: "secret_continues" });
    });

    it("refuses a file over an oversized line whose label is wrapped in underscores, and skips the JSON item", () => {
        const long = `__DB_PASSWORD__="${"x".repeat(MEMORY_FILE_ENTRY_MAX_CHARS * 10)}`; // secret-scanner:allow
        const input = `${long}\nThe continuation phrase is amber-orchid-9472`; // secret-scanner:allow

        expect(refusal(`The user lives in Lisbon\n${input}`, "text")).toMatchObject({ code: "secret_continues" });
        expect(parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input]), "json")).toMatchObject({ entries: 1, invalid: 1, total: 2 });
    });

    it("skips, counted, a JSON item whose label has a suffix after the secret word", () => {
        const input = 'DB_PASSWORD_PROD="value\nThe continuation phrase is amber-orchid-9472'; // secret-scanner:allow
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input]), "json");

        expect(parsed).toMatchObject({ entries: 1, invalid: 1, total: 2 });
    });

    it("does not refuse a name that only starts with a secret's word, and imports both lines", () => {
        const input = "Login methods: passwordless:\nThe user likes green tea";
        const parsed = parseMemoryFile(input, "text");

        expect(refusal(input, "text")).toBeUndefined();
        expect(parsed.batches.flat()).toHaveLength(2);
        expect(refusal("The user lives in Lisbon\nmax_tokens:", "text")).toBeUndefined();
    });

    it("still refuses a secret label that ends its name with the value on the next line", () => {
        expect(refusal("DB_PASSWORD=\nThe user likes green tea", "text")).toMatchObject({ code: "secret_continues" }); // secret-scanner:allow
    });

    it.each([
        "DB_PASSWORD: |\n  hunter2", // secret-scanner:allow
        "DB_PASSWORD: >\n  hunter2", // secret-scanner:allow
        "DB_PASSWORD: >-\n  hunter2", // secret-scanner:allow
        "DB_PASSWORD: |2+\n  hunter2", // secret-scanner:allow
        "DB_PASSWORD: >+1  # the vault value\n  hunter2", // secret-scanner:allow
        "DB_PASSWORD=|\n  hunter2", // secret-scanner:allow
    ])("refuses a text file and skips a JSON item whose secret value is a YAML block (%#)", (input) => {
        const error = refusal(`The user lives in Lisbon\n${input}`, "text");

        expect(error).toMatchObject({ code: "secret_continues", message: expect.stringContaining("Line 2") });
        expect(error?.message).not.toMatch(SECRET_WORDS);
        expect(parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input]), "json")).toMatchObject({ entries: 1, invalid: 1, total: 2 });
    });

    it("still imports an ordinary fact that holds a pipe or an arrow and no secret label", () => {
        const input = "The user likes tea | coffee\nThe user's shortcut is Ctrl > Alt\nTo-do: | is the pipe key";
        const parsed = parseMemoryFile(input, "text");

        expect(refusal(input, "text")).toBeUndefined();
        expect(parsed.batches.flat()).toHaveLength(3);
    });

    it("does not read a secret label followed by more than a block header as a block", () => {
        expect(refusal("DB_PASSWORD: | not a block\nThe user likes green tea", "text")).toBeUndefined(); // secret-scanner:allow
        expect(refusal("DB_PASSWORD: |x\nThe user likes green tea", "text")).toBeUndefined(); // secret-scanner:allow
    });

    it("refuses a text file and skips a JSON item whose label hides a zero-width character", () => {
        const input = `pass\u{200B}word=\nThe user likes green tea`; // secret-scanner:allow
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input]), "json");

        expect(refusal(`The user lives in Lisbon\n${input}`, "text")).toMatchObject({ code: "secret_continues" });
        expect(parsed).toMatchObject({ entries: 1, invalid: 1, total: 2 });
    });

    it("still reads a long-named label whose value closes on its line as complete", () => {
        const input = `${"a_very_long_service_name_for_the_database".repeat(2)}_PASSWORD="value"`; // secret-scanner:allow

        expect(refusal(`The user lives in Lisbon\n${input}`, "text")).toBeUndefined();
    });

    it("does not refuse a file over a line past the raw-length guard that holds no secret label", () => {
        const long = `The user likes tea ${"x".repeat(MEMORY_FILE_ENTRY_MAX_CHARS * 10)}`;

        expect(parseMemoryFile(`${long}\nThe user likes green tea`, "text")).toMatchObject({ entries: 1, tooLong: 1, total: 2 });
    });

    it("does not refuse a secret that ends in an escaped (doubled) backslash, and stores nothing of it", () => {
        const content = `The user lives in Lisbon\n${ESCAPED_BACKSLASH}`;

        expect(refusal(content, "text")).toBeUndefined();
        expect(
            parseMemoryFile(content, "text")
                .batches.flat()
                .map((entry) => entry.memory),
        ).toStrictEqual(["The user lives in Lisbon"]);
    });

    it("refuses on a line break other than a newline, and counts the lines before it", () => {
        expect(refusal(`The user lives in Lisbon\u{2028}DB_PASSWORD=\r\nhunter2`, "text")).toMatchObject({ message: expect.stringContaining("Line 2") }); // secret-scanner:allow
    });

    it("keeps a secret closed on its line, redacted as a paste redacts it, and the line after it", () => {
        const parsed = parseMemoryFile('Wifi password: "guest"!\nThe user likes tea', "text"); // secret-scanner:allow

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user likes tea"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 1, total: 2 });
    });

    it("counts a line that is only wrapping as invalid, and still ignores a blank one", () => {
        const parsed = parseMemoryFile("-\n**\n\n   \nThe user likes green tea", "text");

        expect(parsed).toMatchObject({ entries: 1, invalid: 2, total: 3 });
    });

    it("reads a 500 KB line of near-labels (a name, no separator) as too long", () => {
        // Every word boundary starts a label scan that reaches a secret name and then fails on the missing separator: a
        // hostile line must not cost more than a bounded read of its text.
        const block = "a-token a_password a-secret-key ";
        const content = block.repeat(Math.floor(MEMORY_FILE_MAX_BYTES / block.length));

        expect(parseMemoryFile(content, "text")).toMatchObject({ entries: 0, tooLong: 1, total: 1 });
    });

    it("refuses a 500 KB line of repeated secret labels", () => {
        const block = `${'TOKEN="'.repeat(569)}" `;
        const content = block.repeat(Math.floor(MEMORY_FILE_MAX_BYTES / block.length));

        expect(refusal(content, "text")).toMatchObject({ code: "secret_continues" });
    });

    it("counts an entry that grows past the limit once its secret is redacted as too long, not cut", () => {
        // A marker is two characters longer than this secret: 499 characters in, 501 out.
        const line = `${factOfLength(480)} password: abc12xyz`; // secret-scanner:allow

        expect(line).toHaveLength(MEMORY_FILE_ENTRY_MAX_CHARS - 1);
        expect(parseMemoryFile(`${line}\nThe user likes green tea`, "text")).toMatchObject({ entries: 1, tooLong: 1, total: 2 });
    });

    it("counts a 180 KB entry of nested tag fragments as too long without unwrapping it", () => {
        const crafted = "<pasted_<pasted_memories>memories>".repeat(5300);
        const unwrap = vi.mocked(unwrapImportLine);

        expect(crafted.length).toBeGreaterThan(180_000);
        unwrap.mockClear();

        const parsed = parseMemoryFile(`${crafted}\nThe user likes green tea`, "text");

        expect(parsed).toMatchObject({ entries: 1, tooLong: 1, total: 2 });
        // Only the short line reached the unwrapping step, once, to prepare it: the continuation check never unwraps.
        expect(unwrap).toHaveBeenCalledTimes(1);
        expect(unwrap.mock.calls.every(([line]) => line === "The user likes green tea")).toBe(true);
    });

    describe("a 500 KB file of lines of nested tag fragments just under the raw-length guard", () => {
        const FRAGMENT = "<pasted_<pasted_memories>memories>";
        const line = FRAGMENT.repeat(Math.floor((MEMORY_FILE_ENTRY_MAX_CHARS * 10 - 1) / FRAGMENT.length));
        const crafted = `${line}\n`.repeat(Math.floor(MEMORY_FILE_MAX_BYTES / (line.length + 1))).trimEnd();

        it("is a crafted file: many lines, each under the guard, the whole near the size limit", () => {
            expect(line.length).toBeLessThanOrEqual(MEMORY_FILE_ENTRY_MAX_CHARS * 10);
            expect(line.length).toBeGreaterThan(MEMORY_FILE_ENTRY_MAX_CHARS * 9);
            expect(crafted.length).toBeGreaterThan(MEMORY_FILE_MAX_BYTES - line.length - 1);
            expect(crafted.length).toBeLessThanOrEqual(MEMORY_FILE_MAX_BYTES);
        });

        it("is refused for a caller's entry limit before any entry is unwrapped", () => {
            const unwrap = vi.mocked(unwrapImportLine);

            unwrap.mockClear();

            expect(() => parseMemoryFile(crafted, "text", { maxEntries: MEMORY_FILE_INLINE_MAX_ENTRIES })).toThrow(
                expect.objectContaining({ code: "too_many_entries" }) as unknown as Error,
            );
            expect(unwrap).not.toHaveBeenCalled();
        });

        it("unwraps at most the entry limit's number of times when it holds that many lines", () => {
            const unwrap = vi.mocked(unwrapImportLine);
            const lineCount = MEMORY_FILE_INLINE_MAX_ENTRIES;

            unwrap.mockClear();

            const parsed = parseMemoryFile(`${line}\n`.repeat(lineCount).trimEnd(), "text", { maxEntries: MEMORY_FILE_INLINE_MAX_ENTRIES });

            expect(parsed.total).toBe(lineCount);
            expect(unwrap.mock.calls.length).toBeLessThanOrEqual(MEMORY_FILE_INLINE_MAX_ENTRIES);
        });

        it("is checked for a continuing secret without unwrapping a line under the default entry limit", () => {
            const unwrap = vi.mocked(unwrapImportLine);
            const lineCount = crafted.split("\n").length;

            unwrap.mockClear();

            // Each line is unwrapped once, to prepare it; the continuation check adds none.
            expect(parseMemoryFile(crafted, "text").total).toBe(lineCount);
            expect(unwrap).toHaveBeenCalledTimes(lineCount);
        });
    });

    it("refuses a secret whose label has a data tag inside it, and a continuation line after it", () => {
        const error = refusal(
            'The user lives in Lisbon\nDB_<pasted_memories>PASSWORD</pasted_memories>="x\nThe continuation phrase is amber-orchid-9472',
            "text",
        ); // secret-scanner:allow

        expect(error).toMatchObject({ code: "secret_continues", message: expect.stringContaining("Line 2 holds a password or key") });
        expect(error?.message).not.toMatch(SECRET_WORDS);
    });

    it("refuses a label split by emphasis inside a data tag", () => {
        expect(refusal('PASS<new_**fact>WORD="x\nThe continuation phrase is amber-orchid-9472', "text")).toMatchObject({ code: "secret_continues" }); // secret-scanner:allow
    });

    it("refuses a line past the raw-length guard whose label sits inside an unclosed data tag", () => {
        const long = `<pasted_memories DB_PASSWORD="${"x".repeat(MEMORY_FILE_ENTRY_MAX_CHARS * 10)}`; // secret-scanner:allow

        expect(refusal(`${long}\nThe continuation phrase is amber-orchid-9472`, "text")).toMatchObject({ code: "secret_continues" }); // secret-scanner:allow
    });

    it("skips, counted, a JSON item whose label has a data tag inside it and a continuation line after it", () => {
        const input = 'DB_<pasted_memories>PASSWORD</pasted_memories>="x\nThe continuation phrase is amber-orchid-9472'; // secret-scanner:allow
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 1, total: 2 });
    });

    it("refuses a file with more entries than the limit a caller passes", () => {
        expect(() => parseMemoryFile(lines(MEMORY_FILE_INLINE_MAX_ENTRIES + 1), "text", { maxEntries: MEMORY_FILE_INLINE_MAX_ENTRIES })).toThrow(
            expect.objectContaining({ code: "too_many_entries" }) as unknown as Error,
        );
        expect(parseMemoryFile(lines(MEMORY_FILE_INLINE_MAX_ENTRIES), "text", { maxEntries: MEMORY_FILE_INLINE_MAX_ENTRIES }).entries).toBe(
            MEMORY_FILE_INLINE_MAX_ENTRIES,
        );
    });

    it("still imports a normal entry just under the raw-length guard that shrinks through redaction", () => {
        const line = `The user likes green tea. My key is sk-${"Zq8LmV2xR7tYw4KpN3bC".repeat(200)} and nothing else`; // secret-scanner:allow

        expect(line.length).toBeGreaterThan(MEMORY_FILE_ENTRY_MAX_CHARS * 5);
        expect(line.length).toBeLessThanOrEqual(MEMORY_FILE_ENTRY_MAX_CHARS * 10);
        expect(parseMemoryFile(line, "text")).toMatchObject({ entries: 1, tooLong: 0, total: 1 });
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

    it.each(SECRET_CONTINUES)("skips, counted, an item whose secret continues past its line (%#)", (input) => {
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input, { text: input }]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 2, total: 3 });
    });

    it("skips, counted, an item whose secret label is split by emphasis and continues past its line", () => {
        const input = 'DB_**PASSWORD**="alpha\nbeta-gamma-7731"'; // secret-scanner:allow
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input, { content: input }]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 2, total: 3 });
    });

    it.each(SMART_QUOTE_CONTINUES)("skips, counted, an item whose secret opens a typographic quote that is not closed on its line (%#)", (input) => {
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", input, { text: input }]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 2, total: 3 });
    });

    it("ignores blank string items: they neither count toward the entry limit nor are reported", () => {
        const items = [
            ...Array.from({ length: MEMORY_FILE_BATCH_SIZE }, (_, index) => fact(index)),
            ...Array.from({ length: 6000 }, (_, index) => (index % 2 === 0 ? "" : "  \t")),
        ];
        const parsed = parseMemoryFile(JSON.stringify(items), "json");

        expect(parsed).toMatchObject({ entries: MEMORY_FILE_BATCH_SIZE, invalid: 0, total: MEMORY_FILE_BATCH_SIZE });
    });

    it("still imports a JSON item with emphasis and no secret label", () => {
        const parsed = parseMemoryFile(JSON.stringify(["The **user** likes green tea"]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user likes green tea"]);
    });

    it("counts an item that is only wrapping as invalid", () => {
        const parsed = parseMemoryFile(JSON.stringify(["-", { text: "**" }, "The user likes green tea"]), "json");

        expect(parsed).toMatchObject({ entries: 1, invalid: 2, total: 3 });
    });

    it("counts an item of another shape as invalid", () => {
        const parsed = parseMemoryFile(JSON.stringify(["The user is a nurse in Hamburg", 42, null, { note: "no text field" }, [], { text: "  " }]), "json");

        expect(parsed).toMatchObject({ entries: 1, invalid: 5, total: 6 });
    });

    it("keeps an item whose secret ends in an escaped (doubled) backslash out of the list without skipping the file", () => {
        const parsed = parseMemoryFile(JSON.stringify(["The user lives in Lisbon", ESCAPED_BACKSLASH]), "json");

        expect(parsed.batches.flat().map((entry) => entry.memory)).toStrictEqual(["The user lives in Lisbon"]);
        expect(parsed).toMatchObject({ entries: 1, invalid: 1, total: 2 });
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

        expect(atLimit).toHaveLength(MEMORY_FILE_MAX_BYTES);
        expect(refusal(atLimit, "text")).toBeUndefined();
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
