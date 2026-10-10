import { describe, expect, it } from "vitest";

import type { SkillMarkdownData } from "./markdown";
import {
    classifySkillFile,
    locateSkillInArchive,
    normalizeSkillFilePath,
    parseFrontmatterYaml,
    parseSkillMarkdown,
    SKILL_IMPORT_LIMITS,
    skillFileBytes,
    skillToMarkdown,
    validateSkillFiles,
} from "./markdown";

const FULL_SKILL: SkillMarkdownData = {
    category: "research",
    config: {
        additionalTools: ["webSearch", "knowledgeSearch"],
        disabledTools: ["imageGeneration"],
        preferredModel: "anthropic/claude-sonnet-5",
        reasoningEffort: 2,
        searchMode: "deep",
    },
    description: "Summarise a paper: key claims, methods, and caveats. Use when: the user shares a PDF or arXiv link.",
    icon: "📄",
    instructions: "# Paper summary\n\n1. Read the abstract.\n2. List the claims for {{AUDIENCE}}.\n\n---\n\nNever invent citations.",
    name: "Paper Summary: Deep",
    slug: "paper-summary",
    tags: ["papers", "summaries"],
    variables: [{ defaultValue: "engineers", description: "Who reads it", name: "AUDIENCE", required: true }],
    version: "1.2.0",
};

const expectOk = (markdown: string) => {
    const result = parseSkillMarkdown(markdown);

    if (!result.ok) {
        throw new Error(`expected a parse, got: ${result.errors.join("; ")}`);
    }

    return result;
};

describe(skillToMarkdown, () => {
    it("round-trips every field it carries", () => {
        const { skill, warnings } = expectOk(skillToMarkdown(FULL_SKILL));

        expect(warnings).toEqual([]);
        expect(skill).toEqual(FULL_SKILL);
    });

    it("round-trips a minimal skill without inventing fields", () => {
        const minimal: SkillMarkdownData = { description: "Does one thing.", instructions: "Do it.", name: "One Thing", slug: "one-thing" };
        const markdown = skillToMarkdown(minimal);

        expect(markdown).not.toContain("allowed-tools");
        expect(markdown).not.toContain("model:");
        expect(expectOk(markdown).skill).toEqual(minimal);
    });

    it("writes the Agent Skills shape: name is the identifier, extras live under metadata as strings", () => {
        const markdown = skillToMarkdown(FULL_SKILL);
        const frontmatter = parseFrontmatterYaml(markdown.split("---", 2)[1]!);

        expect(frontmatter.name).toBe("paper-summary");
        expect(frontmatter["allowed-tools"]).toBe("webSearch knowledgeSearch");
        expect(frontmatter.model).toBe("anthropic/claude-sonnet-5");

        const metadata = frontmatter.metadata as Record<string, string>;

        expect(Object.values(metadata).every((value) => typeof value === "string")).toBe(true);
        expect(metadata["display-name"]).toBe("Paper Summary: Deep");
    });

    it("quotes values YAML would otherwise read as something else", () => {
        const tricky: SkillMarkdownData = {
            description: "yes",
            instructions: "x",
            name: "- starts: with a dash # and a comment",
            slug: "tricky",
            version: "2",
        };

        expect(expectOk(skillToMarkdown(tricky)).skill).toEqual(tricky);
    });
});

