/**
 * The guide of a pull request, as data: what a model's answer is allowed to become.
 *
 * The model is shown the diff and asked for stops in reading order, but its answer is
 * input, never structure. `assembleGuide` decides the structure itself: which files are
 * mechanical (by name and shape, not by the model's say-so), the order of the groups, that
 * every changed file is covered, which line ranges exist in the diff, and which proposals
 * survive (a comment on a diff line, a label, and nothing else). A pull request body that
 * talks the model into a different shape therefore changes the words of a guide, not its form.
 *
 * Pure: no host, no database, no model.
 */
import type { PullRequestFile } from "./types";

export type GuideFile = Pick<PullRequestFile, "additions" | "deletions" | "patch" | "path" | "previousPath" | "status">;

export type GuideSide = "new" | "old";

export interface GuideRange {
    end: number;
    side: GuideSide;
    start: number;
}

export interface GuideStopFile {
    path: string;
    ranges: GuideRange[];
}

/**
 * - `core`: the change itself. - `dependent`: what leans on it.
 * - `mechanical`: renames, snapshots, lockfiles, generated output: always last but one.
 * - `uncovered`: files the guide did not place, so none is silently missing.
 */
export type GuideStopKind = "core" | "dependent" | "mechanical" | "uncovered";

export interface GuideStop {
    explanation: string;
    files: GuideStopFile[];
    id: string;
    kind: GuideStopKind;
    title: string;
}

export type ProposalStatus = "applied" | "dismissed" | "proposed";

/** A comment the guide suggests. It is posted only when the user applies it, and then only into their review draft. */
export interface CommentProposal {
    body: string;
    id: string;
    kind: "comment";
    line: number;
    path: string;
    side: GuideSide;
    startLine: number | null;
    status: ProposalStatus;
}

export interface LabelProposal {
    id: string;
    kind: "label";
    name: string;
    reason: string;
    status: ProposalStatus;
}

export type GuideProposal = CommentProposal | LabelProposal;

export interface AssembledGuide {
    /** Changed files the host would not list, so no guide can name them. */
    leftOut: number;
    proposals: GuideProposal[];
    stops: GuideStop[];
    summary: string;
}

export const MAX_STOPS = 40;
export const MAX_RANGES_PER_FILE = 6;
export const MAX_PROPOSALS = 20;
export const MAX_LABEL_PROPOSALS = 5;
const MAX_TITLE = 200;
const MAX_EXPLANATION = 2000;
const MAX_SUMMARY = 2000;
const MAX_COMMENT = 4000;
const MAX_LABEL = 50;

// ─── The diff ───────────────────────────────────────────────────────────────

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

export interface PatchLines {
    newLines: Set<number>;
    oldLines: Set<number>;
}

/** The line numbers a patch shows on each side: the only lines a range or a comment may name. */
export const parsePatchLines = (patch: string | null): PatchLines => {
    const lines: PatchLines = { newLines: new Set(), oldLines: new Set() };

    if (patch === null) {
        return lines;
    }

    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;

    for (const row of patch.split("\n")) {
        const header = HUNK.exec(row);

        if (header) {
            oldLine = Number(header[1]);
            newLine = Number(header[2]);
            inHunk = true;
            continue;
        }

        if (!inHunk || row.startsWith("\\")) {
            continue;
        }

        if (row.startsWith("+")) {
            lines.newLines.add(newLine);
            newLine += 1;
        } else if (row.startsWith("-")) {
            lines.oldLines.add(oldLine);
            oldLine += 1;
        } else {
            lines.newLines.add(newLine);
            lines.oldLines.add(oldLine);
            newLine += 1;
            oldLine += 1;
        }
    }

    return lines;
};

// ─── Mechanical changes ─────────────────────────────────────────────────────

