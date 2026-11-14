/**
 * The usage part of the account export, written as bounded steps and read back whole.
 *
 * {@link collectUsageExport} runs in the export workflow (`workflows/export-workflow.ts`), one durable step per page,
 * recount and title group; each step persists its piece (`usageExportPieces`) before the next runs. The tests drive the
 * same function with plain calls. {@link assembleUsageExport} runs in the usage action, which reads the pieces of the
 * pass that was kept, verified by the steps before it: it reads no project documents and no memberships.
 *
 * Backfill: a backfill can write history while the export runs. The recount takes the totals (rows, replies, tokens, cost) of
 * the closed days, those dated before the cutoff the rows gave the first page (`usage/gdpr.ts` `cutoffFromRows`), and the
 * state of the user's backfill row. The pass is kept only when both equal what the pages stored. Live writes land on the
 * open days, which the totals leave out, and do not touch the backfill row, so a busy user keeps its first pass.
 */
import { nameExportedRows, type ExportedUsageRow } from "../usage/activity-logic";
import { TITLE_STEP_BYTES, USAGE_EXPORT_ATTEMPTS, USAGE_EXPORT_BYTES, USAGE_EXPORT_PASSES, type ClosedTotals } from "../usage/gdpr";

/** What one rows page reported when it was persisted. */
export interface UsagePageSummary {
    backfill: string;
    bytes: number;
    closed: ClosedTotals;
    cutoff: string;
    nextCursor: string | null;
    projectIds: string[];
    rowCount: number;
}

/**
 * How the steps reach the database. The workflow passes durable steps (`context.step.do` around `context.run`, its
 * `name` as the dedup id); the tests pass plain calls. `step` gives each named step its turn; the rest persist, count or
 * clear the pieces.
 */
export interface UsageExportIo {
    clear: (name: string) => Promise<{ hasMore: boolean }>;
    countRows: (name: string, args: { cursor: string | null; cutoff: string }) => Promise<{ backfill: string; closed: ClosedTotals; cursor: string | null }>;
    pause: (name: string) => Promise<void>;
    persistRows: (name: string, args: { cursor: string | null; cutoff: string | undefined; pass: number; seq: number }) => Promise<UsagePageSummary>;
    persistTitles: (
        name: string,
        args: { budgetBytes: number; from: number; pass: number; seq: number },
    ) => Promise<{ bytes: number; done: boolean; next: number; titles: number }>;
    step: <T>(name: string, run: () => Promise<T>) => Promise<T>;
    verifyTitles: (
        name: string,
        args: { budgetBytes: number; from: number; pass: number; seq: number },
    ) => Promise<{ bytes: number; done: boolean; next: number; titles: number }>;
}

/**
 * Why a usage export stopped: the rollup kept changing through every pass (`changed`, the export is requested again), or the
 * usage is larger than its share of the file (`too-large`).
 */
export class UsageExportError extends Error {
    reason: "changed" | "too-large";

    constructor(reason: "changed" | "too-large") {
        super(reason === "changed" ? "The usage history kept changing while the export was written" : "The usage history is too large to export in one file");
        this.name = "UsageExportError";
        this.reason = reason;
    }
}

const sumTotals = (into: ClosedTotals, from: ClosedTotals): void => {
    into.cost += from.cost;
    into.replies += from.replies;
    into.rows += from.rows;
    into.tokens += from.tokens;
};

const sameTotals = (a: ClosedTotals, b: ClosedTotals): boolean => a.rows === b.rows && a.replies === b.replies && a.tokens === b.tokens && a.cost === b.cost;

/**
 * Writes the user's rollup as the export's pieces, for the first pass the recount agrees with. Returns the pass the usage
 * action reads. Throws {@link UsageExportError} "too-large" past the usage share of the file, and "changed" when every pass
 * was changed under it.
 */
export const collectUsageExport = async (io: UsageExportIo): Promise<{ pass: number }> => {
    let cutoff: string | undefined;

    for (let attempt = 1; attempt <= USAGE_EXPORT_ATTEMPTS; attempt += 1) {
        // A later attempt waits first, so a backfill that was still writing can finish; its passes get new step names.
        if (attempt > 1) {
            await io.pause(`usage-backoff-${String(attempt)}`);
        }

        for (let within = 1; within <= USAGE_EXPORT_PASSES; within += 1) {
            const pass = (attempt - 1) * USAGE_EXPORT_PASSES + within;
            const pages = await persistPages(io, pass, cutoff);

            cutoff = pages.cutoff;

            const counted = await countPass(io, pass, cutoff);

            if (pages.backfillMoved || counted.backfillMoved || !sameTotals(counted.totals, pages.closed) || counted.backfill !== pages.backfill) {
                await clearUsagePieces(io, `usage-p${String(pass)}-discard`);
                continue;
            }

            // The titles are checked just before the usage action builds the file: each project's ownership and membership are read
            // again, so a project moved in between is not named.
            await titleSteps(io, pass, "verify", io.verifyTitles);

            // A backfill that changed a closed day while the titles were checked leaves the pages stale: the pass is recounted, after
            // the checks, and kept only if it still agrees with its pages.
            const final = await countPass(io, pass, cutoff, "final");

            if (final.backfillMoved || !sameTotals(final.totals, pages.closed) || final.backfill !== pages.backfill) {
                await clearUsagePieces(io, `usage-p${String(pass)}-discard`);
                continue;
            }

            return { pass };
        }
    }

    throw new UsageExportError("changed");
};

