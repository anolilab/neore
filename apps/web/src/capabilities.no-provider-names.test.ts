import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * UI code reads what a runner can do through `@neore/ai/capabilities` and never
 * from the name of a provider, model family or agent (plans/provider-capabilities.md §6, §8).
 * The scanned set is every file that imports the capabilities subpath, plus the folders
 * where the gated controls and their hooks live, so a control that forgets the import is still checked.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const IMPORT_SCANNED_ROOTS = ["apps/web/src/features", "packages/chat-ui/src"];
const ALWAYS_SCANNED_ROOTS = ["apps/web/src/features/chat/thread", "apps/web/src/features/chat/core/hooks"];

/**
 * Provider, model-family and agent identifiers, matched as the start of a word in any case.
 * `cursor` is only matched as the product (`cursor agent`): alone it is the text, scroll or
 * pagination cursor that these folders are full of.
 */
const PROVIDER_NAMES = [
    "anthropic",
    "claude",
    "codex",
    "copilot",
    "cursor[ -]?(?:agent|cli|ide)",
    "deepseek",
    "gemini",
    "goose",
    "gpt",
    "grok",
    "lmstudio",
    "mistral",
    "ollama",
    "openai",
    "opencode",
    "qwen",
] as const;

/** Files that may name a provider without making a capability decision, each with the reason. */
const ALLOWED_FILES: Readonly<Record<string, string>> = {
    "apps/web/src/features/chat/thread/composer-tiptap/extensions/slash-command.ts": "a model id in a comment's example of the /model command",
    "apps/web/src/features/chat/core/hooks/use-model-info.ts": "formats a model id for the token-count library; decides no capability",
};

const CAMEL_BOUNDARY_RE = /([a-z\d])([A-Z])/g;
const PROVIDER_NAME_RE = new RegExp(`(?<![a-z])(?:${PROVIDER_NAMES.join("|")})`, "gi");
const CAPABILITIES_IMPORT_RE = /from\s+["']@neore\/ai\/capabilities(?:\/[^"']*)?["']/;
const SOURCE_FILE_RE = /\.tsx?$/;
const TEST_FILE_RE = /\.(?:test|spec)\.tsx?$/;

/**
 * The provider names a source text uses, in an identifier (`isClaudeCode`, `OpenAIAdapter`), a
 * string or a comment. Read twice, as written and split at camelCase humps, because splitting
 * alone would cut `OpenAI` in two.
 */
const findProviderNames = (source: string): string[] => {
    const names = [source, source.replaceAll(CAMEL_BOUNDARY_RE, "$1 $2")].flatMap((text) =>
        [...text.matchAll(PROVIDER_NAME_RE)].map((match) => match[0].toLowerCase()),
    );

    return [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
};

const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            return entry.name === "node_modules" ? [] : walk(path);
        }

        return SOURCE_FILE_RE.test(path) && !TEST_FILE_RE.test(path) ? [path] : [];
    });

const scannedFiles = (): string[] => {
    const importing = IMPORT_SCANNED_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root))).filter((path) =>
        CAPABILITIES_IMPORT_RE.test(readFileSync(path, "utf8")),
    );
    const always = ALWAYS_SCANNED_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

    return [...new Set([...importing, ...always])].map((path) => relative(REPO_ROOT, path)).toSorted((a, b) => a.localeCompare(b));
};

describe("no provider names in capability-gated UI code", () => {
    it("scans the controls it is meant to", () => {
        const files = scannedFiles();

        expect(files).toContain("apps/web/src/features/chat/thread/composer-input.tsx");
        expect(files).toContain("apps/web/src/features/chat/thread/composer-input-area.tsx");
        expect(files).toContain("apps/web/src/features/chat/core/hooks/use-runner-capabilities.ts");
    });

    it("finds no provider or agent name in it", () => {
        const offenders = scannedFiles()
            .filter((path) => !Object.hasOwn(ALLOWED_FILES, path))
            .map((path) => {
                return { names: findProviderNames(readFileSync(join(REPO_ROOT, path), "utf8")), path };
            })
            .filter(({ names }) => names.length > 0);

        expect(offenders).toEqual([]);
    });

    it("fails on an injected provider name, in an identifier, a string or a comment", () => {
        expect(findProviderNames('const canSteer = agentName === "Claude Code";')).toEqual(["claude"]);
        expect(findProviderNames("const canSteer = isClaudeCode(agent);")).toEqual(["claude"]);
        expect(findProviderNames("if (model.startsWith('gpt-5') || runner === 'OpenAI') {}")).toEqual(["gpt", "openai"]);
        expect(findProviderNames("// ollama cannot be steered")).toEqual(["ollama"]);
        expect(findProviderNames("const x = OpenAIAdapter;")).toEqual(["openai"]);
    });

    it("recognises an import of any capabilities subpath", () => {
        expect(CAPABILITIES_IMPORT_RE.test('import { x } from "@neore/ai/capabilities";')).toBe(true);
        expect(CAPABILITIES_IMPORT_RE.test("import type { x } from '@neore/ai/capabilities/rules';")).toBe(true);
        expect(CAPABILITIES_IMPORT_RE.test('import { x } from "@neore/ai/models";')).toBe(false);
    });

    it("lets a text or pagination cursor through, and catches the agent", () => {
        expect(findProviderNames('const c = "cursor-pointer"; const cursorPosition = 1; const next = { cursor: null, endCursor: 2 };')).toEqual([]);
        expect(findProviderNames("const agent = 'Cursor Agent';")).toEqual(["cursor agent"]);
    });

    it("names a reason for every allowed file, and each one still exists", () => {
        for (const [path, reason] of Object.entries(ALLOWED_FILES)) {
            expect(reason).not.toBe("");
            expect(scannedFiles()).toContain(path);
        }
    });
});