describe(parseSkillMarkdown, () => {
    it("reads a SKILL.md written for Claude", () => {
        const { skill } = expectOk(
            [
                "---",
                "name: pdf-processing",
                "description: >-",
                "  Extract text and tables from PDF files.",
                "  Use when working with PDFs.",
                "license: Apache-2.0",
                "allowed-tools: Read Grep Bash(python:*)",
                "metadata:",
                "  author: example-org",
                '  version: "1.0"',
                "---",
                "",
                "# PDF Processing",
                "",
                "Use pdfplumber.",
            ].join("\n"),
        );

        expect(skill.slug).toBe("pdf-processing");
        expect(skill.name).toBe("Pdf Processing");
        expect(skill.description).toBe("Extract text and tables from PDF files. Use when working with PDFs.");
        expect(skill.config?.additionalTools).toEqual(["Read", "Grep", "Bash(python:*)"]);
        expect(skill.version).toBe("1.0");
        expect(skill.instructions).toBe("# PDF Processing\n\nUse pdfplumber.");
    });

    it("accepts `tools` as a list and a display name in `name`", () => {
        const { skill } = expectOk(
            ["---", "name: My Helper", "description: 'It''s helpful'", "tools:", "  - webSearch", "  - codeExecution", "---", "Body"].join("\n"),
        );

        expect(skill.slug).toBe("my-helper");
        expect(skill.name).toBe("My Helper");
        expect(skill.description).toBe("It's helpful");
        expect(skill.config?.additionalTools).toEqual(["webSearch", "codeExecution"]);
    });

    it("keeps a literal block scalar's newlines", () => {
        const { skill } = expectOk(["---", "name: a", "description: |", "  line one", "  line two", "---", "b"].join("\r\n"));

        expect(skill.description).toBe("line one\nline two");
    });

    it("refuses a file with no frontmatter, or without name and description", () => {
        expect(parseSkillMarkdown("# Just markdown").ok).toBe(false);

        const missing = parseSkillMarkdown("---\nlicense: MIT\n---\nbody");

        expect(missing).toEqual({ errors: ["Field 'name' is required", "Field 'description' is required"], ok: false });
    });

    it("enforces the size caps", () => {
        const long = parseSkillMarkdown(`---\nname: a\ndescription: b\n---\n${"x".repeat(SKILL_IMPORT_LIMITS.instructions + 1)}`);

        expect(long.ok).toBe(false);

        const huge = parseSkillMarkdown(`---\nname: a\ndescription: b\n---\n${"x".repeat(SKILL_IMPORT_LIMITS.markdownBytes)}`);

        expect(huge.ok).toBe(false);

        const description = parseSkillMarkdown(`---\nname: a\ndescription: ${"d".repeat(SKILL_IMPORT_LIMITS.description + 1)}\n---\nbody`);

        expect(description.ok).toBe(false);
    });

    it("drops unusable optional fields with a warning instead of failing", () => {
        const result = expectOk(["---", "name: a", "description: b", "metadata:", "  reasoning-effort: 9", "  variables: not json", "---", "body"].join("\n"));

        expect(result.skill.config).toBeUndefined();
        expect(result.skill.variables).toBeUndefined();
        expect(result.warnings).toHaveLength(2);
    });
});

describe("additional files", () => {
    it("classifies by the spec's directories, then by extension", () => {
        expect(classifySkillFile("scripts/run.txt")).toBe("script");
        expect(classifySkillFile("references/api.md")).toBe("reference");
        expect(classifySkillFile("assets/template.md")).toBe("asset");
        expect(classifySkillFile("helper.py")).toBe("script");
        expect(classifySkillFile("notes.md")).toBe("reference");
        expect(classifySkillFile("logo.png")).toBe("asset");
    });

    it("refuses paths that escape the skill or are OS litter", () => {
        expect(normalizeSkillFilePath("references/../../etc/passwd")).toBeUndefined();
        expect(normalizeSkillFilePath("/abs.md")).toBeUndefined();
        expect(normalizeSkillFilePath("__MACOSX/x.md")).toBeUndefined();
        expect(normalizeSkillFilePath(".DS_Store")).toBeUndefined();
        expect(normalizeSkillFilePath(String.raw`references\api.md`)).toBe("references/api.md");
    });

    it("measures base64 content decoded", () => {
        expect(skillFileBytes({ content: "aGVsbG8=", encoding: "base64" })).toBe(5);
        expect(skillFileBytes({ content: "héllo", encoding: "utf8" })).toBe(6);
    });

    it("caps each file by type, the file count and the total", () => {
        expect(validateSkillFiles([{ content: "x", encoding: "utf8", path: "references/a.md" }])).toEqual([]);
        expect(
            validateSkillFiles([{ content: "x".repeat(SKILL_IMPORT_LIMITS.fileBytes.reference + 1), encoding: "utf8", path: "references/a.md" }]),
        ).toHaveLength(1);
        expect(validateSkillFiles([{ content: "x", encoding: "utf8", path: "../a.md" }])).toHaveLength(1);
        expect(
            validateSkillFiles(
                Array.from({ length: SKILL_IMPORT_LIMITS.files + 1 }, (_, index) => {
                    return { content: "x", encoding: "utf8" as const, path: `f${String(index)}.md` };
                }),
            ),
        ).toHaveLength(1);
        expect(
            validateSkillFiles([
                { content: "x", encoding: "utf8", path: "a.md" },
                { content: "y", encoding: "utf8", path: "a.md" },
            ]),
        ).toEqual(["Duplicate file: a.md"]);
    });

    it("finds the SKILL.md at the root or in one folder and relativises the rest", () => {
        const nested = locateSkillInArchive([{ path: "my-skill/SKILL.md" }, { path: "my-skill/references/a.md" }, { path: "__MACOSX/my-skill/._SKILL.md" }]);

        expect(nested).toEqual({ files: [{ path: "references/a.md" }], ok: true, skill: { path: "my-skill/SKILL.md" } });
        expect(locateSkillInArchive([{ path: "SKILL.md" }, { path: "scripts/x.py" }]).ok).toBe(true);
        expect(locateSkillInArchive([{ path: "a/b/SKILL.md" }]).ok).toBe(false);
        expect(locateSkillInArchive([{ path: "a/SKILL.md" }, { path: "b/SKILL.md" }]).ok).toBe(false);
    });
});
