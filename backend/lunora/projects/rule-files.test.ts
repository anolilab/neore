import { describe, expect, it } from "vitest";

import {
    MAX_RULE_FILES,
    MAX_RULE_TEXT_PER_RUN,
    matchesGlob,
    normalizeRuleFiles,
    projectRuleFiles,
    renderRuleFiles,
    type RuleFile,
    ruleFilesRevision,
    selectRuleFiles,
} from "./rule-files";

const always = (id: string, content: string): RuleFile => {
    return { content, id, mode: "always", title: id };
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

    it("never cuts a legacy context, as before rule files, and counts it against the budget", () => {
        const context = "c".repeat(MAX_RULE_TEXT_PER_RUN + 5);
        const result = selectRuleFiles(projectRuleFiles({ context, ruleFiles: [always("b", "after")] }), []);

        expect(renderRuleFiles(result.files)).toBe(context);
        expect(result).toMatchObject({ omitted: 1, truncated: false });
    });

    it("cuts the file that reaches the run's budget and leaves the rest out", () => {
        const big = "x".repeat(MAX_RULE_TEXT_PER_RUN - 10);
        const result = selectRuleFiles([always("a", big), always("b", "y".repeat(50)), always("c", "z")], []);

        expect(result.files.map((file) => file.id)).toEqual(["a", "b"]);
        expect(result.files[1]!.content.startsWith("y".repeat(10))).toBe(true);
        expect(result.files[1]!.content).toContain("truncated");
        expect(result).toMatchObject({ omitted: 1, truncated: true });
    });
});

describe("ruleFilesRevision", () => {
    it("changes with any edit or a new order, and not otherwise", () => {
        const files = [always("a", "A"), sql];

        expect(ruleFilesRevision(files)).toBe(ruleFilesRevision([always("a", "A"), { ...sql }]));
        expect(ruleFilesRevision(files)).not.toBe(ruleFilesRevision([sql, always("a", "A")]));
        expect(ruleFilesRevision(files)).not.toBe(ruleFilesRevision([always("a", "A!"), sql]));
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

    it.each([
        ["too many files", Array.from({ length: MAX_RULE_FILES + 1 }, (_, index) => always(`f${index}`, "x"))],
        ["a repeated id", [always("a", "x"), always("a", "y")]],
        ["an empty title", [{ ...always("a", "x"), title: " " }]],
        ["a glob file without a pattern", [{ ...sql, globs: [] }]],
        ["a pattern with a line break", [{ ...sql, globs: ["*.sql\n*.md"] }]],
        ["a file past its size", [always("a", "x".repeat(100_001))]],
        ["files past their size together", Array.from({ length: 11 }, (_, index) => always(`f${index}`, "x".repeat(99_999)))],
    ])("refuses %s", (_, files) => {
        expect(() => normalizeRuleFiles(files)).toThrow();
    });
});
