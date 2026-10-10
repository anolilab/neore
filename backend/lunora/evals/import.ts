/**
 * Eval cases from text: CSV or JSONL, parsed and validated in one place — the
 * import procedure calls this, and so do the create/update procedures through
 * {@link normalizeCaseDraft}, so a hand-made case and an imported one meet the
 * same rules.
 *
 * An import is all-or-nothing: any invalid row fails the whole file, with every
 * problem listed by line, so a half-imported dataset never has to be untangled.
 *
 * ## CSV
 *
 * RFC 4180: a header row, comma-separated, `"` quoting with `""` escapes,
 * newlines inside quoted fields. Columns (case-insensitive; `-` and `_` and
 * spaces are interchangeable):
 *
 * - `input` (required);
 * - `expected_answer` (alias `expected`), `rubric`;
 * - `expected_sources` — file names separated by `;` or `|`;
 * - one column per check kind: `exact`, `contains`, `not_contains`, `regex`,
 *   `json_schema`, `max_latency_ms`, `max_cost_usd`. An empty cell adds no check.
 *
 * An unknown column is an error rather than silently dropped data.
 *
 * ## JSONL
 *
 * One object per non-blank line: `{ input, expectedAnswer?, rubric?,
 * expectedSources?, checks?: [{ kind, value }] }`, with the CSV spellings
 * (`expected_answer`, `expected`, `expected_sources`) accepted too.
 */
import type { CheckKind, EvalCheck } from "./metrics";
import {
    CASE_EXPECTED_MAX,
    CASE_INPUT_MAX,
    CASE_RUBRIC_MAX,
    CHECK_KINDS,
    MAX_CHECKS_PER_CASE,
    MAX_EXPECTED_SOURCES,
    SOURCE_NAME_MAX,
    validateCheck,
} from "./metrics";

/** The largest file an import accepts, in characters. */
export const IMPORT_MAX_CHARS = 512_000;

/** Errors reported per import; past this the list says how many more there were. */
const MAX_REPORTED_ERRORS = 50;

export interface CaseDraft {
    checks: EvalCheck[];
    expectedAnswer?: string;
    expectedSources: string[];
    input: string;
    rubric?: string;
}

export interface ImportError {
    /** 1-based line of the row in the file (for CSV, the line the row starts on). */
    line: number;
    message: string;
}

export type ImportResult = { cases: CaseDraft[]; ok: true } | { errors: ImportError[]; ok: false };

const optionalText = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : undefined;
};

/** Splits `a; b | c` into names. */
const SOURCE_SEPARATOR_RE = /[;|]/u;

const BOM_RE = /^\u{FEFF}/u;

const LINE_BREAK_RE = /\r?\n/u;

export const splitSources = (value: string): string[] =>
    value
        .split(SOURCE_SEPARATOR_RE)
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

/**
 * Validates and trims one case. Returns every problem, so a form or an import
 * can report them all at once.
 */
