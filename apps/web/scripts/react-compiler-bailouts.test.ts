// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The busiest chat components must stay compiled by the React Compiler. It skips a component without a word in the
 * build (a dynamically taken hook, a `try`/`finally`, …), and the component then re-renders its whole subtree on every
 * parent render. This runs the same passes as `vite.config.ts` (the Lingui macro, then the compiler for React 19) and
 * fails when one of these components is skipped again.
 */
const MUST_COMPILE: Record<string, string[]> = {
    "src/features/chat/core/context/chat-context.tsx": ["ChatProvider"],
    "src/features/chat/core/hooks/use-threads.ts": ["useThreads"],
    "src/features/chat/thread-list/hierarchical-thread-list.tsx": ["HierarchicalThreadList"],
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
