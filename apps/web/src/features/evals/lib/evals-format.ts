/**
 * Pure helpers for the Evals page: the API row types, number formatting, the
 * check editor's row shape and import-format detection. The backend
 * (`backend/lunora/evals/`) re-validates everything; this only keeps the forms
 * honest and the tables readable.
 */
import type { ReturnOf } from "@lunora/react";
import type { ApiTypes } from "@neore/backend/api";

export type EvalDataset = ReturnOf<ApiTypes["evals"]["functions"]["listDatasets"]>[number];

export type EvalDatasetDetail = ReturnOf<ApiTypes["evals"]["functions"]["getDataset"]>;

export type EvalCase = EvalDatasetDetail["cases"][number];

export type EvalRun = ReturnOf<ApiTypes["evals"]["functions"]["listRuns"]>[number];

export type EvalRunDetail = ReturnOf<ApiTypes["evals"]["functions"]["getRun"]>;

export type EvalResult = EvalRunDetail["results"][number];

export type EvalSummary = EvalRunDetail["summary"];

export type EvalComparison = ReturnOf<ApiTypes["evals"]["functions"]["compareRuns"]>;

export type EvalCheckKind = EvalCase["checks"][number]["kind"];

export type EvalTarget = EvalRun["target"];

export const CHECK_KINDS: ReadonlyArray<EvalCheckKind> = ["contains", "not_contains", "exact", "regex", "json_schema", "max_latency_ms", "max_cost_usd"];

export const INPUT_MAX = 20_000;

export const EXPECTED_MAX = 20_000;

export const RUBRIC_MAX = 5000;

export const NAME_MAX = 120;

export const MAX_CHECKS = 10;

/** Mirrors the backend import limit (`IMPORT_MAX_CHARS`), so an oversized file is refused before upload. */
export const IMPORT_MAX_BYTES = 512_000;

const JSONL_EXTENSION_RE = /\.(?:jsonl|ndjson)$/iu;

const SOURCE_SEPARATOR_RE = /[\n,;|]/u;

/** A 0-1 fraction as a whole percentage; an em dash when nothing was measured. */
export const formatPercent = (value: number | null | undefined): string =>
    value === null || value === undefined ? "—" : `${String(Math.round(value * 100))}%`;

/** Microdollars as dollars: four decimals below a cent, two above. */
export const formatCost = (microdollars: number | null | undefined): string => {
    if (microdollars === null || microdollars === undefined) {
        return "—";
    }

    const dollars = microdollars / 1_000_000;

    return `$${dollars < 0.01 && dollars > 0 ? dollars.toFixed(4) : dollars.toFixed(2)}`;
};

export const formatLatency = (ms: number | null | undefined): string => {
    if (ms === null || ms === undefined) {
        return "—";
    }

    return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
};

/** A signed score delta in percentage points, e.g. "+12" / "−5". */
export const formatDelta = (delta: number | null | undefined): string => {
    if (delta === null || delta === undefined) {
        return "—";
    }

    const points = Math.round(delta * 100);

    if (points === 0) {
        return "0";
    }

    return points > 0 ? `+${String(points)}` : `−${String(Math.abs(points))}`;
};

/** How far a run has got: finished cases over the run's case count. */
export const runProgress = (run: Pick<EvalRun, "caseCount" | "nextIndex">): number => (run.caseCount === 0 ? 0 : Math.min(1, run.nextIndex / run.caseCount));

/** The import format a file is in, from its name — `.jsonl`/`.ndjson` are JSONL, anything else CSV. */
export const detectImportFormat = (fileName: string): "csv" | "jsonl" => (JSONL_EXTENSION_RE.test(fileName) ? "jsonl" : "csv");

/** Splits a free-text source list ("a.pdf, b.pdf" or one per line) into names. */
export const parseSourceList = (text: string): string[] => [
    ...new Set(
        text
            .split(SOURCE_SEPARATOR_RE)
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
    ),
];

export interface CheckRow {
    kind: EvalCheckKind;
    value: string;
}

/** Drops check rows left blank in the editor. */
export const compactChecks = (rows: ReadonlyArray<CheckRow>): CheckRow[] => rows.filter((row) => row.value.trim().length > 0);

/** The two runs a comparison needs, oldest as the baseline, or `undefined` until exactly two are picked. */
export const orderForComparison = (
    runs: ReadonlyArray<Pick<EvalRun, "_id" | "createdAt">>,
): { baselineRunId: EvalRun["_id"]; candidateRunId: EvalRun["_id"] } | undefined => {
    if (runs.length !== 2) {
        return undefined;
    }

    const [first, second] = runs.toSorted((a, b) => a.createdAt - b.createdAt) as [Pick<EvalRun, "_id" | "createdAt">, Pick<EvalRun, "_id" | "createdAt">];

    return { baselineRunId: first._id, candidateRunId: second._id };
};

export interface CaseFormValues {
    checks: CheckRow[];
    expectedAnswer: string;
    /** Knowledge files picked in the editor, by id — what retrieval results are matched on first. */
    expectedFileIds: string[];
    /** Free text, one file name per line (or comma-separated) — for files not (yet) in the knowledge base. */
    expectedSources: string;
    input: string;
    rubric: string;
}

export const EMPTY_CASE: CaseFormValues = { checks: [], expectedAnswer: "", expectedFileIds: [], expectedSources: "", input: "", rubric: "" };

/**
 * A stored case as form values. A stored source is a knowledge file id or a
 * file name (imports can only name files); the ids among `knownFileIds` go to
 * the file picker, everything else to the free-text list.
 */
export const caseToForm = (
    evalCase: Pick<EvalCase, "checks" | "expectedAnswer" | "expectedSources" | "input" | "rubric">,
    knownFileIds: ReadonlySet<string> = new Set(),
): CaseFormValues => {
    return {
        checks: evalCase.checks.map((check) => {
            return { kind: check.kind, value: check.value };
        }),
        expectedAnswer: evalCase.expectedAnswer ?? "",
        expectedFileIds: evalCase.expectedSources.filter((source) => knownFileIds.has(source)),
        expectedSources: evalCase.expectedSources.filter((source) => !knownFileIds.has(source)).join("\n"),
        input: evalCase.input,
        rubric: evalCase.rubric ?? "",
    };
};

/** Form values as the create/update payload: blanks dropped, sources split. */
export const formToCasePayload = (values: CaseFormValues) => {
    return {
        checks: compactChecks(values.checks),
        expectedAnswer: values.expectedAnswer.trim() || undefined,
        expectedSources: [...new Set([...values.expectedFileIds, ...parseSourceList(values.expectedSources)])],
        input: values.input.trim(),
        rubric: values.rubric.trim() || undefined,
    };
};
