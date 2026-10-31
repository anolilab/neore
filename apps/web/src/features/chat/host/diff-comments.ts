/**
 * Comments on a host turn's diff, and the one message that carries them to the coding agent.
 *
 * Pure. A comment keeps the diff lines it was made on, copied when it was made, so the message quotes the patch the
 * person saw (the reply's frozen patch), never anything re-read later. The message is capped: quoted lines are cut
 * to fit and say so, comments are never cut. If the comments alone do not fit, there is no message.
 */

import type { PatchLineKind } from "@/features/chat/thread/host-changes-lines";
import { classifyPatch } from "@/features/chat/thread/host-changes-lines";

/** The side a line number counts on: `new` for added and unchanged lines, `old` for removed ones. */
export type DiffSide = "new" | "old";

export interface DiffLineRange {
    /** First and last line number of the range, on the side of the first line. */
    from: number;
    /** The hunk header the lines sit under, so the agent can place them. */
    hunk: string;
    /** The ids of the selected lines in the turn's patch, to mark them again in the diff. */
    lineIds: string[];
    /** The selected patch lines, with their `+`, `-` or space. */
    quoted: string[];
    side: DiffSide;
    to: number;
}

export interface DiffComment {
    id: string;
    messageId: string;
    path: string;
    /** Absent for a comment on the whole file. */
    range?: DiffLineRange;
    text: string;
}

export interface DiffLine {
    /** The hunk header the line is under; set on selectable lines. */
    hunk?: string;
    /** Unique within the patch. */
    id: string;
    kind: PatchLineKind;
    newNumber?: number;
    oldNumber?: number;
    /** Only the lines of a hunk that stand for file content can carry a comment. */
    selectable: boolean;
    text: string;
}

export interface DiffFile {
    lines: DiffLine[];
    path: string;
}

const HUNK_START = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;
const DEV_NULL = "/dev/null";
const OLD_PREFIX = "a/";
const NEW_PREFIX = "b/";

const pathOf = (header: string, prefix: string): string | undefined => {
    const name = header.slice(4);

    if (name === DEV_NULL) {
        return undefined;
    }

    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
};

/**
 * Splits a patch into its files, numbering each line on the side it counts on. A file starts at a `---` / `+++` pair
 * between hunks; its name is the new path, or the old one for a deletion. Lines before the first pair belong to no file.
 */
export const parsePatchFiles = (patch: string): DiffFile[] => {
    const files: DiffFile[] = [];
    let current: DiffFile | undefined;
    let oldPath: string | undefined;
    let hunk = "";
    let oldNumber = 0;
    let newNumber = 0;

    for (const line of classifyPatch(patch)) {
        const base = { id: line.id, kind: line.kind, selectable: false, text: line.text };

        if (line.kind === "header" && line.text.startsWith("--- ")) {
            oldPath = pathOf(line.text, OLD_PREFIX);
            current = undefined;

            continue;
        }

        if (line.kind === "header" && line.text.startsWith("+++ ")) {
            const path = pathOf(line.text, NEW_PREFIX) ?? oldPath;

            if (path !== undefined) {
                current = { lines: [], path };
                files.push(current);
            }

            continue;
        }

        if (current === undefined) {
            continue;
        }

        switch (line.kind) {
            case "add": {
                current.lines.push({ ...base, hunk, newNumber, selectable: true });
                newNumber += 1;

                break;
            }
            case "hunk": {
                const start = HUNK_START.exec(line.text);

                hunk = line.text;
                oldNumber = Number(start?.[1] ?? 1);
                newNumber = Number(start?.[2] ?? 1);
                current.lines.push(base);

                break;
            }
            case "remove": {
                current.lines.push({ ...base, hunk, oldNumber, selectable: true });
                oldNumber += 1;

                break;
            }
            default: {
                if (line.kind === "context" && !line.text.startsWith("\\")) {
                    current.lines.push({ ...base, hunk, newNumber, oldNumber, selectable: true });
                    oldNumber += 1;
                    newNumber += 1;
                } else {
                    current.lines.push(base);
                }
            }
        }
    }

    return files;
};