const LOCKFILES = new Set([
    "bun.lock",
    "bun.lockb",
    "Cargo.lock",
    "composer.lock",
    "Gemfile.lock",
    "go.sum",
    "package-lock.json",
    "Pipfile.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "uv.lock",
    "yarn.lock",
]);

const MECHANICAL_PATHS = [/(^|\/)__snapshots__\//u, /\.snap$/u, /\.min\.(?:css|js)$/u, /\.map$/u, /(^|\/)_generated\//u, /\.generated\.[a-z]+$/u, /\.pb\.go$/u];

/** Renames, snapshots, lockfiles and generated output: read last, and not by the model's choice. */
export const isMechanicalFile = (file: GuideFile): boolean => {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);

    if (LOCKFILES.has(name) || MECHANICAL_PATHS.some((pattern) => pattern.test(file.path))) {
        return true;
    }

    return file.status === "renamed" && file.additions === 0 && file.deletions === 0;
};

// ─── Reading the model's answer ─────────────────────────────────────────────

const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

const wholeLine = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null);

const sideOf = (value: unknown): GuideSide | null => (value === "new" || value === "old" ? value : null);

const linesOf = (lines: Map<string, PatchLines>, path: string, side: GuideSide): Set<number> => {
    const known = lines.get(path);

    return (side === "new" ? known?.newLines : known?.oldLines) ?? new Set<number>();
};

const rangesOf = (value: unknown, path: string, lines: Map<string, PatchLines>): GuideRange[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const ranges: GuideRange[] = [];

    for (const entry of value) {
        const candidate = record(entry);
        const start = wholeLine(candidate?.start);
        const end = wholeLine(candidate?.end);
        const side = sideOf(candidate?.side);

        if (start === null || end === null || side === null || end < start) {
            continue;
        }

        // A range is worth pointing at when it touches a line the diff shows on that side.
        const shown = linesOf(lines, path, side);

        if ([...shown].some((line) => line >= start && line <= end)) {
            ranges.push({ end, side, start });
        }

        if (ranges.length >= MAX_RANGES_PER_FILE) {
            break;
        }
    }

    return ranges;
};

interface ModelStop {
    explanation: string;
    files: GuideStopFile[];
    role: "core" | "dependent";
    title: string;
}

const modelStopsOf = (value: unknown, byPath: Map<string, GuideFile>, lines: Map<string, PatchLines>): ModelStop[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const stops: ModelStop[] = [];

    for (const entry of value.slice(0, MAX_STOPS)) {
        const candidate = record(entry);
        const files: GuideStopFile[] = [];
        const seen = new Set<string>();

        const named: unknown[] = Array.isArray(candidate?.files) ? candidate.files : [];

        for (const entryNamed of named) {
            const fileEntry = record(entryNamed);
            const path = text(fileEntry?.path, 1024);
            const known = byPath.get(path);

            // A path the pull request does not change, a mechanical file, or one the stop already names is not a place to read.
            if (!known || isMechanicalFile(known) || seen.has(path)) {
                continue;
            }

            seen.add(path);
            files.push({ path, ranges: rangesOf(fileEntry?.ranges, path, lines) });
        }

        if (files.length > 0) {
            // Anything but an explicit "core" reads as a dependent: the model does not get to invent a third kind.
            stops.push({
                explanation: text(candidate?.explanation, MAX_EXPLANATION),
                files,
                role: candidate?.role === "core" ? "core" : "dependent",
                title: text(candidate?.title, MAX_TITLE),
            });
        }
    }

    return stops;
};

