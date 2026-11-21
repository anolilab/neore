import { describe, expect, it } from "vitest";

import { importRuleFiles, needsMode, toImportedRuleFile } from "./rule-file-import";

describe("toImportedRuleFile", () => {
    it.each(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "repo/claude.md"])("imports %s whole as one always file under its own name", (path) => {
        const text = "---\ndescription: kept as text\n---\nBe brief.";

        expect(toImportedRuleFile(path, text)).toStrictEqual({
            content: text,
            description: "",
            mode: "always",
            patterns: "",
            title: path.split("/").at(-1),
        });
    });

    it("takes a folder file's mode from its front matter and drops the front matter from its text", () => {
        expect(toImportedRuleFile("rules/sql.mdc", '---\nglobs: ["**/*.sql", db/*.ts]\n---\nSnake case.')).toStrictEqual({
            content: "Snake case.",
            description: "",
            mode: "glob",
            patterns: "**/*.sql\ndb/*.ts",
            title: "sql",
        });
        expect(toImportedRuleFile("rules/list.md", "---\nglobs:\n  - a/*.md\n  - b/*.md\n---\nText")).toMatchObject({
            mode: "glob",
            patterns: "a/*.md\nb/*.md",
        });
        expect(toImportedRuleFile("rules/deploy.md", '---\ndescription: "How to deploy"\n---\nSteps.')).toMatchObject({
            description: "How to deploy",
            mode: "auto",
        });
        expect(toImportedRuleFile("rules/base.md", "---\ndescription: Base\nalwaysApply: true\n---\nAll.")).toMatchObject({ content: "All.", mode: "always" });
    });

    it("applies a file to every chat only when its front matter says so, and leaves one that says nothing for the person to set", () => {
        const plain = toImportedRuleFile("rules/plain.md", "No front matter.");

        expect(plain).toMatchObject({ content: "No front matter.", description: "", mode: "auto", title: "plain" });
        expect(needsMode(plain!)).toBe(true);
        expect(toImportedRuleFile("rules/empty.md", "---\n---\nBody.")).toMatchObject({ content: "Body.", description: "", mode: "auto" });
        expect(toImportedRuleFile("rules/odd.md", "---\nalwaysApply: sometimes\n---\nBody.")).toMatchObject({ mode: "auto" });
        // A comment after the value is not part of it.
        expect(toImportedRuleFile("rules/manual.md", "---\nalwaysApply: false # on request\n---\nBody.")).toMatchObject({ description: "", mode: "auto" });
        expect(toImportedRuleFile("rules/all.md", "---\nalwaysApply: true # every chat\n---\nBody.")).toMatchObject({ mode: "always" });
        expect(toImportedRuleFile("rules/both.md", "---\nalwaysApply: true\nglobs: *.ts\n---\nBody.")).toMatchObject({ mode: "always" });
        // Quoted or not, in any case, `true` and `false` mean what they say; nothing else applies a file to every chat.
        expect(toImportedRuleFile("rules/q.md", '---\nalwaysApply: "True"\n---\nBody.')).toMatchObject({ mode: "always" });
        expect(toImportedRuleFile("rules/q.md", "---\nalwaysApply: 'true'\n---\nBody.")).toMatchObject({ mode: "always" });
        expect(toImportedRuleFile("rules/q.md", '---\ndescription: On deploys\nalwaysApply: "false"\n---\nBody.')).toMatchObject({
            description: "On deploys",
            mode: "auto",
        });
        expect(toImportedRuleFile("rules/q.md", "---\nalwaysApply: FALSE\n---\nBody.")).toMatchObject({ mode: "auto" });
        expect(toImportedRuleFile("rules/q.md", '---\nalwaysApply: "yes"\n---\nBody.')).toMatchObject({ mode: "auto" });
        expect(needsMode({ description: "How to deploy", mode: "auto" })).toBe(false);
    });

    it("reads quoted values, comments, and values that continue on the next lines", () => {
        expect(toImportedRuleFile("rules/q.md", '---\ndescription: "Tags # not a comment" # but this is\n---\nB')).toMatchObject({
            description: "Tags # not a comment",
            mode: "auto",
        });
        // Escaped quotes stay inside the value, read as the quote they stand for.
        expect(toImportedRuleFile("rules/q.md", '---\ndescription: "Use \\"quoted\\" # headings" # note\n---\nB')).toMatchObject({
            description: 'Use "quoted" # headings',
        });
        expect(toImportedRuleFile("rules/q.md", "---\ndescription: 'It''s # one' # note\n---\nB")).toMatchObject({ description: "It's # one" });
        expect(toImportedRuleFile("rules/folded.md", "---\ndescription: >-\n  Long text\n  over lines\nalwaysApply: false\n---\nBody.")).toMatchObject({
            description: "Long text over lines",
            mode: "auto",
        });
        expect(toImportedRuleFile("rules/literal.md", "---\ndescription: |\n  First\n\n  Second\n---\nBody.")).toMatchObject({
            description: "First Second",
            mode: "auto",
        });
        expect(toImportedRuleFile("rules/plain-cont.md", "---\ndescription: When the task\n  touches billing\n# note\n---\nBody.")).toMatchObject({
            description: "When the task touches billing",
            mode: "auto",
        });
    });

    it("takes brackets as a list only around the whole value, so a pattern keeps its character class", () => {
        expect(toImportedRuleFile("rules/c.mdc", "---\nglobs: src/[ab]\n---\nT")).toMatchObject({ patterns: "src/[ab]" });
        expect(toImportedRuleFile("rules/c.mdc", "---\nglobs: [src/[ab]/*.ts, docs/**]\n---\nT")).toMatchObject({ patterns: "src/[ab]/*.ts\ndocs/**" });
    });

    it("keeps a brace group's commas inside its pattern", () => {
        expect(toImportedRuleFile("rules/ts.mdc", "---\nglobs: **/*.{ts,tsx}, docs/**\n---\nT")).toMatchObject({
            mode: "glob",
            patterns: "**/*.{ts,tsx}\ndocs/**",
        });
        expect(toImportedRuleFile("rules/js.mdc", '---\nglobs: ["src/**/*.{js,jsx}", "b/*.md"] # web\n---\nT')).toMatchObject({
            patterns: "src/**/*.{js,jsx}\nb/*.md",
        });
        expect(toImportedRuleFile("rules/list.mdc", '---\nglobs:\n  - "**/*.{ts,tsx}" # code\n  - a/*.md\n---\nT')).toMatchObject({
            patterns: "**/*.{ts,tsx}\na/*.md",
        });
    });

    it("splits a quoted list of patterns, reads a block of them line by line, and takes an apostrophe as text", () => {
        expect(toImportedRuleFile("rules/q.mdc", '---\nglobs: "**/*.ts, **/*.tsx"\n---\nT')).toMatchObject({ patterns: "**/*.ts\n**/*.tsx" });
        expect(toImportedRuleFile("rules/b.mdc", "---\nglobs: |\n  a/**\n  b/*.{md,mdx}\n---\nT")).toMatchObject({ patterns: "a/**\nb/*.{md,mdx}" });
        expect(toImportedRuleFile("rules/a.md", "---\ndescription: For the user's settings # owner note\n---\nT")).toMatchObject({
            description: "For the user's settings",
            mode: "auto",
        });
    });

    it("reads front matter after a byte-order mark", () => {
        expect(toImportedRuleFile("rules/bom.md", "\u{FEFF}---\nglobs: *.ts\n---\nTyped.")).toMatchObject({
            content: "Typed.",
            mode: "glob",
            patterns: "*.ts",
        });
    });

    it.each([
        ["after blank lines", "\n  \n---\nglobs: *.ts\n---\nTyped."],
        ["with spaces after its fences", "--- \nglobs: *.ts\n---\t \nTyped."],
        ["with CRLF line endings", "---\r\nglobs: *.ts\r\n---\r\nTyped."],
    ])("reads front matter %s", (_case, text) => {
        expect(toImportedRuleFile("rules/spaced.md", text)).toStrictEqual({
            content: "Typed.",
            description: "",
            mode: "glob",
            patterns: "*.ts",
            title: "spaced",
        });
    });

    it("keeps a text that opens with blank lines and a rule whole when no setting follows", () => {
        const text = "\n\n---\n\nIntro.\n\n---\n\nBody";

        expect(toImportedRuleFile("rules/ruled.md", text)).toMatchObject({ content: text, mode: "auto" });
    });

    it("reads a file that never applies by itself as one read when needed", () => {
        expect(toImportedRuleFile("rules/manual.md", "---\nalwaysApply: false\n---\nOnly on request.")).toMatchObject({ description: "", mode: "auto" });
    });

    it("leaves out a file that is not Markdown", () => {
        expect(toImportedRuleFile("rules/logo.png", "png")).toBeNull();
    });
});

describe("importRuleFiles", () => {
    it("imports in path order up to the room left and counts the rest", async () => {
        const files = [new File(["B"], "b.md"), new File(["A"], "a.md"), new File(["x"], "x.txt"), new File(["C"], "c.md")];

        await expect(importRuleFiles(files, 2)).resolves.toStrictEqual({
            imported: [
                { content: "A", description: "", mode: "auto", patterns: "", title: "a" },
                { content: "B", description: "", mode: "auto", patterns: "", title: "b" },
            ],
            skipped: 1,
        });
    });
});