export const normalizeCaseDraft = (raw: {
    checks?: ReadonlyArray<{ kind: string; value: string }>;
    expectedAnswer?: string;
    expectedSources?: ReadonlyArray<string>;
    input: string;
    rubric?: string;
}): { draft: CaseDraft; ok: true } | { errors: string[]; ok: false } => {
    const errors: string[] = [];
    const input = raw.input.trim();

    if (input.length === 0) {
        errors.push("The input is required");
    } else if (input.length > CASE_INPUT_MAX) {
        errors.push(`The input must be ${String(CASE_INPUT_MAX)} characters or less`);
    }

    const expectedAnswer = optionalText(raw.expectedAnswer);

    if (expectedAnswer && expectedAnswer.length > CASE_EXPECTED_MAX) {
        errors.push(`The expected answer must be ${String(CASE_EXPECTED_MAX)} characters or less`);
    }

    const rubric = optionalText(raw.rubric);

    if (rubric && rubric.length > CASE_RUBRIC_MAX) {
        errors.push(`The rubric must be ${String(CASE_RUBRIC_MAX)} characters or less`);
    }

    const expectedSources = [...new Set((raw.expectedSources ?? []).map((name) => name.trim()).filter((name) => name.length > 0))];

    if (expectedSources.length > MAX_EXPECTED_SOURCES) {
        errors.push(`A case can name at most ${String(MAX_EXPECTED_SOURCES)} expected sources`);
    }

    if (expectedSources.some((name) => name.length > SOURCE_NAME_MAX)) {
        errors.push(`A source name must be ${String(SOURCE_NAME_MAX)} characters or less`);
    }

    const checks = raw.checks ?? [];

    if (checks.length > MAX_CHECKS_PER_CASE) {
        errors.push(`A case can have at most ${String(MAX_CHECKS_PER_CASE)} checks`);
    }

    for (const check of checks) {
        const problem = validateCheck(check as EvalCheck);

        if (problem) {
            errors.push(problem);
        }
    }

    if (errors.length > 0) {
        return { errors, ok: false };
    }

    return {
        draft: {
            checks: checks.map((check) => {
                return { kind: check.kind as CheckKind, value: check.value };
            }),
            expectedAnswer,
            expectedSources,
            input,
            rubric,
        },
        ok: true,
    };
};

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180 rows, each with the 1-based line it starts on. Throws on an unterminated quote. */
export const parseCsvRows = (text: string): { cells: string[]; line: number }[] => {
    const rows: { cells: string[]; line: number }[] = [];
    let cells: string[] = [];
    let cell = "";
    let inQuotes = false;
    let line = 1;
    let rowLine = 1;
    let index = 0;

    const endRow = (): void => {
        cells.push(cell);

        // A blank line is not a row.
        if (!(cells.length === 1 && cells[0]!.trim() === "")) {
            rows.push({ cells, line: rowLine });
        }

        cells = [];
        cell = "";
    };

    while (index < text.length) {
        const char = text[index]!;

        if (inQuotes) {
            if (char === '"') {
                if (text[index + 1] === '"') {
                    cell += '"';
                    index += 2;
                    continue;
                }

                inQuotes = false;
            } else {
                if (char === "\n") {
                    line += 1;
                }

                cell += char;
            }

            index += 1;
            continue;
        }

        if (char === '"' && cell.length === 0) {
            inQuotes = true;
        } else if (char === ",") {
            cells.push(cell);
            cell = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[index + 1] === "\n") {
                index += 1;
            }

            endRow();
            line += 1;
            rowLine = line;
        } else {
            cell += char;
        }

        index += 1;
    }

    if (inQuotes) {
        throw new Error(`A quoted field starting on line ${String(rowLine)} is never closed`);
    }

    if (cell.length > 0 || cells.length > 0) {
        endRow();
    }

    return rows;
};

const normalizeHeader = (header: string): string =>
    header
        .trim()
        .toLowerCase()
        .replaceAll(/[\s-]+/gu, "_");

const TEXT_COLUMNS: Readonly<Record<string, "expectedAnswer" | "expectedSources" | "input" | "rubric">> = {
    expected: "expectedAnswer",
    expected_answer: "expectedAnswer",
    expected_sources: "expectedSources",
    expectedanswer: "expectedAnswer",
    expectedsources: "expectedSources",
    input: "input",
    rubric: "rubric",
};

const pushError = (errors: ImportError[], error: ImportError): void => {
    errors.push(error);
};

const finish = (cases: CaseDraft[], errors: ImportError[], maxCases: number): ImportResult => {
    if (errors.length === 0 && cases.length === 0) {
        return { errors: [{ line: 1, message: "The file has no cases" }], ok: false };
    }

    if (errors.length === 0 && cases.length > maxCases) {
        return { errors: [{ line: 1, message: `The file has ${String(cases.length)} cases; this dataset has room for ${String(maxCases)}` }], ok: false };
    }

    if (errors.length > MAX_REPORTED_ERRORS) {
        const extra = errors.length - MAX_REPORTED_ERRORS;

        return {
            errors: [...errors.slice(0, MAX_REPORTED_ERRORS), { line: errors[MAX_REPORTED_ERRORS]!.line, message: `…and ${String(extra)} more` }],
            ok: false,
        };
    }

    return errors.length > 0 ? { errors, ok: false } : { cases, ok: true };
};

