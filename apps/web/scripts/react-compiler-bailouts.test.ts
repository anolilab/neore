// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import reactCompilerOptions from "../react-compiler-options";

/**
 * The busiest chat components must stay compiled by the React Compiler. It skips a component without a word in the
 * build (a dynamically taken hook, a `try`/`finally`, …), and the component then re-renders its whole subtree on every
 * parent render. The build lowers the Lingui macro with Babel, then runs the compiler's native port with
 * `react-compiler-options.ts`; this runs that, and the Babel compiler Storybook still uses, and fails when either skips
 * one of these components.
 */
const MUST_COMPILE: Record<string, string[]> = {
    "src/components/model-picker/model-picker.tsx": ["ModelPicker", "ModelRow", "ModelGroupRenderer"],
    "src/features/auth/components/organization/organization-switcher.tsx": ["OrganizationSwitcher"],
    "src/features/auth/components/team/team-switcher.tsx": ["TeamSwitcher"],
    "src/features/chat/core/context/chat-context.tsx": ["ChatProvider"],
    "src/features/chat/core/hooks/use-threads.ts": ["useThreads"],
    "src/features/chat/thread-list/hierarchical-thread-list.tsx": ["HierarchicalThreadList"],
    "src/features/chat/thread-list/hooks/use-thread-groups.ts": ["useThreadGroups"],
    "src/features/chat/thread-list/thread-list-header.tsx": ["ThreadListHeader"],
    "src/features/chat/thread-list/thread-list.tsx": ["ThreadList"],
    "src/features/chat/thread/thread.tsx": ["ThreadContent"],
};

type CompilerEvent = { detail?: { options?: { reason?: string }; reason?: string }; fnLoc?: { start: { line: number } }; kind: string };

type BabelCore = {
    transformSync: (code: string, options: Record<string, unknown>) => unknown;
};

const webRoot = resolve(import.meta.dirname, "..");
const requireFromWeb = createRequire(resolve(webRoot, "package.json"));
// `@babel/core` is the one `@rolldown/plugin-babel` runs the passes with in the build.
const babel = createRequire(requireFromWeb.resolve("@rolldown/plugin-babel"))("@babel/core") as BabelCore;
const compilerPlugin = requireFromWeb.resolve("babel-plugin-react-compiler");
const linguiMacroPlugin = requireFromWeb.resolve("@lingui/babel-plugin-lingui-macro");

type NativeDiagnostic = { labels: { end: number; start: number }[]; message: string; severity: string };

type NativeCompiler = {
    transformSync: (filename: string, code: string, options: Record<string, unknown>) => { code: string; errors: NativeDiagnostic[]; fatal: boolean };
};

// The compiler's native port, as `react({ compiler })` loads it in the build.
const nativeCompiler = requireFromWeb("oxc-transform-react") as NativeCompiler;

/** The build's passes: Babel lowers the Lingui macro, then the native port compiles with the build's options. */
type NativeResult = { code: string; diagnostics: NativeDiagnostic[]; fatal: boolean; lowered: string };

