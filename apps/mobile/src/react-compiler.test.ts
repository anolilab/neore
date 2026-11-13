import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { transformSync } from "@babel/core";
import reactCompiler from "babel-plugin-react-compiler";
import { describe, expect, it } from "vitest";

/**
 * Runs the React Compiler over the app's own code, as Metro does with `experiments.reactCompiler` (`app.json`), and
 * records every component or hook it gives up on. A bail-out is silent at runtime: the function just runs unmemoised,
 * so this is the only place it shows. The usual causes are `try … finally`, a `throw` or a condition inside a `try`,
 * and a ref read or written while rendering.
 */
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILE = /\.tsx?$/u;
const NOT_COMPILED = /\.(?:test|d)\.tsx?$/u;

/**
 * Hooks the compiler still skips, each with its reason. A new bail-out fails the test, and so does one that is fixed
 * and still listed here. The voice hooks write and pass refs while rendering (`callbacks.current`, the session made in
 * a `useState` initializer).
 */
const KNOWN_BAILOUTS = ["src/voice/use-dictation.ts:32", "src/voice/use-dictation.ts:83", "src/voice/use-voice-input.ts:125"];

const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            return sourceFiles(path);
        }

        return SOURCE_FILE.test(entry.name) && !NOT_COMPILED.test(entry.name) ? [path] : [];
    });

interface CompileEvent {
    detail?: unknown;
    fnLoc?: { start: { line: number } } | null;
    fnName?: string | null;
    kind: string;
}

interface CompileResult {
    /** `file:line` of each function the compiler skipped, with its reason. */
    bailouts: Map<string, string>;
    compiled: string[];
}

const reasonOf = (event: CompileEvent): string => {
    const detail = event.detail as string | { options?: { reason?: string }; reason?: string } | undefined;

    if (typeof detail === "string") {
        return detail;
    }

    return detail?.options?.reason ?? detail?.reason ?? event.kind;
};

const compile = (file: string): CompileResult => {
    const result: CompileResult = { bailouts: new Map(), compiled: [] };
    const logger = {
        logEvent: (_filename: string | null, event: CompileEvent) => {
            if (event.kind === "CompileSuccess") {
                result.compiled.push(event.fnName ?? "<anonymous>");
            } else if (event.kind === "CompileError" || event.kind === "PipelineError") {
                result.bailouts.set(`${relative(appRoot, file)}:${event.fnLoc?.start.line ?? "?"}`, reasonOf(event));
            }
        },
    };

    transformSync(readFileSync(file, "utf8"), {
        babelrc: false,
        code: false,
        configFile: false,
        filename: file,
        parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
        plugins: [[reactCompiler, { logger, panicThreshold: "none", target: "19" }]],
    });

    return result;
};

const results = [...sourceFiles(join(appRoot, "app")), ...sourceFiles(join(appRoot, "src"))].map((file) => compile(file));
const bailouts = new Map(results.flatMap((result) => [...result.bailouts]));

describe("react compiler over apps/mobile", () => {
    it("compiles every screen", () => {
        const screens = [...bailouts].filter(([location]) => location.startsWith("app/"));

        expect(screens).toStrictEqual([]);
    });

    it("skips only the known hooks", () => {
        expect(bailouts.keys().toArray().toSorted((a, b) => a.localeCompare(b))).toStrictEqual(KNOWN_BAILOUTS);
    });

    it("compiles the app's components and hooks", () => {
        expect(results.reduce((count, result) => count + result.compiled.length, 0)).toBeGreaterThan(20);
    });
});