/** Clears a run's pieces: one batch per step, until none is left. */
export const clearUsagePieces = async (io: UsageExportIo, label = "usage-clear"): Promise<void> => {
    for (let round = 0; ; round += 1) {
        const name = `${label}-${String(round)}`;
        const { hasMore } = await io.step(name, async () => await io.clear(name));

        if (!hasMore) {
            return;
        }
    }
};

/** Every rows page of the pass, in order, each a durable step. The first page of the first pass sets the cutoff. */
const persistPages = async (
    io: UsageExportIo,
    pass: number,
    initialCutoff: string | undefined,
): Promise<{ backfill: string; backfillMoved: boolean; closed: ClosedTotals; cutoff: string; projectIds: Set<string> }> => {
    const projectIds = new Set<string>();
    let backfill = "";
    let backfillMoved = false;
    const closed: ClosedTotals = { cost: 0, replies: 0, rows: 0, tokens: 0 };
    let bytes = 0;
    let cursor: string | null = null;
    let cutoff = initialCutoff;
    let seq = 0;
    let more = true;

    while (more) {
        const name = `usage-p${String(pass)}-rows-${String(seq)}`;
        const page = await io.step(name, async () => await io.persistRows(name, { cursor, cutoff, pass, seq }));

        bytes += page.bytes;
        sumTotals(closed, page.closed);
        cutoff = page.cutoff;

        if (seq === 0) {
            backfill = page.backfill;
        } else if (page.backfill !== backfill) {
            // A later page saw the backfill row change: history was written behind the pages already read.
            backfillMoved = true;
        }

        for (const projectId of page.projectIds) {
            projectIds.add(projectId);
        }

        if (bytes > USAGE_EXPORT_BYTES) {
            throw new UsageExportError("too-large");
        }

        cursor = page.nextCursor;
        more = cursor !== null;
        seq += 1;
    }

    return { backfill, backfillMoved, closed, cutoff: cutoff ?? "", projectIds };
};

/** The totals of the closed days and the backfill row, counted again from the rollup, page by page. A count keeps nothing. */
const countPass = async (
    io: UsageExportIo,
    pass: number,
    cutoff: string,
    label = "count",
): Promise<{ backfill: string; backfillMoved: boolean; totals: ClosedTotals }> => {
    const totals: ClosedTotals = { cost: 0, replies: 0, rows: 0, tokens: 0 };
    let backfill = "";
    let backfillMoved = false;
    let cursor: string | null = null;
    let seq = 0;
    let more = true;

    while (more) {
        const name = `usage-p${String(pass)}-${label}-${String(seq)}`;
        const page = await io.step(name, async () => await io.countRows(name, { cursor, cutoff }));

        sumTotals(totals, page.closed);

        if (seq === 0) {
            backfill = page.backfill;
        } else if (page.backfill !== backfill) {
            backfillMoved = true;
        }

        cursor = page.cursor;
        more = cursor !== null;
        seq += 1;
    }

    return { backfill, backfillMoved, totals };
};

/**
 * Bounded steps over the pass's projects, each starting where the last ended and reading projects until it has read
 * {@link TITLE_STEP_BYTES} of them. `write` is the step's database call: the first title read, or the re-check after it.
 */
const titleSteps = async (
    io: UsageExportIo,
    pass: number,
    prefix: string,
    write: (
        name: string,
        args: { budgetBytes: number; from: number; pass: number; seq: number },
    ) => Promise<{ bytes: number; done: boolean; next: number; titles: number }>,
): Promise<void> => {
    let from = 0;
    let seq = 0;
    let done = false;

    while (!done) {
        const name = `usage-p${String(pass)}-${prefix}-${String(seq)}`;
        const step = await io.step(name, async () => await write(name, { budgetBytes: TITLE_STEP_BYTES, from, pass, seq }));

        from = step.next;
        done = step.done;
        seq += 1;
    }
};

