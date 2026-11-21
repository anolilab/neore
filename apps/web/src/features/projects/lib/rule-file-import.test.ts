import { describe, expect, it } from "vitest";

import { importRuleFiles, toImportedRuleFile } from "./rule-file-import";

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
        expect(toImportedRuleFile("rules/plain.md", "No front matter.")).toMatchObject({ content: "No front matter.", mode: "always", title: "plain" });
    });

    it("reads front matter after a byte-order mark, an empty block, and leaves a block value's description to the editor", () => {
        expect(toImportedRuleFile("rules/bom.md", "\u{FEFF}---\nglobs: *.ts\n---\nTyped.")).toMatchObject({
            content: "Typed.",
            mode: "glob",
            patterns: "*.ts",
        });
        expect(toImportedRuleFile("rules/empty.md", "---\n---\nBody.")).toMatchObject({ content: "Body.", mode: "always" });
        expect(toImportedRuleFile("rules/folded.md", "---\ndescription: >-\n  Long text\nalwaysApply: false\n---\nBody.")).toMatchObject({
            description: "",
            mode: "auto",
        });
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
                { content: "A", description: "", mode: "always", patterns: "", title: "a" },
                { content: "B", description: "", mode: "always", patterns: "", title: "b" },
            ],
            skipped: 1,
        });
    });
});
