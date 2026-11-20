/**
 * A project row carries its rule files (`ruleFiles`, up to 1 MB). A read that does not name its columns returns them, and
 * a query returning the row hands them to every client that subscribes. So every `projects` read either goes through
 * `findProjectRow` / `findProjectRows` (`project-row.ts`, every column but the rule files) or names its own `select`.
 * Only the rule-file editor and a run's setup name `ruleFiles` there, and only a writer that may replace the whole row
 * (`patchRow` removing a column rewrites every column it was given) reads it unselected. A read that budgets its cost
 * (the export) reads whole rows through `findProjectRowsMeasured`, since a `select` does not lower what it is charged.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const LUNORA_DIR = resolve(import.meta.dirname, "..");

const READ_RE = /\.projects\s*\.\s*(?:find\w*|get)\(/g;
const SELECT_RE = /\bselect\s*:/;
const RULE_FILES_RE = /["']ruleFiles["']|ruleFiles\s*&&|!ruleFiles/;
const MEASURED_RE = /\bfindProjectRowsMeasured\(/g;

/** Reads that return the whole row, by file: each one a writer that hands the row to `patchRow`. */
const WHOLE_ROW_READS: Record<string, number> = {
    // `updateProject` (the one writer of rule files) and `unpinProject`.
    "agent/projects.ts": 2,
    // `clearMachineFromProjects`.
    "projects/machine-location.ts": 1,
};

/** Reads that select `ruleFiles`, by file: the editor and a run's setup (`readableProject`) and the save's revision check (`storedRuleFiles`). */
const RULE_FILE_READS: Record<string, number> = {
    "projects/functions.ts": 2,
};

/** Whole-row reads that budget their cost, by file: the export's three passes and the usage export's titles (`readableProjectGrantsMeasured`). Each returns only the columns it picks. */
const MEASURED_READS: Record<string, number> = {
    "projects/functions.ts": 1,
    "projects/gdpr.ts": 3,
};

const sourceFiles = (directory: string, accumulator: string[] = []): string[] => {
    const entries = readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.name === "_generated" || entry.name === "node_modules") {
            continue;
        }

        const full = join(directory, entry.name);

        if (entry.isDirectory()) {
            sourceFiles(full, accumulator);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
            accumulator.push(full);
        }
    }

    return accumulator;
};

/** The argument text of the call whose `(` is at `open`, up to its matching `)`. */
const callArguments = (source: string, open: number): string => {
    let depth = 0;

    for (let index = open; index < source.length; index += 1) {
        if (source[index] === "(") {
            depth += 1;
        } else if (source[index] === ")") {
            depth -= 1;

            if (depth === 0) {
                return source.slice(open + 1, index);
            }
        }
    }

    return source.slice(open + 1);
};

const countReads = () => {
    const wholeRow: Record<string, number> = {};
    const ruleFiles: Record<string, number> = {};
    const measured: Record<string, number> = {};

    for (const file of sourceFiles(LUNORA_DIR)) {
        const name = relative(LUNORA_DIR, file);

        if (name === "projects/project-row.ts") {
            continue;
        }

        const source = readFileSync(file, "utf8");

        const measuredReads = [...source.matchAll(MEASURED_RE)].length;

        if (measuredReads > 0) {
            measured[name] = measuredReads;
        }

        for (const match of source.matchAll(READ_RE)) {
            const args = callArguments(source, match.index + match[0].length - 1);

            if (!SELECT_RE.test(args)) {
                wholeRow[name] = (wholeRow[name] ?? 0) + 1;
            } else if (RULE_FILES_RE.test(args)) {
                ruleFiles[name] = (ruleFiles[name] ?? 0) + 1;
            }
        }
    }

    return { measured, ruleFiles, wholeRow };
};

describe("project row reads", () => {
    const { measured, ruleFiles, wholeRow } = countReads();

    it("read the whole row only in a writer that replaces it", () => {
        expect(wholeRow, "read through findProjectRow / findProjectRows, or name the columns in `select`").toStrictEqual(WHOLE_ROW_READS);
    });

    it("read whole rows to measure them only in the export's budgeted reads", () => {
        expect(measured, "a measured read returns whole rows, rule files included: return only the columns it picks").toStrictEqual(MEASURED_READS);
    });

    it("select the rule files only in the editor and a run's setup", () => {
        expect(ruleFiles).toStrictEqual(RULE_FILE_READS);
    });
});