const proposalsOf = (value: unknown, byPath: Map<string, GuideFile>, lines: Map<string, PatchLines>): GuideProposal[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const proposals: GuideProposal[] = [];
    let labels = 0;

    for (const entry of value) {
        if (proposals.length >= MAX_PROPOSALS) {
            break;
        }

        const candidate = record(entry);
        const id = `proposal-${String(proposals.length + 1)}`;

        if (candidate?.kind === "comment") {
            const path = text(candidate.path, 1024);
            const body = text(candidate.body, MAX_COMMENT);
            const line = wholeLine(candidate.line);
            const side = sideOf(candidate.side);

            if (!byPath.has(path) || body === "" || line === null || side === null) {
                continue;
            }

            const startLine = wholeLine(candidate.startLine);
            const shown = linesOf(lines, path, side);

            // A comment the host would refuse (a line outside the diff) is not worth proposing.
            if (!shown.has(line) || (startLine !== null && (startLine >= line || !shown.has(startLine)))) {
                continue;
            }

            proposals.push({ body, id, kind: "comment", line, path, side, startLine, status: "proposed" });
        } else if (candidate?.kind === "label" && labels < MAX_LABEL_PROPOSALS) {
            // eslint-disable-next-line no-control-regex -- a label with a control character is not a label
            const name = text(candidate.name, MAX_LABEL).replaceAll(/[\u{0}-\u{1F}\u{7F}]/gu, "");

            if (name === "") {
                continue;
            }

            labels += 1;
            proposals.push({ id, kind: "label", name, reason: text(candidate.reason, MAX_EXPLANATION), status: "proposed" });
        }
    }

    return proposals;
};

// ─── The guide ──────────────────────────────────────────────────────────────

/**
 * Builds the guide from what the model said, in the order and with the coverage this module decides.
 * `files` is the FULL list of changed files, not the subset whose patches fit the prompt.
 */
export const assembleGuide = (files: ReadonlyArray<GuideFile>, output: unknown, leftOut: number): AssembledGuide => {
    const byPath = new Map(files.map((entry) => [entry.path, entry]));
    const lines = new Map(files.map((entry) => [entry.path, parsePatchLines(entry.patch)]));
    const answer = record(output);
    const modelStops = modelStopsOf(answer?.stops, byPath, lines);

    // The core change goes first even when the model named none.
    if (modelStops.length > 0 && modelStops.every((stop) => stop.role !== "core")) {
        modelStops[0] = { ...modelStops[0]!, role: "core" };
    }

    const ordered = [...modelStops.filter((stop) => stop.role === "core"), ...modelStops.filter((stop) => stop.role === "dependent")];
    const stops: GuideStop[] = ordered.map((stop, index) => {
        return { explanation: stop.explanation, files: stop.files, id: `stop-${String(index + 1)}`, kind: stop.role, title: stop.title };
    });
    const placed = new Set(stops.flatMap((stop) => stop.files.map((entry) => entry.path)));
    const mechanical = files.filter((entry) => isMechanicalFile(entry));
    const mechanicalPaths = new Set(mechanical.map((entry) => entry.path));
    const uncovered = files.filter((entry) => !placed.has(entry.path) && !mechanicalPaths.has(entry.path));

    if (mechanical.length > 0) {
        stops.push({
            explanation: "",
            files: mechanical.map((entry) => {
                return { path: entry.path, ranges: [] };
            }),
            id: "mechanical",
            kind: "mechanical",
            title: "",
        });
    }

    if (uncovered.length > 0) {
        stops.push({
            explanation: "",
            files: uncovered.map((entry) => {
                return { path: entry.path, ranges: [] };
            }),
            id: "uncovered",
            kind: "uncovered",
            title: "",
        });
    }

    return { leftOut, proposals: proposalsOf(answer?.proposals, byPath, lines), stops, summary: text(answer?.summary, MAX_SUMMARY) };
};

// ─── Freshness ──────────────────────────────────────────────────────────────

export type GuideFreshness = "current" | "stale";

/** A guide is about one head commit; once the pull request has another, it is offered for regeneration. */
export const guideFreshness = (guideHeadSha: string, currentHeadSha: string): GuideFreshness => (guideHeadSha === currentHeadSha ? "current" : "stale");

/** A guide that has been "generating" this long is not: its job or its host turn is gone. */
export const GUIDE_RUN_WINDOW_MS = 30 * 60 * 1000;