/**
 * The range a comment on `lines` (consecutive selectable lines of a file) covers, or undefined when there are none.
 * Numbers count on one side only: the new file when any selected line is in it, the old file for a selection of
 * removals alone. The quoted lines still show everything selected, removals included.
 */
export const rangeOf = (lines: ReadonlyArray<DiffLine>): DiffLineRange | undefined => {
    const first = lines[0];

    if (first === undefined) {
        return undefined;
    }

    const side: DiffSide = lines.some((line) => line.newNumber !== undefined) ? "new" : "old";
    const numbers = lines.flatMap((line) => {
        const number = side === "new" ? line.newNumber : line.oldNumber;

        return number === undefined ? [] : [number];
    });

    return {
        from: Math.min(...numbers),
        hunk: first.hunk ?? "",
        lineIds: lines.map((line) => line.id),
        quoted: lines.map((line) => line.text),
        side,
        to: Math.max(...numbers),
    };
};

/** A range as it is written: `12`, `12-15`, with the side said for removed lines. */
export const describeRange = (range: Pick<DiffLineRange, "from" | "side" | "to">): string => {
    const numbers = range.from === range.to ? String(range.from) : `${String(range.from)}-${String(range.to)}`;

    return range.side === "old" ? `${numbers} (removed)` : numbers;
};

/** The longest message `/hosts/send` takes, in characters (`MAX_SEND_CHARS` in `backend/lunora/acp/send.ts`). */
export const MAX_COMMENT_MESSAGE_CHARS = 30_000;

/**
 * The message as JSON text, in UTF-8 bytes. The signed call carries it inside a 32 KiB envelope, and a diff is mostly
 * newlines and quotes, which JSON doubles; the rest of the envelope is a few short fields.
 */
export const MAX_COMMENT_MESSAGE_BYTES = 28 * 1024;

/** The most a single comment may say, so a few comments always fit the message. */
export const MAX_COMMENT_CHARS = 1000;

const encoder = new TextEncoder();

const fits = (text: string): boolean => text.length <= MAX_COMMENT_MESSAGE_CHARS && encoder.encode(JSON.stringify(text)).length <= MAX_COMMENT_MESSAGE_BYTES;

const TRUNCATION_NOTE = "Some quoted diff lines were shortened to fit the size limit. The comments themselves are complete.";

const omitted = (count: number): string => `… ${String(count)} more diff ${count === 1 ? "line" : "lines"} not shown`;

