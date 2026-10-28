import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * UI code reads what a runner can do through `@neore/ai/capabilities` and never
 * from the name of a provider, model family or agent (plans/provider-capabilities.md §6, §8).
 * The files that import the capabilities subpath are the gating code; this scans them.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCANNED_ROOTS = ["apps/web/src/features", "packages/chat-ui/src"];

/** Files that may name a provider, each with the reason. Empty: no gating code needs to. */

const ALLOWED_FILES: ReadonlySet<string> = new Set<string>();

/** Provider, model-family and agent identifiers. A word match, case-insensitive; `cursor-pointer` is Tailwind, not the editor. */
const PROVIDER_NAMES = [
    "anthropic",
    "claude",
    "codex",
    "copilot",
    "cursor",
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

const PROVIDER_NAME_RE = new RegExp(String.raw`\b(?:${PROVIDER_NAMES.map((name) => (name === "cursor" ? "cursor(?!-)" : name)).join("|")})\b`, "gi");

const CAPABILITIES_IMPORT_RE = /from\s+["']@neore\/ai\/capabilities["']/;

/** The provider names a source text uses. */
const findProviderNames = (source: string): string[] => [...new Set([...source.matchAll(PROVIDER_NAME_RE)].map((match) => match[0].toLowerCase()))];

const SOURCE_FILE_RE = /\.tsx?$/;
const TEST_FILE_RE = /\.(?:test|spec)\.tsx?$/;

const isGatingSource = (path: string): boolean => SOURCE_FILE_RE.test(path) && !TEST_FILE_RE.test(path);

const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            return entry.name === "node_modules" ? [] : walk(path);
        }

        return isGatingSource(path) ? [path] : [];
    });

const gatingFiles = (): string[] =>
    SCANNED_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root))).filter((path) => CAPABILITIES_IMPORT_RE.test(readFileSync(path, "utf8")));

describe("no provider names in capability-gated UI code", () => {
    it("finds the gating code it is meant to scan", () => {
        const names = gatingFiles().map((path) => relative(REPO_ROOT, path));

        expect(names).toContain("apps/web/src/features/chat/thread/composer-input-area.tsx");
        expect(names).toContain("apps/web/src/features/chat/core/hooks/use-runner-capabilities.ts");
    });

    it("finds no provider or agent name in it", () => {
        const offenders = gatingFiles()
            .map((path) => relative(REPO_ROOT, path))
            // eslint-disable-next-line sonarjs/no-empty-collection -- the allowlist is part of the contract; it is empty today
            .filter((path) => !ALLOWED_FILES.has(path))
            .map((path) => {
                return { names: findProviderNames(readFileSync(join(REPO_ROOT, path), "utf8")), path };
            })
            .filter(({ names }) => names.length > 0);

        expect(offenders).toEqual([]);
    });

    it("fails on an injected provider name", () => {
        const injected = `import { followUpControl } from "@neore/ai/capabilities";\nconst canSteer = agentName === "Claude Code" || followUpControl(report) === "steer";`;

        expect(CAPABILITIES_IMPORT_RE.test(injected)).toBe(true);
        expect(findProviderNames(injected)).toEqual(["claude"]);
    });

    it("matches a name as a word, not inside another one", () => {
        expect(findProviderNames("const cursorPosition = 1; const gptq = 2; const c = 'cursor-pointer';")).toEqual([]);
        expect(findProviderNames("if (model.startsWith('gpt-5') || runner === 'OpenAI') {}")).toEqual(["gpt", "openai"]);
    });
});
