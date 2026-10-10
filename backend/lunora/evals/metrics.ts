/**
 * Pure scoring for evals, kept apart from the procedures so every number the
 * Evals page shows is testable without a database or a model:
 *
 * - retrieval metrics (hit@k, MRR, context precision / recall) from a ranked
 *   list of retrieved chunks and the case's expected source documents;
 * - the deterministic checks (exact / contains / regex / JSON schema / latency /
 *   cost);
 * - how a case's parts combine into one score and a pass, how a run's results
 *   aggregate, and how two runs compare;
 * - the per-run cost cap.
 */

// ─── Limits ──────────────────────────────────────────────────────────────────

/** Cases per dataset; also bounds every per-run read (a run snapshots at most this many). */
export const MAX_CASES_PER_DATASET = 200;

export const MAX_DATASETS_PER_USER = 50;

/** Runs a user may have in flight at once. Cases within a run execute one at a time. */
export const MAX_ACTIVE_RUNS_PER_USER = 2;

export const DATASET_NAME_MAX = 120;

export const DATASET_DESCRIPTION_MAX = 2000;

export const CASE_INPUT_MAX = 20_000;

export const CASE_EXPECTED_MAX = 20_000;

export const CASE_RUBRIC_MAX = 5000;

export const MAX_CHECKS_PER_CASE = 10;

export const CHECK_VALUE_MAX = 10_000;

export const MAX_EXPECTED_SOURCES = 20;

export const SOURCE_NAME_MAX = 300;

export const SYSTEM_PROMPT_MAX = 20_000;

/** How much of an answer is kept on a result row, shown to the judge and matched by checks. */
export const ANSWER_MAX = 12_000;

/** The default per-run spend ceiling: $1. */
export const DEFAULT_COST_CAP_MICRODOLLARS = 1_000_000;

/** The highest per-run ceiling a user may set: $25. */
export const MAX_COST_CAP_MICRODOLLARS = 25_000_000;

/** The lowest per-run ceiling a user may set: one cent. */
export const MIN_COST_CAP_MICRODOLLARS = 10_000;

/** A judge (or faithfulness) score at or above this passes the case. */
export const JUDGE_PASS_THRESHOLD = 0.7;

/** A case's score dropping by more than this between two runs is a regression even if both passed. */
export const REGRESSION_SCORE_DELTA = 0.1;

// ─── Retrieval ───────────────────────────────────────────────────────────────

/** How file names are compared: case- and surrounding-whitespace-insensitive. */
export const normalizeSourceName = (name: string): string => name.trim().toLowerCase();

export interface RetrievalMetrics {
    /** Fraction of the retrieved chunks that came from an expected document. */
    contextPrecision: number;
    /** Fraction of the expected documents at least one retrieved chunk came from. */
    contextRecall: number;
    /** 1 when any of the top `k` chunks came from an expected document, else 0. */
    hitAtK: number;
    k: number;
    /** Reciprocal rank of the first relevant chunk (1-based), 0 when none is relevant. */
    mrr: number;
    relevant: boolean[];
}

/** One retrieved chunk's source. `fileId` is absent only on results from before search carried it. */
export interface RetrievedSource {
    fileId?: string;
    fileName: string;
}

/**
 * Whether a retrieved chunk came from an expected source. An expected entry is
 * matched as a knowledge file id first — what the case editor stores — and as a
 * file name otherwise, which is what an imported dataset names (an import
 * cannot know the ids). Names compare case- and whitespace-insensitively.
 */
export const matchesSource = (entry: string, source: RetrievedSource): boolean =>
    (source.fileId !== undefined && entry.trim() === source.fileId) || normalizeSourceName(entry) === normalizeSourceName(source.fileName);

/**
 * Document-level retrieval metrics. `retrieved` is the ranked list of chunk
 * sources, best first, one entry per chunk (so a document may repeat);
 * `expected` names the documents the answer should come from, by id or name
 * (see {@link matchesSource}).
 *
 * With no expected documents there is nothing to be relevant to: every metric
 * is 0, and the caller should not report them at all (see {@link scoreCase}).
 */