const fenceFor = (lines: ReadonlyArray<string>): string => {
    let longest = 0;

    for (const line of lines) {
        const runs = line.match(/`+/gu) ?? [];

        for (const run of runs) {
            longest = Math.max(longest, run.length);
        }
    }

    return "`".repeat(Math.max(3, longest + 1));
};

/** What text takes on the wire, in UTF-8 bytes of its JSON form (newlines and quotes count double), without the outer quotes. */
const weigh = (text: string): number => encoder.encode(JSON.stringify(text)).length - 2;

const quoteOf = (comment: DiffComment): string[] => (comment.range ? [comment.range.hunk, ...comment.range.quoted].filter((line) => line !== "") : []);

const place = (comment: DiffComment): string => {
    const { range } = comment;

    return range ? `${comment.path}, lines ${describeRange(range)}` : `${comment.path} (the whole file)`;
};

/** The fence is chosen from the whole quote, so a cut quote never needs a longer one than the budget counted. */
const block = (comment: DiffComment, index: number, body: string[] | undefined, quote: ReadonlyArray<string> = body ?? []): string => {
    const heading = `Comment ${String(index + 1)} on ${place(comment)}:`;

    if (body === undefined) {
        return `${heading}\n${comment.text}`;
    }

    const fence = fenceFor(quote);

    return `${heading}\n${fence}diff\n${body.join("\n")}\n${fence}\n${comment.text}`;
};

const intro = (count: number): string =>
    `I reviewed the changes you made and have ${String(count)} ${count === 1 ? "comment" : "comments"} on the diff. Please address ${count === 1 ? "it" : "each one"}.`;

/** Keeps the first lines of a quote that fit `budget` (weighed, newlines included), then says how many were left out. */
const shorten = (lines: ReadonlyArray<string>, budget: number): string[] => {
    const costs = lines.map((line) => weigh(line) + 2);

    if (costs.reduce((sum, cost) => sum + cost, 0) <= budget) {
        return [...lines];
    }

    let used = 0;
    let kept = 0;

    while (kept < lines.length && used + (costs[kept] ?? 0) + weigh(omitted(lines.length - kept - 1)) + 2 <= budget) {
        used += costs[kept] ?? 0;
        kept += 1;
    }

    return [...lines.slice(0, kept), omitted(lines.length - kept)];
};

export type ComposeResult = { ok: false; reason: "empty" | "too_long" } | { ok: true; text: string; truncated: boolean };

/**
 * The message to the agent: for each comment, its file, its lines, the quoted diff lines and what the person said.
 * Over the cap, quoted lines are cut (fairly: a short quote keeps all its lines first) and a note says so. A set of
 * comments that cannot fit even without any quote is refused whole, never trimmed.
 */
export const composeDiffComments = (comments: ReadonlyArray<DiffComment>): ComposeResult => {
    if (comments.length === 0) {
        return { ok: false, reason: "empty" };
    }

    const quotes = comments.map((comment) => quoteOf(comment));
    const whole = [intro(comments.length), ...comments.map((comment, index) => block(comment, index, quotes[index]?.length ? quotes[index] : undefined))].join(
        "\n\n",
    );

    if (fits(whole)) {
        return { ok: true, text: whole, truncated: false };
    }

    // What the message needs whatever is quoted: the text around the quotes, and one "not shown" line per quote.
    const bodies = quotes.map((quote) => (quote.length === 0 ? undefined : [omitted(quote.length)]));
    const floor = [intro(comments.length), ...comments.map((comment, index) => block(comment, index, bodies[index], quotes[index])), TRUNCATION_NOTE].join(
        "\n\n",
    );

    if (!fits(floor)) {
        return { ok: false, reason: "too_long" };
    }

    // The room left is shared out: a quote that is short enough to keep whole is, and the rest split what remains.
    const room = Math.min(MAX_COMMENT_MESSAGE_CHARS, MAX_COMMENT_MESSAGE_BYTES) - weigh(floor) - 2;
    const wanted = quotes.map((quote) => quote.reduce((sum, line) => sum + weigh(line) + 2, 0));
    const marks = quotes.map((quote) => (quote.length === 0 ? 0 : weigh(omitted(quote.length)) + 2));
    const budgets = quotes.map(() => 0);
    let left = room;
    let pending = quotes.map((_quote, index) => index).filter((index) => quotes[index]?.length);

    for (;;) {
        const share = pending.length === 0 ? 0 : Math.floor(left / pending.length);
        const small = pending.filter((index) => (wanted[index] ?? 0) - (marks[index] ?? 0) <= share);

        if (small.length === 0) {
            for (const index of pending) {
                budgets[index] = (marks[index] ?? 0) + share;
            }

            break;
        }

        for (const index of small) {
            budgets[index] = wanted[index] ?? 0;
            left -= (wanted[index] ?? 0) - (marks[index] ?? 0);
        }

        pending = pending.filter((index) => !small.includes(index));
    }

    const cut = quotes.map((quote, index) => (quote.length === 0 ? undefined : shorten(quote, budgets[index] ?? 0)));
    const text = [intro(comments.length), ...comments.map((comment, index) => block(comment, index, cut[index], quotes[index])), TRUNCATION_NOTE].join("\n\n");

    return fits(text) ? { ok: true, text, truncated: true } : { ok: false, reason: "too_long" };
};