const compileNativeSource = (filename: string, source: string): NativeResult => {
    const lowered = babel.transformSync(source, {
        babelrc: false,
        configFile: false,
        cwd: webRoot,
        filename,
        parserOpts: { plugins: filename.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
        plugins: [linguiMacroPlugin],
        sourceType: "module",
    }) as { code: string };
    const result = nativeCompiler.transformSync(filename, lowered.code, {
        jsx: { runtime: "automatic" },
        reactCompiler: { ...reactCompilerOptions, reportDiagnostics: true },
    });

    return { code: result.code, diagnostics: result.errors, fatal: result.fatal, lowered: lowered.code };
};

const compileNative = (file: string): NativeResult => {
    const filename = resolve(webRoot, file);

    return compileNativeSource(filename, readFileSync(filename, "utf8"));
};

const TOP_LEVEL_DECLARATION_RE = /^(?:export )?(?:default )?(?:const|let|function|class|type|interface|enum)\s/u;

/**
 * Where `name` is declared in `source`, up to the next top-level declaration, as UTF-8 byte offsets: the native
 * compiler's diagnostic labels count bytes, so any non-ASCII text earlier in the file would shift character offsets.
 */
const declarationRange = (source: string, name: string): { end: number; start: number } => {
    const lines = source.split("\n");
    const first = lines.findIndex((line: string) => new RegExp(String.raw`^(?:export )?(?:const|function)\s+${name}\b`).test(line));

    if (first === -1) {
        throw new Error(`${name} is not declared`);
    }

    const next = lines.findIndex((line: string, index: number) => index > first && TOP_LEVEL_DECLARATION_RE.test(line));
    const offsetOf = (line: number): number => lines.slice(0, line).reduce((sum: number, text: string) => sum + Buffer.byteLength(text) + 1, 0);

    return { end: next === -1 ? Buffer.byteLength(source) : offsetOf(next), start: offsetOf(first) };
};

/**
 * The compiler errors that concern `name`: an error located inside its declaration, or one with no location at all
 * (it cannot be ruled out). Warnings and advice are not bail-outs.
 */
const errorsIn = (diagnostics: NativeDiagnostic[], source: string, name: string): string[] => {
    const { end, start } = declarationRange(source, name);

    return diagnostics
        .filter(
            (diagnostic: NativeDiagnostic) =>
                diagnostic.severity === "Error" &&
                (diagnostic.labels.length === 0 || diagnostic.labels.some((label: { start: number }) => label.start >= start && label.start < end)),
        )
        .map((diagnostic: NativeDiagnostic) => diagnostic.message);
};

/** Whether `name` is compiled in the port's output: a compiled function opens with its memo cache, `const $ = _c(n)`. */
const isCompiledIn = (output: string, name: string): boolean => {
    const lines = output.split("\n");
    const start = lines.findIndex((line: string) => new RegExp(String.raw`^(?:export )?(?:const|function)\s+${name}\b`).test(line));

    return start !== -1 && lines.slice(start, start + 3).some((line: string) => line.includes("_c("));
};

const compile = (file: string): { code: string; events: CompilerEvent[] } => {
    const filename = resolve(webRoot, file);
    const code = readFileSync(filename, "utf8");
    const events: CompilerEvent[] = [];

    babel.transformSync(code, {
        babelrc: false,
        configFile: false,
        cwd: webRoot,
        filename,
        parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
        plugins: [linguiMacroPlugin],
        presets: [
            () => {
                return {
                    plugins: [
                        [
                            compilerPlugin,
                            {
                                logger: {
                                    logEvent: (_filename: string, event: CompilerEvent) => {
                                        events.push(event);
                                    },
                                },
                                target: "19",
                            },
                        ],
                    ],
                };
            },
        ],
        sourceType: "module",
    });

    return { code, events };
};

/** The line a component or hook is declared on (`const Name = …` or `function Name(`). */
const declarationLine = (code: string, name: string): number => {
    const index = code.split("\n").findIndex((line: string) => new RegExp(String.raw`(?:const|function)\s+${name}\b`).test(line));

    if (index === -1) {
        throw new Error(`${name} is not declared`);
    }

    return index + 1;
};

describe("react Compiler coverage of the chat components", () => {
    it.each(Object.entries(MUST_COMPILE))(
        "compiles every listed component in %s",
        (file: string, names: string[]) => {
            const { code, events } = compile(file);

            for (const name of names) {
                // The compiler reports a function where it starts, which is below the declaration when a type annotation spans lines.
                const line = Math.min(
                    ...events.map((event: CompilerEvent) => event.fnLoc?.start.line ?? 0).filter((start: number) => start >= declarationLine(code, name)),
                );
                const ownEvents = events.filter((event: CompilerEvent) => event.fnLoc?.start.line === line);
                const reasons = ownEvents
                    .filter((event: CompilerEvent) => event.kind === "CompileError" || event.kind === "PipelineError")
                    .map((event: CompilerEvent) => event.detail?.options?.reason ?? event.detail?.reason ?? event.kind);

                expect({ name, reasons }).toStrictEqual({ name, reasons: [] });
                expect(
                    ownEvents.some((event: CompilerEvent) => event.kind === "CompileSuccess"),
                    `${name} was not compiled`,
                ).toBe(true);
            }
        },
        60_000,
    );
});

describe("react Compiler coverage of the chat components, as the build compiles them", () => {
    it.each(Object.entries(MUST_COMPILE))(
        "compiles every listed component in %s with the native port",
        (file: string, names: string[]) => {
            const { code, diagnostics, fatal, lowered } = compileNative(file);

            // A fatal result emits no code: fail with its reasons rather than as "not compiled".
            expect({ fatal, messages: fatal ? diagnostics.map((diagnostic: NativeDiagnostic) => diagnostic.message) : [] }).toStrictEqual({
                fatal: false,
                messages: [],
            });

            for (const name of names) {
                expect({ errors: errorsIn(diagnostics, lowered, name), name }).toStrictEqual({ errors: [], name });
                expect(isCompiledIn(code, name), `${name} was not compiled`).toBe(true);
            }
        },
        60_000,
    );
});

describe("the native coverage check's own location of errors", () => {
    it("finds an error at the end of a component that follows non-ASCII text", () => {
        // Multibyte text before the component moves its byte offsets past its character offsets; the error sits on the
        // component's last statement, just before the next declaration, where a character-offset range would miss it.
        const source = [
            `const NOTE = "${"ünïcödé ✓ ".repeat(40)}";`,
            'import { useRef } from "react";',
            "export const Probe = () => {",
            "    const probe = useRef(0);",
            "",
            "    probe.current += 1;",
            "",
            "    return null;",
            "};",
            "export const NEXT = NOTE.length;",
            "",
        ].join("\n");
        const { diagnostics, lowered } = compileNativeSource(resolve(webRoot, "src/probe.tsx"), source);

        expect(errorsIn(diagnostics, lowered, "Probe")).toContain("Cannot access refs during render");
    });
});