export const computeRetrievalMetrics = (
    retrieved: ReadonlyArray<RetrievedSource>,
    expected: ReadonlyArray<string>,
    k: number = retrieved.length,
): RetrievalMetrics => {
    const entries = [...new Set(expected.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
    const topK = retrieved.slice(0, Math.max(0, k));
    const relevant = topK.map((source) => entries.some((entry) => matchesSource(entry, source)));
    const firstRelevant = relevant.indexOf(true);
    const found = entries.filter((entry) => topK.some((source) => matchesSource(entry, source)));

    return {
        contextPrecision: topK.length === 0 ? 0 : relevant.filter(Boolean).length / topK.length,
        contextRecall: entries.length === 0 ? 0 : found.length / entries.length,
        hitAtK: firstRelevant === -1 ? 0 : 1,
        k: Math.max(0, k),
        mrr: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
        relevant,
    };
};

// ─── JSON schema (subset) ────────────────────────────────────────────────────

type JsonSchema = Record<string, unknown>;

const typeOf = (value: unknown): string => {
    if (value === null) {
        return "null";
    }

    if (Array.isArray(value)) {
        return "array";
    }

    return typeof value;
};

const matchesType = (value: unknown, type: string): boolean => {
    if (type === "integer") {
        return typeof value === "number" && Number.isSafeInteger(value);
    }

    if (type === "number") {
        return typeof value === "number" && Number.isFinite(value);
    }

    return typeOf(value) === type;
};

const MAX_SCHEMA_DEPTH = 32;

/**
 * Validates `value` against a JSON Schema subset: `type` (one or a list),
 * `enum`, `const`, `properties`, `required`, `additionalProperties: false`,
 * `items`, `minItems` / `maxItems`, `minLength` / `maxLength`, `minimum` /
 * `maximum`, `anyOf`. Unknown keywords are ignored — which is the permissive
 * direction, so a schema using them passes more than it should, never less.
 * Returns the first problem as a path-prefixed message, or `undefined`.
 */
export const validateJsonSchema = (value: unknown, schema: unknown, path = "$", depth = 0): string | undefined => {
    if (depth > MAX_SCHEMA_DEPTH) {
        return `${path}: schema is nested too deeply`;
    }

    if (schema === true || schema === undefined) {
        return undefined;
    }

    if (schema === false) {
        return `${path}: no value is allowed here`;
    }

    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
        return `${path}: the schema is not an object`;
    }

    const s = schema as JsonSchema;

    if (Array.isArray(s.anyOf)) {
        const options = s.anyOf as unknown[];

        if (options.every((option) => validateJsonSchema(value, option, path, depth + 1) !== undefined)) {
            return `${path}: matches none of the allowed shapes`;
        }
    }

    if (s.type !== undefined) {
        const types = (Array.isArray(s.type) ? s.type : [s.type]).filter((type): type is string => typeof type === "string");

        if (types.length > 0 && types.every((type) => !matchesType(value, type))) {
            return `${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`;
        }
    }

    if (Array.isArray(s.enum) && s.enum.every((option) => JSON.stringify(option) !== JSON.stringify(value))) {
        return `${path}: not one of the allowed values`;
    }

    if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(value)) {
        return `${path}: must equal ${JSON.stringify(s.const)}`;
    }

    if (typeof value === "string") {
        if (typeof s.minLength === "number" && value.length < s.minLength) {
            return `${path}: shorter than ${String(s.minLength)} characters`;
        }

        if (typeof s.maxLength === "number" && value.length > s.maxLength) {
            return `${path}: longer than ${String(s.maxLength)} characters`;
        }
    }

    if (typeof value === "number") {
        if (typeof s.minimum === "number" && value < s.minimum) {
            return `${path}: less than ${String(s.minimum)}`;
        }

        if (typeof s.maximum === "number" && value > s.maximum) {
            return `${path}: greater than ${String(s.maximum)}`;
        }
    }

    if (Array.isArray(value)) {
        if (typeof s.minItems === "number" && value.length < s.minItems) {
            return `${path}: fewer than ${String(s.minItems)} items`;
        }

        if (typeof s.maxItems === "number" && value.length > s.maxItems) {
            return `${path}: more than ${String(s.maxItems)} items`;
        }

        if (s.items !== undefined) {
            for (const [index, item] of value.entries()) {
                const problem = validateJsonSchema(item, s.items, `${path}[${String(index)}]`, depth + 1);

                if (problem) {
                    return problem;
                }
            }
        }
    }

    if (typeOf(value) === "object") {
        const record = value as Record<string, unknown>;
        const properties = typeof s.properties === "object" && s.properties !== null ? (s.properties as Record<string, unknown>) : {};

        if (Array.isArray(s.required)) {
            for (const key of s.required) {
                if (typeof key === "string" && !(key in record)) {
                    return `${path}: missing required property "${key}"`;
                }
            }
        }

        for (const [key, propertySchema] of Object.entries(properties)) {
            if (!(key in record)) {
                continue;
            }

            const problem = validateJsonSchema(record[key], propertySchema, `${path}.${key}`, depth + 1);

            if (problem) {
                return problem;
            }
        }

        if (s.additionalProperties === false) {
            const extra = Object.keys(record).find((key) => !(key in properties));

            if (extra !== undefined) {
                return `${path}: unexpected property "${extra}"`;
            }
        }
    }

    return undefined;
};

