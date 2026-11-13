import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { ParserOptions, types } from "@babel/core";
import { parseSync, transformSync } from "@babel/core";
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
const COMPONENT_NAME = /^[A-Z]/u;

/**
 * Hooks the compiler still skips, as `file#name`, by the top-level declaration that holds them: an edit that moves them
 * down the file does not change the list. A new bail-out fails the test, and so does one that is fixed and still listed
 * here. The voice hooks write and pass refs while rendering (`callbacks.current`, the session made in a `useState`
 * initializer).
 */
const KNOWN_BAILOUTS = ["src/voice/use-dictation.ts#useDictation", "src/voice/use-dictation.ts#useOnDeviceVoiceInput", "src/voice/use-voice-input.ts#useVoiceInput"];

/** Run under every screen, so a skip here costs every screen; checked for a compiled result like the screens. */
const MUST_COMPILE = ["src/auth/auth-context.tsx#AuthProvider", "src/offline/offline-provider.tsx#OfflineProvider", "src/offline/use-host-statuses.ts#useHostStatuses"];

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
    /** `file#name` of each top-level declaration whose function the compiler skipped, with its reason. */
    bailouts: Map<string, string>;
    /** `file#name` of each top-level declaration the compiler compiled a function of. */
    compiled: string[];
    /** `file#name` of each top-level component: a function whose name starts with a capital. */
    components: string[];
}

const reasonOf = (event: CompileEvent): string => {
    const detail = event.detail as string | { options?: { reason?: string }; reason?: string } | undefined;

    if (typeof detail === "string") {
        return detail;
    }

    return detail?.options?.reason ?? detail?.reason ?? event.kind;
};

/** The name a top-level statement declares: a function, a `const` holding one, or `default` for an anonymous export. */
const declaredName = (statement: types.Statement): string | undefined => {
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement;

    if (declaration?.type === "FunctionDeclaration") {
        return declaration.id?.name ?? "default";
    }

    if (declaration?.type === "VariableDeclaration") {
        const [first] = declaration.declarations;

        return first?.id.type === "Identifier" ? first.id.name : undefined;
    }

    return statement.type === "ExportDefaultDeclaration" ? "default" : undefined;
};

/** Whether a top-level statement declares a component: a function, or a `const` holding one, named with a capital. */
const isComponent = (statement: types.Statement): boolean => {
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement;
    const name = declaredName(statement);

    if (name === undefined || !COMPONENT_NAME.test(name)) {
        return false;
    }

    if (declaration?.type === "FunctionDeclaration") {
        return true;
    }

    const init = declaration?.type === "VariableDeclaration" ? declaration.declarations[0]?.init : undefined;

    return init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression";
};

/** The top-level declaration that holds `line`: the component or hook a reported location belongs to. */
const enclosingName = (statements: ReadonlyArray<types.Statement>, line: number | undefined): string => {
    const holder = statements.find((statement) => line !== undefined && statement.loc !== null && statement.loc !== undefined && statement.loc.start.line <= line && line <= statement.loc.end.line);

    return (holder && declaredName(holder)) ?? `line ${line ?? "?"}`;
};

const compile = (file: string): CompileResult => {
    const result: CompileResult = { bailouts: new Map(), compiled: [], components: [] };
    const source = readFileSync(file, "utf8");
    const options = {
        babelrc: false,
        configFile: false,
        filename: file,
        parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] } satisfies ParserOptions,
    };
    const statements = parseSync(source, options)?.program.body ?? [];

    result.components = statements.filter((statement) => isComponent(statement)).map((statement) => `${relative(appRoot, file)}#${declaredName(statement) ?? ""}`);
    const logger = {
        logEvent: (_filename: string | null, event: CompileEvent) => {
            if (event.kind === "CompileSuccess") {
                result.compiled.push(`${relative(appRoot, file)}#${enclosingName(statements, event.fnLoc?.start.line)}`);
            } else if (event.kind === "CompileError" || event.kind === "PipelineError") {
                result.bailouts.set(`${relative(appRoot, file)}#${enclosingName(statements, event.fnLoc?.start.line)}`, reasonOf(event));
            }
        },
    };

    transformSync(source, { ...options, code: false, plugins: [[reactCompiler, { logger, panicThreshold: "none", target: "19" }]] });

    return result;
};

const results = [...sourceFiles(join(appRoot, "app")), ...sourceFiles(join(appRoot, "src"))].map((file) => compile(file));
const bailouts = new Map(results.flatMap((result) => [...result.bailouts]));
const compiled = new Set(results.flatMap((result) => result.compiled));

describe("react compiler over apps/mobile", () => {
    // A function can be left out without an error: `"use no memo"` opts it out, and nothing is logged as a failure. So
    // each one is checked for a compiled result, not only for the absence of a bail-out.
    it("compiles every screen component", () => {
        const screens = results.flatMap((result) => result.components).filter((name) => name.startsWith("app/"));

        expect(screens.length).toBeGreaterThan(5);
        expect(screens.filter((name) => !compiled.has(name))).toStrictEqual([]);
        expect(bailouts.keys().filter((name) => name.startsWith("app/")).toArray()).toStrictEqual([]);
    });

    it("compiles the providers and hooks every screen runs", () => {
        expect(MUST_COMPILE.filter((name) => !compiled.has(name))).toStrictEqual([]);
    });

    it("skips only the known hooks", () => {
        expect(bailouts.keys().toArray().toSorted((a, b) => a.localeCompare(b))).toStrictEqual(KNOWN_BAILOUTS);
    });

    it("compiles the app's components and hooks", () => {
        expect(results.reduce((count, result) => count + result.compiled.length, 0)).toBeGreaterThan(20);
    });
});
