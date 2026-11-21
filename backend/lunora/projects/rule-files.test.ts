import { describe, expect, it } from "vitest";

import {
    MAX_RULE_DESCRIPTION_LENGTH,
    MAX_RULE_FILE_LENGTH,
    MAX_RULE_FILES,
    MAX_RULE_GLOB_LENGTH,
    MAX_RULE_GLOBS,
    MAX_RULE_TITLE_LENGTH,
    RULE_FILE_REFUSALS,
} from "./rule-file-limits";
import {
    MAX_RULE_TEXT_PER_RUN,
    matchesGlob,
    normalizeRuleFiles,
    projectRuleFiles,
    renderInstructionList,
    renderRuleFiles,
    type RuleFile,
    ruleFilesRevision,
    selectRuleFiles,
} from "./rule-files";

const always = (id: string, content: string): RuleFile => {
    return { content, id, mode: "always", title: id };
};

const auto = (id: string, content: string, description = `When ${id} applies`): RuleFile => {
    return { content, description, id, mode: "auto", title: id };
};

const sql: RuleFile = { content: "Use snake_case columns.", globs: ["**/*.sql"], id: "sql", mode: "glob", title: "SQL" };

describe("matchesGlob", () => {
    it.each([
        ["**/*.sql", "schema.sql", true],
        ["**/*.sql", "db/migrations/001.sql", true],
        ["**/*.sql", "notes.md", false],
        ["*.sql", "db/schema.sql", true],
        ["db/*.sql", "db/schema.sql", true],
        ["db/*.sql", "db/nested/schema.sql", false],
        ["src/**/*.{ts,tsx}", "src/a/b/view.tsx", true],
        ["src/**/*.{ts,tsx}", "lib/view.tsx", false],
        ["?.md", "a.md", true],
        ["*.sql", String.raw`db\schema.sql`, true],
        ["./db/*.sql", "/db/x.sql", true],
    ])("%s against %s is %s", (glob, path, expected) => {
        expect(matchesGlob(glob, path)).toBe(expected);
    });

    it("reads a backslash in a pattern as a folder separator, as in a path", () => {
        expect(matchesGlob(String.raw`db\*.sql`, "db/schema.sql")).toBe(true);
        expect(matchesGlob(String.raw`db\*.sql`, String.raw`db\schema.sql`)).toBe(true);
    });

    it("answers a pattern built to backtrack without hanging", () => {
        expect(matchesGlob(`${"*a".repeat(40)}*b`, "a".repeat(1000))).toBe(false);
        expect(matchesGlob("**/".repeat(60), `${"x/".repeat(400)}y`)).toBe(false);
    });

    it("stops matching a run's costly patterns once its step budget is spent", () => {
        const costly = Array.from({ length: MAX_RULE_FILES }, (_, index): RuleFile => {
            return { content: "x", globs: Array.from({ length: 10 }, () => `${"*a".repeat(99)}*b`), id: `f${index}`, mode: "glob", title: "t" };
        });
        const result = selectRuleFiles(
            costly,
            Array.from({ length: 20 }, () => "a".repeat(255)),
        );

        expect(result).toMatchObject({ files: [], matchingCut: true });
    });

    it("charges each path it walks, and does nothing once the budget is spent", () => {
        const budget = { steps: 10_000 };

        expect(matchesGlob("x", "a".repeat(500), budget)).toBe(false);
        expect(budget.steps).toBeLessThanOrEqual(10_000 - 500);

        const spent = { steps: 0 };

        expect(matchesGlob("*.sql", "a.sql", spent)).toBe(false);
        expect(spent.steps).toBe(0);
    });
});

describe("projectRuleFiles", () => {
    it("reads a project's legacy context as its first always file, before the saved list", () => {
        expect(projectRuleFiles({ context: "Answer in German.", ruleFiles: [sql] })).toEqual([
            { content: "Answer in German.", id: "context", mode: "always", title: "Project context" },
            sql,
        ]);
        expect(projectRuleFiles({ context: "x", ruleFiles: [always("context", "y")] }).map((file) => file.id)).toEqual(["context-2", "context"]);
        expect(projectRuleFiles({})).toEqual([]);
    });
});

