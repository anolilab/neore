import { createHighlighter } from "@tanstack/highlight/core";
import * as languages from "@tanstack/highlight/languages";
import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown";

import { resolveCodeTheme } from "./code-highlight-themes";

// Streamdown exports the plugin and its options, not the shapes it returns.
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
type HighlightToken = HighlightResult["tokens"][number][number];

/**
 * Streamdown's code-block highlighter, on TanStack Highlight instead of Shiki.
 *
 * Shiki's bundle is every grammar and theme it ships (~230 languages, 8 MiB of source in
 * the server build alone) behind one `import()` each; this is ~40 languages in ~11 KB. The
 * trade is coverage and precision: it is "a deliberately small docs highlighter", not a
 * TextMate engine, so a language it does not know renders as plain text, which Streamdown
 * does for any `supportsLanguage` that answers `false`.
 *
 * Streamdown reads a token's `color` as the light colour and `--shiki-dark` from its
 * `htmlStyle` as the dark one (the root's from `rootStyle`), and switches with `dark:`
 * classes. Emitting that same shape keeps dark mode, the Appearance picker and stored
 * preferences working with no CSS of ours.
 *
 * Synchronous, so the callback is never used, and SSR renders highlighted code where
 * Shiki answered `null` until its grammar had loaded.
 */

const highlighter = createHighlighter({ fallbackLanguage: "plaintext", languages: Object.values(languages) });

const SUPPORTED: ReadonlySet<string> = new Set(highlighter.listLanguages());

/** Aliases the highlighter does not know but a grammar it has covers well enough. */
const EXTRA_ALIASES: Readonly<Record<string, string>> = {
    c: "cpp",
    cc: "cpp",
    cjs: "js",
    cxx: "cpp",
    docker: "dockerfile",
    h: "cpp",
    hpp: "cpp",
    ini: "toml",
    jsonl: "json",
    mjs: "js",
    node: "js",
    properties: "toml",
    shellscript: "shell",
    svg: "html",
    zsh: "shell",
};

const PLAIN_NAMES: ReadonlySet<string> = new Set(["plaintext", "text", "txt"]);

const resolveLanguage = (language: string): string | undefined => {
    const lowered = language.toLowerCase();
    const normalized = highlighter.normalizeLanguage(lowered);

    if (normalized !== "plaintext") {
        return normalized;
    }

    if (PLAIN_NAMES.has(lowered)) {
        return "plaintext";
    }

    const alias = EXTRA_ALIASES[lowered];

    return alias !== undefined && SUPPORTED.has(alias) ? alias : undefined;
};

const CACHE_LIMIT = 64;
const cache = new Map<string, HighlightResult>();

const toLines = (
    tokens: ReadonlyArray<{ className?: string; value: string }>,
    color: (className: string | undefined) => string,
    darkColor: (className: string | undefined) => string,
) => {
    const lines: HighlightToken[][] = [[]];

    for (const { className, value } of tokens) {
        const parts = value.split("\n");

        for (const [index, part] of parts.entries()) {
            if (index > 0) {
                lines.push([]);
            }

            if (part !== "") {
                lines.at(-1)?.push({ color: color(className), content: part, htmlStyle: { "--shiki-dark": darkColor(className) } });
            }
        }
    }

    return lines;
};

const highlight = ({ code, isIncomplete, language, themes }: HighlightOptions): HighlightResult | null => {
    const resolved = resolveLanguage(language);

    if (resolved === undefined) {
        return null;
    }

    const key = `${resolved}\u{0}${String(themes[0])}\u{0}${String(themes[1])}\u{0}${code}`;
    const cached = cache.get(key);

    if (cached) {
        return cached;
    }

    const light = resolveCodeTheme(themes[0], "light");
    const dark = resolveCodeTheme(themes[1], "dark");
    const { tokens } = highlighter.tokenize(code, { lang: resolved });
    const colorIn = (theme: typeof light) => (className: string | undefined) =>
        theme.tokens[(className ?? "token") as keyof typeof theme.tokens] ?? theme.foreground;

    const result: HighlightResult = {
        bg: light.background,
        fg: light.foreground,
        rootStyle: `--shiki-dark:${dark.foreground};--shiki-dark-bg:${dark.background}`,
        tokens: toLines(tokens, colorIn(light), colorIn(dark)),
    };

    // A streaming block is superseded by its next chunk, so only a finished one is worth keeping.
    if (isIncomplete !== true) {
        cache.set(key, result);

        if (cache.size > CACHE_LIMIT) {
            cache.delete(cache.keys().next().value as string);
        }
    }

    return result;
};

export const code: CodeHighlighterPlugin = {
    getSupportedLanguages: () => [...SUPPORTED],
    getThemes: () => ["github-light", "github-dark"],
    highlight,
    name: "shiki",
    supportsLanguage: (language) => resolveLanguage(language) !== undefined,
    type: "code-highlighter",
};