/** The most guides kept for one pull request: the latest heads, so a regenerate does not grow the table. */
export const GUIDES_KEPT_PER_PULL = 3;

type GuideStatus = "failed" | "generating" | "ready";

export const isRunning = (guide: { status: GuideStatus; updatedAt: number }, now: number): boolean =>
    guide.status === "generating" && now - guide.updatedAt < GUIDE_RUN_WINDOW_MS;

/** What the page is told: a run that outlived its window reads as abandoned rather than spinning for ever. */
export const effectiveStatus = (guide: { status: GuideStatus; updatedAt: number }, now: number): GuideStatus =>
    guide.status === "generating" && !isRunning(guide, now) ? "failed" : guide.status;

interface Pickable {
    createdAt: number;
    headSha: string;
    status: GuideStatus;
}

/**
 * Which stored guide a pull request at `headSha` shows: the newest one for that head (whatever its state), else the
 * newest finished guide for an earlier head, offered as stale, else the newest attempt.
 */
export const pickGuide = <T extends Pickable>(guides: ReadonlyArray<T>, headSha: string): { freshness: GuideFreshness; guide: T } | null => {
    const newest = (rows: ReadonlyArray<T>): T | undefined => rows.toSorted((a, b) => b.createdAt - a.createdAt)[0];
    const current = newest(guides.filter((guide) => guide.headSha === headSha));

    if (current) {
        return { freshness: "current", guide: current };
    }

    const earlier = newest(guides.filter((guide) => guide.status === "ready")) ?? newest(guides);

    return earlier ? { freshness: "stale", guide: earlier } : null;
};

// ─── Host guides ────────────────────────────────────────────────────────────

const MAX_JSON_ATTEMPTS = 20;

const BRACE_STEP: Readonly<Record<string, number>> = { "{": 1, "}": -1 };

/** The end of the JSON object that opens at `start`, or -1: strings and escapes are skipped, so a brace inside text does not count. */
const objectEnd = (source: string, start: number): number => {
    let depth = 0;
    let inString = false;

    for (let index = start; index < source.length; index += 1) {
        const char = source[index];

        if (inString) {
            if (char === "\\") {
                index += 1;
            } else if (char === '"') {
                inString = false;
            }
        } else if (char === '"') {
            inString = true;
        } else {
            depth += BRACE_STEP[char ?? ""] ?? 0;

            if (char === "}" && depth === 0) {
                return index;
            }
        }
    }

    return -1;
};

/**
 * The JSON object a coding agent answered with, out of whatever text surrounds it (prose, a fenced block). `null` when
 * there is none. Bounded: a reply full of braces is tried a few times, not scanned for ever.
 */
export const extractJsonObject = (reply: string): unknown => {
    let from = reply.indexOf("{");

    for (let attempt = 0; from !== -1 && attempt < MAX_JSON_ATTEMPTS; attempt += 1) {
        const end = objectEnd(reply, from);

        if (end !== -1) {
            try {
                return JSON.parse(reply.slice(from, end + 1)) as unknown;
            } catch {
                // Not JSON: try the next opening brace.
            }
        }

        from = reply.indexOf("{", from + 1);
    }

    return null;
};

/**
 * Whether an approved folder is plausibly the repository: its label ends in the repository's name, or names the whole
 * `owner/name` path. A label is the user's own text, so this only offers a choice; the coding agent is told to check the remote.
 */
const PATH_SEPARATOR = /[/\\]/u;

export const folderMatchesRepo = (folderLabel: string, repo: string): boolean => {
    const name = repo.slice(repo.lastIndexOf("/") + 1).toLowerCase();
    const label = folderLabel.trim().toLowerCase();
    const last = label.split(PATH_SEPARATOR).findLast((segment) => segment !== "") ?? "";

    return name !== "" && (last === name || label.includes(repo.toLowerCase()));
};