describe("selectRuleFiles", () => {
    it("takes a glob file only for a run whose files match it", () => {
        const files = [always("a", "Always."), sql];

        expect(renderRuleFiles(selectRuleFiles(files, ["report.pdf"]).files)).toBe("Always.");
        expect(renderRuleFiles(selectRuleFiles(files, ["queries/report.sql"]).files)).toBe("Always.\n\nUse snake_case columns.");
    });

    it("gives a project with only its legacy context exactly that text, as before rule files", () => {
        const context = "Line one.\n\nLine two.";

        expect(renderRuleFiles(selectRuleFiles(projectRuleFiles({ context }), []).files)).toBe(context);
    });

    it("never cuts a legacy context, as before rule files, and leaves the files beside it their whole budget", () => {
        const context = "c".repeat(MAX_RULE_TEXT_PER_RUN + 5);
        const result = selectRuleFiles(projectRuleFiles({ context, ruleFiles: [always("b", "after")] }), []);

        expect(renderRuleFiles(result.files)).toBe(`${context}\n\nafter`);
        expect(result).toMatchObject({ omitted: 0, truncated: false });
    });

    it("cuts the file that reaches the run's budget and leaves the rest out", () => {
        const big = "x".repeat(MAX_RULE_TEXT_PER_RUN - 100);
        const result = selectRuleFiles([always("a", big), always("b", "y".repeat(500)), always("c", "z")], []);

        expect(result.files.map((file) => file.id)).toEqual(["a", "b"]);
        expect(result.files[1]!.content.startsWith("y".repeat(50))).toBe(true);
        expect(result.files[1]!.content).toContain("truncated");
        expect(result).toMatchObject({ omitted: 1, truncated: true });
        expect(renderRuleFiles(result.files)).toHaveLength(MAX_RULE_TEXT_PER_RUN);
    });

    it("counts the separators and the cut file's marker in the run's budget", () => {
        const files = Array.from({ length: 20 }, (_, index) => always(`f${index}`, String(index % 10).repeat(MAX_RULE_TEXT_PER_RUN / 16 - 1)));
        const result = selectRuleFiles(files, []);

        expect(result.truncated).toBe(true);
        expect(renderRuleFiles(result.files)!.length).toBeLessThanOrEqual(MAX_RULE_TEXT_PER_RUN);
    });

    it("leaves out a file with no room past its separator and marker, rather than run over", () => {
        const result = selectRuleFiles([always("a", "x".repeat(MAX_RULE_TEXT_PER_RUN - 5)), always("b", "y".repeat(100))], []);

        expect(result.files.map((file) => file.id)).toEqual(["a"]);
        expect(result).toMatchObject({ omitted: 1, truncated: false });
        expect(renderRuleFiles(result.files)!.length).toBeLessThanOrEqual(MAX_RULE_TEXT_PER_RUN);
    });

    it("keeps the files beside a legacy context within the budget, past the context's own text", () => {
        const context = "c".repeat(1000);
        const files = [always("a", "x".repeat(MAX_RULE_TEXT_PER_RUN / 2)), always("b", "y".repeat(MAX_RULE_TEXT_PER_RUN))];
        const rendered = renderRuleFiles(selectRuleFiles(projectRuleFiles({ context, ruleFiles: files }), []).files)!;

        expect(rendered.startsWith(context)).toBe(true);
        expect(rendered.length).toBeLessThanOrEqual(context.length + MAX_RULE_TEXT_PER_RUN);
    });
});

describe("selectRuleFiles with auto files", () => {
    it("lists an auto file by name and description, never its text, and leaves an empty one out", () => {
        const result = selectRuleFiles([always("a", "Always."), auto("deploy", "Deploy steps."), auto("blank", " ")], []);

        expect(renderRuleFiles(result.files)).toBe("Always.");
        expect(result.instructions.map((file) => file.id)).toStrictEqual(["deploy"]);
        expect(result.omitted).toBe(0);
        expect(renderInstructionList(result.instructions)).toContain("- deploy (id: deploy): When deploy applies");
        expect(renderInstructionList(result.instructions)).not.toContain("Deploy steps.");
    });

    it("counts the list, header and separator included, against the run's budget", () => {
        const text = always("a", "x".repeat(MAX_RULE_TEXT_PER_RUN - 2 - renderInstructionList([auto("one", "1")])!.length));
        const fits = selectRuleFiles([text, auto("one", "1"), auto("two", "2")], []);

        expect(fits.instructions.map((file) => file.id)).toStrictEqual(["one"]);
        expect(fits.omitted).toBe(1);
        expect(`${renderRuleFiles(fits.files)}\n\n${renderInstructionList(fits.instructions)}`).toHaveLength(MAX_RULE_TEXT_PER_RUN);
    });

    it("leaves a run that shows no list the whole budget for its always and matching files", () => {
        const first = always("a", "x".repeat(MAX_RULE_TEXT_PER_RUN - 200));
        const files = [auto("one", "1", "d".repeat(150)), first, always("b", "y".repeat(150)), { ...sql, content: "z".repeat(40) }];
        const listed = selectRuleFiles(files, ["db/schema.sql"]);
        const unlisted = selectRuleFiles(files, ["db/schema.sql"], false);

        expect(listed.truncated).toBe(true);
        expect(unlisted).toMatchObject({ instructions: [], omitted: 0, truncated: false });
        expect(unlisted.files.map((file) => file.id)).toStrictEqual(["a", "b", sql.id]);
    });

    it("gives no list for a project without auto files", () => {
        expect(renderInstructionList(selectRuleFiles([always("a", "A"), sql], []).instructions)).toBeNull();
    });
});