/** Reads one kind of the pass's pieces, page by page, with the cursor the read returned. */
export type ReadUsagePieces = (kind: "rows" | "verified", cursor: string | null) => Promise<{ cursor: string | null; payloads: string[] }>;

/** One project as its title piece holds it: its title, and the organization that lets the user read it (none if owned). */
export interface StoredTitle {
    organizationId?: string;
    title: string;
}

/** The organizations, of those given, the user is still a member of (read from the primary by the usage action). */
export type ReadMemberships = (organizationIds: string[]) => Promise<string[]>;

/**
 * The usage rows of the export, named by their projects' titles. Reads the rows pieces and the verified title pieces of the pass, and
 * fails past the usage share of the file. Before naming an owned project the action re-reads it, just before the file is written, so
 * a project transferred away since its check is not named. `readBytes` is what the reads cost, for the usage action's budget.
 */
export const assembleUsageExport = async (
    readPieces: ReadUsagePieces,
    readMemberships: ReadMemberships,
): Promise<{ readBytes: number; rows: ExportedUsageRow[] }> => {
    const encoder = new TextEncoder();
    let readBytes = 0;

    // Rows and titles are each held to the usage share on their own, as `persistPages` holds the rows: the file's final size is checked
    // once it is built (`buildUsageJson`), since titles repeat on every row they name.
    const readAll = async (kind: "rows" | "verified"): Promise<string[]> => {
        const payloads: string[] = [];
        let cursor: string | null = null;
        let kindBytes = 0;

        for (;;) {
            const page = await readPieces(kind, cursor);

            for (const payload of page.payloads) {
                const size = encoder.encode(payload).byteLength;

                kindBytes += size;
                readBytes += size;
                payloads.push(payload);
            }

            if (kindBytes > USAGE_EXPORT_BYTES) {
                throw new UsageExportError("too-large");
            }

            if (page.cursor === null) {
                return payloads;
            }

            cursor = page.cursor;
        }
    };

    const rowPayloads = await readAll("rows");

    // Every kept pass writes at least one rows piece, even for an account with no usage. None means the pieces were removed while the
    // export was still running (its run was cancelled): the export fails, rather than storing an empty history as if it were complete.
    if (rowPayloads.length === 0) {
        throw new Error("The usage pieces of this export were removed before the file was built");
    }

    const rows = rowPayloads.flatMap((payload) => JSON.parse(payload) as ExportedUsageRow[]);
    const grants = new Map<string, StoredTitle>();
    const verified = await readAll("verified");

    for (const payload of verified) {
        const named = Object.entries(JSON.parse(payload) as Record<string, StoredTitle>);

        for (const [projectId, grant] of named) {
            grants.set(projectId, grant);
        }
    }

    // Memberships are checked again just before the file is built: a membership revoked since the titles were verified is left out.
    // Ownership is checked by the verify steps, each project in its own bounded step.
    const organizations = [...new Set([...grants.values()].flatMap((grant) => (grant.organizationId === undefined ? [] : [grant.organizationId])))];
    const members = new Set(organizations.length === 0 ? [] : await readMemberships(organizations));
    const titles = new Map<string, string>();

    for (const [projectId, grant] of grants) {
        if (grant.organizationId === undefined || members.has(grant.organizationId)) {
            titles.set(projectId, grant.title);
        }
    }

    return { readBytes, rows: nameExportedRows(rows, titles) };
};

/**
 * The export file's JSON with the usage array as its last key. `head` is the file's JSON without usage (its object, closed by
 * its final brace); `usageJson` is the usage array, already JSON. The usage is spliced in as text, so it is not parsed again.
 */
export const spliceUsageJson = (head: string, usageJson: string): string => {
    const open = head.slice(0, head.lastIndexOf("}")).trimEnd();

    return `${open},\n  "usageDaily": ${usageJson}\n}`;
};

/**
 * The object key of a run's usage JSON. It is derived from the run, so the workflow can find and delete the object on every
 * path, even when the step that wrote it did not return.
 */
export const usageObjectKey = (runKey: string): string => `gdpr-exports/usage-${runKey.replaceAll(/[^\w-]/g, "_")}.json`;

/**
 * The usage JSON of the kept pass, as text, or `null` when the usage is larger than its share of the file. The size is
 * checked both on the pieces as they are read and on the JSON as it is written, which is what the file action reads back.
 */
export const buildUsageJson = async (readPieces: ReadUsagePieces, readMemberships: ReadMemberships): Promise<string | null> => {
    try {
        const usage = await assembleUsageExport(readPieces, readMemberships);
        const text = JSON.stringify(usage.rows);

        return new TextEncoder().encode(text).byteLength > USAGE_EXPORT_BYTES ? null : text;
    } catch (error) {
        if (error instanceof UsageExportError && error.reason === "too-large") {
            return null;
        }

        throw error;
    }
};
