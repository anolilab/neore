import { describe, expect, it } from "vitest";

import { buildMessages, checkBatch, chunk, collectPending, parseModelReply, styleExamples } from "./batch.mjs";
import { entryKey, parsePo, patchPo } from "./po.mjs";

const catalog = `msgid ""
msgstr ""
"Language: fr\\n"

#. placeholder {0}: user.name
#: src/a.tsx:12
msgid "Hello {0}"
msgstr ""

#: src/b.tsx:3
msgid "Save"
msgstr "Enregistrer"

#: src/c.tsx:1
msgctxt "verb"
msgid "Post"
msgstr ""

#: src/d.tsx:9
msgid "Say \\"hi\\""
msgstr ""
"multi"
"line"

#: src/e.tsx:4
#~ msgid "Gone"
#~ msgstr ""

msgid "{{broken}}"
msgstr ""
`;

describe("po", () => {
    it("parses active entries with context and skips header and obsolete ones", () => {
        const entries = parsePo(catalog);

        expect(entries.map((entry) => entry.key)).toStrictEqual(["Hello {0}", "Save", entryKey("verb", "Post"), 'Say "hi"', "{{broken}}"]);
        expect(entries[0]).toMatchObject({ extracted: ["placeholder {0}: user.name"], references: ["src/a.tsx:12"] });
        expect(entries[3].msgstr).toBe("multiline");
    });

    it("patches only the targeted msgstr lines", () => {
        const patched = patchPo(
            catalog,
            new Map([
                ["Hello {0}", "Bonjour {0}"],
                ['Say "hi"', 'Dis « salut »\n"ok"'],
                ["not in catalog", "x"],
            ]),
        );

        expect(patched).toContain('msgid "Hello {0}"\nmsgstr "Bonjour {0}"\n');
        expect(patched).toContain('msgid "Say \\"hi\\""\nmsgstr "Dis « salut »\\n\\"ok\\""\n\n');
        expect(patched).not.toContain('"multi"');
        expect(parsePo(patched)[3].msgstr).toBe('Dis « salut »\n"ok"');
        expect(patchPo(catalog, new Map())).toBe(catalog);

        // A single-line msgstr change leaves every other line byte-identical.
        const before = catalog.split("\n");
        const after = patchPo(catalog, new Map([["Hello {0}", "Bonjour {0}"]])).split("\n");

        expect(after).toHaveLength(before.length);
        expect(after.filter((line, index) => line !== before[index])).toStrictEqual(['msgstr "Bonjour {0}"']);
    });
});

describe(collectPending, () => {
    const entries = parsePo(catalog);
    const sourceText = new Map(entries.map((entry) => [entry.key, entry.msgid]));

    it("takes only empty msgstrs, with context, and skips unparseable sources", () => {
        const { pending, skipped } = collectPending(entries, sourceText);

        expect(pending.map((item) => item.key)).toStrictEqual(["Hello {0}", entryKey("verb", "Post")]);
        expect(pending[0].context).toStrictEqual({ files: ["src/a.tsx"], notes: ["placeholder {0}: user.name"] });
        expect(pending[1].context).toStrictEqual({ files: ["src/c.tsx"], msgctxt: "verb" });
        expect(skipped.map((item) => item.key)).toStrictEqual(["{{broken}}"]);
    });

    it("never touches existing translations unless forced", () => {
        expect(collectPending(entries, sourceText).pending.some((item) => item.key === "Save")).toBe(false);
        expect(collectPending(entries, sourceText, { force: true }).pending.map((item) => item.key)).toContain("Save");
    });

    it("honours the limit", () => {
        expect(collectPending(entries, sourceText, { limit: 1 }).pending).toHaveLength(1);
    });

    it("prefers the source catalog's text over the msgid", () => {
        const { pending } = collectPending(entries, new Map([["Hello {0}", "Hi there {0}"]]), { limit: 1 });

        expect(pending[0].source).toBe("Hi there {0}");
    });
});

describe(chunk, () => {
    it("splits into batches of at most the given size, preserving order", () => {
        expect(chunk([1, 2, 3, 4, 5], 2)).toStrictEqual([[1, 2], [3, 4], [5]]);
        expect(chunk([], 50)).toStrictEqual([]);
        expect(
            chunk(
                Array.from({ length: 120 }, (_, index) => index),
                50,
            ).map((batch) => batch.length),
        ).toStrictEqual([50, 50, 20]);
    });

    it("rejects a non-positive size", () => {
        expect(() => chunk([1], 0)).toThrow(RangeError);
        expect(() => chunk([1], 1.5)).toThrow(RangeError);
    });
});

describe(buildMessages, () => {
    const batch = [
        { context: { notes: ["placeholder {0}: user.name"] }, key: "Hello {0}", source: "Hello {0}" },
        { context: {}, key: "Save", source: "Save" },
    ];

    it("keys items by batch-local id and carries context", () => {
        const [system, user] = buildMessages("fr", batch, { examples: [{ source: "Settings page", translation: "Page des paramètres" }] });
        const payload = JSON.parse(user.content.slice(user.content.indexOf("{")));

        expect(system.content).toContain("French");
        expect(system.content).toContain('"Settings page" → "Page des paramètres"');
        expect(payload.items).toStrictEqual([
            { context: { notes: ["placeholder {0}: user.name"] }, id: "1", text: "Hello {0}" },
            { id: "2", text: "Save" },
        ]);
    });

    it("feeds rejected attempts back on retry", () => {
        const feedback = new Map([["Hello {0}", { problems: ["missing placeholder {0}"], translation: "Bonjour" }]]);
        const [, user] = buildMessages("fr", batch.slice(0, 1), { feedback });

        expect(user.content).toContain("rejected");
        expect(JSON.parse(user.content.slice(user.content.indexOf("{"))).items[0]).toMatchObject({
            problems: ["missing placeholder {0}"],
            rejectedAttempt: "Bonjour",
        });
    });
});

describe(parseModelReply, () => {
    it("reads the translations object, tolerating fences and prose", () => {
        expect(parseModelReply('Sure:\n```json\n{"translations": {"1": "a"}}\n```')).toStrictEqual({ 1: "a" });
        expect(parseModelReply('{"1": "b"}')).toStrictEqual({ 1: "b" });
    });

    it("throws on replies without an object", () => {
        expect(() => parseModelReply("no json")).toThrow(SyntaxError);
        expect(() => parseModelReply('{"translations": []}')).toThrow(SyntaxError);
    });
});

describe(checkBatch, () => {
    it("splits a reply into accepted and rejected items", () => {
        const batch = [
            { context: {}, key: "a", source: "Hello {0}" },
            { context: {}, key: "b", source: "{n, plural, one {# file} other {# files}}" },
            { context: {}, key: "c", source: "Save" },
        ];
        const { accepted, rejected } = checkBatch(batch, { 1: "Bonjour {name}", 2: "{n, plural, one {# fichier} other {# fichiers}}" });

        expect([...accepted]).toStrictEqual([["b", "{n, plural, one {# fichier} other {# fichiers}}"]]);
        expect(rejected.get("a")).toStrictEqual({ problems: ["missing placeholder {0}", "unexpected placeholder {name}"], translation: "Bonjour {name}" });
        expect(rejected.get("c")).toStrictEqual({ problems: ["no translation returned"], translation: null });
    });
});

describe(styleExamples, () => {
    it("returns existing translations, shortest source first", () => {
        const entries = parsePo(catalog);

        expect(styleExamples(entries, new Map([["Save", "Save the document"]]))).toStrictEqual([{ source: "Save the document", translation: "Enregistrer" }]);
    });
});