describe("ruleFilesRevision", () => {
    it("changes with any edit or a new order, and not otherwise", () => {
        const files = [always("a", "A"), sql];

        expect(ruleFilesRevision(files)).toBe(ruleFilesRevision([always("a", "A"), { ...sql }]));
        expect(ruleFilesRevision(files)).not.toBe(ruleFilesRevision([sql, always("a", "A")]));
        expect(ruleFilesRevision(files)).not.toBe(ruleFilesRevision([always("a", "A!"), sql]));
        expect(ruleFilesRevision([auto("d", "D")])).not.toBe(ruleFilesRevision([auto("d", "D", "Other")]));
    });
});

describe("normalizeRuleFiles", () => {
    it("trims, drops patterns from an always file, and keeps the order", () => {
        expect(
            normalizeRuleFiles([
                { ...always("a", "A"), globs: ["*.md"], title: "  A  " },
                { ...sql, globs: [" **/*.sql "] },
            ]),
        ).toEqual([
            { content: "A", id: "a", mode: "always", title: "A" },
            { ...sql, globs: ["**/*.sql"] },
        ]);
    });

    it("trims an auto file's description and keeps no patterns on it", () => {
        expect(normalizeRuleFiles([{ ...auto("d", "D", "  Deploys  "), globs: ["*.md"] }])).toEqual([
            { content: "D", description: "Deploys", id: "d", mode: "auto", title: "d" },
        ]);
    });

    it.each([
        ["an auto file without a description", [auto("d", "D", "  ")], RULE_FILE_REFUSALS.DESCRIPTION_MISSING, "d"],
        ["an auto description on two lines", [auto("d", "D", "One\ntwo")], RULE_FILE_REFUSALS.DESCRIPTION_INVALID, "d"],
        ["an auto description past its length", [auto("d", "D", "d".repeat(MAX_RULE_DESCRIPTION_LENGTH + 1))], RULE_FILE_REFUSALS.DESCRIPTION_INVALID, "d"],
        ["too many files", Array.from({ length: MAX_RULE_FILES + 1 }, (_, index) => always(`f${index}`, "x")), RULE_FILE_REFUSALS.TOO_MANY, undefined],
        ["an empty title", [{ ...always("a", "x"), title: " " }], RULE_FILE_REFUSALS.TITLE_MISSING, "a"],
        ["a title past its length", [{ ...always("a", "x"), title: "t".repeat(MAX_RULE_TITLE_LENGTH + 1) }], RULE_FILE_REFUSALS.TITLE_TOO_LONG, "a"],
        ["a glob file without a pattern", [{ ...sql, globs: [] }], RULE_FILE_REFUSALS.PATTERNS_MISSING, "sql"],
        [
            "a glob file past its patterns",
            [{ ...sql, globs: Array.from({ length: MAX_RULE_GLOBS + 1 }, (_, index) => `${index}.sql`) }],
            RULE_FILE_REFUSALS.PATTERNS_TOO_MANY,
            "sql",
        ],
        ["a pattern past its length", [{ ...sql, globs: ["p".repeat(MAX_RULE_GLOB_LENGTH + 1)] }], RULE_FILE_REFUSALS.PATTERN_INVALID, "sql"],
        ["a pattern with a line break", [{ ...sql, globs: ["*.sql\n*.md"] }], RULE_FILE_REFUSALS.PATTERN_INVALID, "sql"],
        ["a file past its size", [always("a", "x".repeat(MAX_RULE_FILE_LENGTH + 1))], RULE_FILE_REFUSALS.CONTENT_TOO_LONG, "a"],
        [
            "files past their size together",
            Array.from({ length: 11 }, (_, index) => always(`f${index}`, "x".repeat(99_999))),
            RULE_FILE_REFUSALS.TOO_LARGE,
            undefined,
        ],
        // 600,000 characters, but twice that once stored: each backslash is written escaped.
        [
            "files past their size as stored",
            Array.from({ length: 6 }, (_, index) => always(`f${index}`, "\\".repeat(99_999))),
            RULE_FILE_REFUSALS.TOO_LARGE,
            undefined,
        ],
    ])("refuses %s, naming the limit and the file", (_, files, code, fileId) => {
        expect(() => normalizeRuleFiles(files)).toThrow(
            expect.objectContaining({ code: "BAD_REQUEST", data: fileId === undefined ? { code } : { code, fileId } }),
        );
    });

    it("refuses a repeated id", () => {
        expect(() => normalizeRuleFiles([always("a", "x"), always("a", "y")])).toThrow();
    });
});