export const parseCsvCases = (text: string, maxCases: number): ImportResult => {
    let rows: { cells: string[]; line: number }[];

    try {
        rows = parseCsvRows(text.replace(BOM_RE, ""));
    } catch (error) {
        return { errors: [{ line: 1, message: error instanceof Error ? error.message : "The CSV could not be read" }], ok: false };
    }

    const [header, ...body] = rows;

    if (!header) {
        return { errors: [{ line: 1, message: "The file is empty" }], ok: false };
    }

    const columns = header.cells.map((cell) => normalizeHeader(cell));
    const errors: ImportError[] = [];
    const unknown = columns.filter((column) => !(column in TEXT_COLUMNS) && !CHECK_KINDS.includes(column as CheckKind));

    if (unknown.length > 0) {
        pushError(errors, {
            line: header.line,
            message: `Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Allowed: input, expected_answer, rubric, expected_sources, ${CHECK_KINDS.join(", ")}`,
        });
    }

    if (!columns.includes("input")) {
        pushError(errors, { line: header.line, message: 'The header needs an "input" column' });
    }

    if (errors.length > 0) {
        return { errors, ok: false };
    }

    const cases: CaseDraft[] = [];

    for (const row of body) {
        if (row.cells.length > columns.length) {
            pushError(errors, { line: row.line, message: `The row has ${String(row.cells.length)} fields; the header has ${String(columns.length)}` });
            continue;
        }

        const fields: { checks: { kind: string; value: string }[]; expectedAnswer?: string; expectedSources?: string[]; input: string; rubric?: string } = {
            checks: [],
            input: "",
        };

        for (const [index, column] of columns.entries()) {
            const value = row.cells[index] ?? "";
            const target = TEXT_COLUMNS[column];

            if (target === "expectedSources") {
                fields.expectedSources = splitSources(value);
            } else if (target) {
                fields[target] = value;
            } else if (value.trim() !== "") {
                fields.checks.push({ kind: column, value: value.trim() });
            }
        }

        const result = normalizeCaseDraft(fields);

        if (result.ok) {
            cases.push(result.draft);
        } else {
            for (const message of result.errors) {
                pushError(errors, { line: row.line, message });
            }
        }
    }

    return finish(cases, errors, maxCases);
};

// ─── JSONL ───────────────────────────────────────────────────────────────────

const readSources = (value: unknown): string[] | undefined => {
    if (typeof value === "string") {
        return splitSources(value);
    }

    if (Array.isArray(value)) {
        return value.filter((name): name is string => typeof name === "string");
    }

    return undefined;
};

export const parseJsonlCases = (text: string, maxCases: number): ImportResult => {
    const errors: ImportError[] = [];
    const cases: CaseDraft[] = [];
    const lines = text.replace(BOM_RE, "").split(LINE_BREAK_RE);

    for (const [index, raw] of lines.entries()) {
        if (raw.trim() === "") {
            continue;
        }

        const line = index + 1;

        let parsed: unknown;

        try {
            parsed = JSON.parse(raw);
        } catch {
            pushError(errors, { line, message: "Not valid JSON" });
            continue;
        }

        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            pushError(errors, { line, message: "Each line must be a JSON object" });
            continue;
        }

        const record = parsed as Record<string, unknown>;

        if (typeof record.input !== "string") {
            pushError(errors, { line, message: '"input" must be a string' });
            continue;
        }

        const rawChecks = record.checks ?? [];

        if (!Array.isArray(rawChecks) || rawChecks.some((check) => typeof check !== "object" || check === null)) {
            pushError(errors, { line, message: '"checks" must be an array of { kind, value } objects' });
            continue;
        }

        const checks = (rawChecks as Record<string, unknown>[]).map((check) => {
            return { kind: String(check.kind), value: String(check.value ?? "") };
        });

        const expected = record.expectedAnswer ?? record.expected_answer ?? record.expected;
        const result = normalizeCaseDraft({
            checks,
            expectedAnswer: typeof expected === "string" ? expected : undefined,
            expectedSources: readSources(record.expectedSources ?? record.expected_sources),
            input: record.input,
            rubric: typeof record.rubric === "string" ? record.rubric : undefined,
        });

        if (result.ok) {
            cases.push(result.draft);
        } else {
            for (const message of result.errors) {
                pushError(errors, { line, message });
            }
        }
    }

    return finish(cases, errors, maxCases);
};

export const parseCaseImport = (format: "csv" | "jsonl", text: string, maxCases: number): ImportResult => {
    if (text.length > IMPORT_MAX_CHARS) {
        return { errors: [{ line: 1, message: `The file is larger than ${String(Math.round(IMPORT_MAX_CHARS / 1000))} KB` }], ok: false };
    }

    return format === "csv" ? parseCsvCases(text, maxCases) : parseJsonlCases(text, maxCases);
};