const FENCED_JSON_RE = /```(?:json)?([^`]*)```/u;

/** The JSON an answer carries: the whole answer, else its first fenced block. `undefined` when neither parses. */
export const extractJson = (answer: string): { value: unknown } | undefined => {
    const candidates = [answer.trim(), FENCED_JSON_RE.exec(answer)?.[1]?.trim()];

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        try {
            return { value: JSON.parse(candidate) as unknown };
        } catch {
            // try the next candidate
        }
    }

    return undefined;
};

// ─── Deterministic checks ────────────────────────────────────────────────────

export type CheckKind = "contains" | "exact" | "json_schema" | "max_cost_usd" | "max_latency_ms" | "not_contains" | "regex";

export const CHECK_KINDS: ReadonlyArray<CheckKind> = ["exact", "contains", "not_contains", "regex", "json_schema", "max_latency_ms", "max_cost_usd"];

export interface EvalCheck {
    kind: CheckKind;
    value: string;
}

export interface CheckResult {
    detail?: string;
    kind: CheckKind;
    /** `null`: could not be measured, so it counts neither as a pass nor a fail. */
    pass: boolean | null;
    value: string;
}

/** Why a check definition is unusable, or `undefined` when it is fine. Run at save and import time. */
export const validateCheck = (check: EvalCheck): string | undefined => {
    if (!CHECK_KINDS.includes(check.kind)) {
        return `Unknown check "${String(check.kind)}"`;
    }

    if (check.value.length > CHECK_VALUE_MAX) {
        return `A check value must be ${String(CHECK_VALUE_MAX)} characters or less`;
    }

    switch (check.kind) {
        case "contains":
        case "exact":
        case "not_contains": {
            return check.value.trim().length === 0 ? `The "${check.kind}" check needs a value` : undefined;
        }
        case "json_schema": {
            try {
                const parsed = JSON.parse(check.value) as unknown;

                return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? undefined : "A JSON schema must be a JSON object";
            } catch {
                return "The JSON schema is not valid JSON";
            }
        }
        case "max_cost_usd":
        case "max_latency_ms": {
            const number = Number(check.value);

            return check.value.trim() !== "" && Number.isFinite(number) && number > 0 ? undefined : `The "${check.kind}" check needs a positive number`;
        }
        case "regex": {
            try {
                return new RegExp(check.value, "u").source === "(?:)" ? "The regex check needs a pattern" : undefined;
            } catch {
                return "The regex is not a valid pattern";
            }
        }
        default: {
            return undefined;
        }
    }
};

export interface CheckContext {
    answer: string;
    /** Undefined when nothing reported a cost (no gateway pricing, or the user's own key without pricing). */
    costMicrodollars?: number;
    latencyMs: number;
}

/** Runs one check against a finished case. A malformed check fails rather than throwing. */
export const runCheck = (check: EvalCheck, context: CheckContext): CheckResult => {
    const base = { kind: check.kind, value: check.value };
    const answer = context.answer.slice(0, ANSWER_MAX);

    switch (check.kind) {
        case "contains": {
            return { ...base, pass: answer.toLowerCase().includes(check.value.trim().toLowerCase()) };
        }
        case "exact": {
            return { ...base, pass: answer.trim() === check.value.trim() };
        }
        case "json_schema": {
            let schema: unknown;

            try {
                schema = JSON.parse(check.value);
            } catch {
                return { ...base, detail: "The schema is not valid JSON", pass: false };
            }

            const extracted = extractJson(answer);

            if (!extracted) {
                return { ...base, detail: "The answer is not valid JSON", pass: false };
            }

            const problem = validateJsonSchema(extracted.value, schema);

            return problem ? { ...base, detail: problem, pass: false } : { ...base, pass: true };
        }
        case "max_cost_usd": {
            if (context.costMicrodollars === undefined) {
                return { ...base, detail: "No cost was reported for this case", pass: null };
            }

            const limit = Number(check.value) * 1_000_000;

            return { ...base, detail: `$${(context.costMicrodollars / 1_000_000).toFixed(4)}`, pass: context.costMicrodollars <= limit };
        }
        case "max_latency_ms": {
            return { ...base, detail: `${String(Math.round(context.latencyMs))} ms`, pass: context.latencyMs <= Number(check.value) };
        }
        case "not_contains": {
            return { ...base, pass: !answer.toLowerCase().includes(check.value.trim().toLowerCase()) };
        }
        case "regex": {
            try {
                return { ...base, pass: new RegExp(check.value, "u").test(answer) };
            } catch {
                return { ...base, detail: "The regex is not a valid pattern", pass: false };
            }
        }
        default: {
            return { ...base, detail: "Unknown check", pass: false };
        }
    }
};

// ─── Case score ──────────────────────────────────────────────────────────────

export interface CaseScoreInput {
    checks: ReadonlyArray<Pick<CheckResult, "pass">>;
    faithfulness?: { score: number };
    judge?: { score: number };
    /** Only when the case named expected sources — otherwise retrieval has nothing to be right about. */
    retrieval?: Pick<RetrievalMetrics, "contextRecall" | "hitAtK">;
}

export interface CaseScore {
    passed: boolean;
    /** Mean of the measured parts, 0-1; `undefined` when nothing was measured. */
    score?: number;
}

/**
 * One case's score: the mean of whatever was measured — the judge, faithfulness,
 * the check pass rate and retrieval recall. It passes when every measured check
 * passed, every judge score met {@link JUDGE_PASS_THRESHOLD}, and retrieval (if
 * expected) found at least one expected document. A case that measured nothing
 * passes vacuously with no score, so the aggregate does not count it as a 0.
 */
export const scoreCase = (input: CaseScoreInput): CaseScore => {
    const measuredChecks = input.checks.filter((check) => check.pass !== null);
    const parts: number[] = [];

    if (input.judge) {
        parts.push(input.judge.score);
    }

    if (input.faithfulness) {
        parts.push(input.faithfulness.score);
    }

    if (measuredChecks.length > 0) {
        parts.push(measuredChecks.filter((check) => check.pass === true).length / measuredChecks.length);
    }

    if (input.retrieval) {
        parts.push(input.retrieval.contextRecall);
    }

    const passed =
        measuredChecks.every((check) => check.pass === true) &&
        (!input.judge || input.judge.score >= JUDGE_PASS_THRESHOLD) &&
        (!input.faithfulness || input.faithfulness.score >= JUDGE_PASS_THRESHOLD) &&
        (!input.retrieval || input.retrieval.hitAtK === 1);

    return {
        passed,
        score: parts.length === 0 ? undefined : parts.reduce((sum, part) => sum + part, 0) / parts.length,
    };
};

// ─── Run aggregate ───────────────────────────────────────────────────────────

export interface AggregatableResult {
    checks?: ReadonlyArray<Pick<CheckResult, "pass">>;
    costMicrodollars?: number;
    faithfulness?: { score: number };
    judge?: { score: number };
    latencyMs?: number;
    passed?: boolean;
    retrieval?: { contextPrecision: number; contextRecall: number; hitAtK: number; mrr: number };
    score?: number;
    status: "error" | "running" | "scored" | "skipped";
}

export interface EvalSummary {
    avgContextPrecision: number | null;
    avgContextRecall: number | null;
    avgFaithfulness: number | null;
    avgJudgeScore: number | null;
    avgLatencyMs: number | null;
    avgScore: number | null;
    checkPassRate: number | null;
    errored: number;
    hitRate: number | null;
    mrr: number | null;
    passed: number;
    /** Passed over scored; errors are reported apart rather than counted as fails. */
    passRate: number | null;
    scored: number;
    skipped: number;
    total: number;
    totalCostMicrodollars: number;
}

const mean = (values: ReadonlyArray<number>): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

const defined = <T>(values: ReadonlyArray<T | undefined>): T[] => values.filter((value): value is T => value !== undefined);

/** Aggregates a run's results. `total` is the run's case count, which may exceed the results written so far. */
export const aggregateResults = (results: ReadonlyArray<AggregatableResult>, total: number): EvalSummary => {
    const scored = results.filter((result) => result.status === "scored");
    const checks = scored.flatMap((result) => (result.checks ?? []).filter((check) => check.pass !== null));
    const retrieval = defined(scored.map((result) => result.retrieval));

    return {
        avgContextPrecision: mean(retrieval.map((metrics) => metrics.contextPrecision)),
        avgContextRecall: mean(retrieval.map((metrics) => metrics.contextRecall)),
        avgFaithfulness: mean(defined(scored.map((result) => result.faithfulness?.score))),
        avgJudgeScore: mean(defined(scored.map((result) => result.judge?.score))),
        avgLatencyMs: mean(defined(scored.map((result) => result.latencyMs))),
        avgScore: mean(defined(scored.map((result) => result.score))),
        checkPassRate: checks.length === 0 ? null : checks.filter((check) => check.pass === true).length / checks.length,
        errored: results.filter((result) => result.status === "error").length,
        hitRate: mean(retrieval.map((metrics) => metrics.hitAtK)),
        mrr: mean(retrieval.map((metrics) => metrics.mrr)),
        passed: scored.filter((result) => result.passed === true).length,
        passRate: scored.length === 0 ? null : scored.filter((result) => result.passed === true).length / scored.length,
        scored: scored.length,
        skipped: results.filter((result) => result.status === "skipped").length,
        total,
        totalCostMicrodollars: results.reduce((sum, result) => sum + (result.costMicrodollars ?? 0), 0),
    };
};

// ─── Comparison ──────────────────────────────────────────────────────────────

export interface ComparableResult {
    caseId: string;
    passed?: boolean;
    score?: number;
    status: AggregatableResult["status"];
}

export type CaseChange = "improved" | "missing" | "regressed" | "unchanged";

export interface CaseComparison {
    baseline?: ComparableResult;
    candidate?: ComparableResult;
    caseId: string;
    change: CaseChange;
    /** Candidate minus baseline, when both have a score. */
    scoreDelta?: number;
}

/**
 * Case by case, baseline against candidate. A regression is a case that passed
 * and now fails or errors, or whose score fell by more than
 * {@link REGRESSION_SCORE_DELTA}; an improvement is the mirror image. A case in
 * only one of the runs is `missing`.
 */
export const compareCase = (caseId: string, baseline: ComparableResult | undefined, candidate: ComparableResult | undefined): CaseComparison => {
    if (!baseline || !candidate || baseline.status === "skipped" || candidate.status === "skipped") {
        return { baseline, candidate, caseId, change: "missing" };
    }

    const scoreDelta = baseline.score !== undefined && candidate.score !== undefined ? candidate.score - baseline.score : undefined;
    const basePassed = baseline.status === "scored" && baseline.passed === true;
    const candidatePassed = candidate.status === "scored" && candidate.passed === true;

    let change: CaseChange = "unchanged";

    if ((basePassed && !candidatePassed) || (scoreDelta !== undefined && scoreDelta < -REGRESSION_SCORE_DELTA)) {
        change = "regressed";
    } else if ((!basePassed && candidatePassed) || (scoreDelta !== undefined && scoreDelta > REGRESSION_SCORE_DELTA)) {
        change = "improved";
    }

    return { baseline, candidate, caseId, change, scoreDelta };
};

/** Compares two runs over the union of their cases, ordered by the baseline's case order then the candidate's. */
export const compareRunResults = (
    baseline: ReadonlyArray<ComparableResult>,
    candidate: ReadonlyArray<ComparableResult>,
): { cases: CaseComparison[]; improved: number; regressed: number; unchanged: number } => {
    const byCase = (results: ReadonlyArray<ComparableResult>) => new Map(results.map((result) => [result.caseId, result]));
    const baseMap = byCase(baseline);
    const candidateMap = byCase(candidate);
    const caseIds = [...new Set([...baseline.map((result) => result.caseId), ...candidate.map((result) => result.caseId)])];
    const cases = caseIds.map((caseId) => compareCase(caseId, baseMap.get(caseId), candidateMap.get(caseId)));

    return {
        cases,
        improved: cases.filter((entry) => entry.change === "improved").length,
        regressed: cases.filter((entry) => entry.change === "regressed").length,
        unchanged: cases.filter((entry) => entry.change === "unchanged").length,
    };
};

// ─── Budget ──────────────────────────────────────────────────────────────────

/** The default token budget for the part of a run no price was reported for. */
export const DEFAULT_TOKEN_BUDGET = 200_000;

export const MIN_TOKEN_BUDGET = 10_000;

export const MAX_TOKEN_BUDGET = 5_000_000;

export interface RunSpend {
    capMicrodollars: number;
    spentMicrodollars: number;
    tokenBudget: number;
    /** Tokens of the cases that reported no cost — the only spend the dollar cap cannot see. */
    unpricedTokens: number;
}

/**
 * Whether a run may start its next case, and if not, which budget stopped it.
 * A case's spend is only known after it ran, so both are checked BEFORE each
 * case against what the run has spent: a run may overshoot by one case.
 *
 * Two budgets because cost is not always measured: a user's own key or custom
 * endpoint with no gateway pricing reports none, and the dollar cap alone would
 * then never trip. Such cases count their tokens against the token budget
 * instead, so a run is bounded either way.
 */
export const nextCaseBudget = (spend: RunSpend): "cost" | "ok" | "tokens" => {
    if (spend.spentMicrodollars >= spend.capMicrodollars) {
        return "cost";
    }

    return spend.unpricedTokens >= spend.tokenBudget ? "tokens" : "ok";
};

/** The tokens a case adds to the unpriced budget: none when a cost was reported, else its usage — estimated from text when none was reported either. */
export const unpricedCaseTokens = (costMicrodollars: number | undefined, tokens: number | undefined, text: string): number => {
    if (costMicrodollars !== undefined) {
        return 0;
    }

    // ~4 characters per token, the same rough rule `auto-continue.ts` uses.
    return tokens ?? Math.ceil(text.length / 4);
};

/** Validates a user-supplied token budget. */
export const parseTokenBudget = (tokens: number | undefined): number | { error: string } => {
    if (tokens === undefined) {
        return DEFAULT_TOKEN_BUDGET;
    }

    if (!Number.isSafeInteger(tokens) || tokens < MIN_TOKEN_BUDGET || tokens > MAX_TOKEN_BUDGET) {
        return { error: `The token budget must be a whole number between ${String(MIN_TOKEN_BUDGET)} and ${String(MAX_TOKEN_BUDGET)}` };
    }

    return tokens;
};

// ─── Cost cap ────────────────────────────────────────────────────────────────

/** Validates a user-supplied cap in US dollars and returns it in microdollars. */
export const parseCostCapUsd = (usd: number | undefined): number | { error: string } => {
    if (usd === undefined) {
        return DEFAULT_COST_CAP_MICRODOLLARS;
    }

    if (!Number.isFinite(usd)) {
        return { error: "The cost cap must be a number" };
    }

    const microdollars = Math.round(usd * 1_000_000);

    if (microdollars < MIN_COST_CAP_MICRODOLLARS || microdollars > MAX_COST_CAP_MICRODOLLARS) {
        return {
            error: `The cost cap must be between $${(MIN_COST_CAP_MICRODOLLARS / 1_000_000).toFixed(2)} and $${(MAX_COST_CAP_MICRODOLLARS / 1_000_000).toFixed(2)}`,
        };
    }

    return microdollars;
};
