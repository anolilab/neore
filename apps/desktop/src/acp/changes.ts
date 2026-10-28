/**
 * What an agent's turn changed (plan §4.9). A file counts only when the agent's OWN tool call says it wrote it,
 * and only once that call completed:
 *
 * - **diff content**: an ACP tool call carrying `{ type: "diff", path, oldText, newText }`. Both sides are in the
 * message; nothing is read.
 * - **a named path**: an edit, delete or move call that lists `locations` but carries no diff. The file's earlier
 * text is read when the call (or its permission request) first names it, the later text when the call completes.
 *
 * There is no `git status` and no folder-wide comparison, so a file somebody else edited in the folder is never
 * listed, and a write the call does not name is left out rather than guessed. The patch for a call is frozen when
 * it completes: a later edit of the file changes nothing here.
 *
 * Everything in a call is the agent's text. Paths are resolved against the approved folder and refused outside it
 * (`..`, an absolute path elsewhere, a symlink that leaves it), a refused path is never read, and sizes are bounded.
 */
import type { FileIo } from "./folder-files";
import { FolderFiles, MAX_FILE_BYTES } from "./folder-files";
import type { ChangedFile, TurnSummary } from "./host-events";
import { MAX_SUMMARY_FILES } from "./host-events";
import { unifiedDiff } from "./unified-diff";

export type { FileIo } from "./folder-files";

/** Text held for the files of one turn, both sides together; past it, further files are left out. */
const MAX_TRACKED_BYTES = 16 * 1024 * 1024;

/** The patch kept for a turn, in UTF-8 bytes. See `turnEndEvent` for why it is below the backend's 256 KiB. */
export const MAX_PATCH_BYTES = 96 * 1024;
/** How long the end of a turn waits for the reads it started. */
const SETTLE_MS = 5000;

const WRITE_KINDS = new Set(["delete", "edit", "move"]);
/** A call that ended this way wrote nothing that counts (a decline or a cancel is ours; ACP has neither). */
const ENDED_WITHOUT_WRITING = new Set(["cancelled", "declined", "failed"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

interface Tracked {
    after: string | null;
    before: string | null;
}

interface CallState {
    /** The earlier text of files the call names, read when it was first seen; filled in the order they were asked for. */
    before: Map<string, Promise<string | null | undefined>>;
    /** Terminal: failed, cancelled or declined, or already completed. Later updates change nothing. */
    closed: boolean;
    diffs: Map<string, { newText: string; oldText: string | null }>;
    writes: boolean;
}

const runAfter = async (previous: Promise<void>, work: () => Promise<void>): Promise<void> => {
    await previous;
    await work();
};

interface ToolSeen {
    id: string;
    kind: string;
    status: string;
}

export class TurnChanges {
    private readonly calls = new Map<string, CallState>();

    private readonly files: FolderFiles;

    private readonly tracked = new Map<string, Tracked | "dropped">();

    private bytes = 0;

    /** Work done in the order the calls completed, so two writes to one file land in order. */
    private chain: Promise<void> = Promise.resolve();

    private sealed = false;

    private started = false;

    public constructor(
        folder: string,
        private readonly scrub: (text: string) => string,
        io?: FileIo,
    ) {
        this.files = new FolderFiles(folder, io);
    }

    /** Whether any call has named a file: if not, the turn's end needs no waiting. */
    public get active(): boolean {
        return this.started;
    }

    /** One tool call or update (or the call a permission request is about), as the agent sent it. */
    public note(tool: ToolSeen, update: Record<string, unknown>): void {
        if (this.sealed || tool.id === "") {
            return;
        }

        const call = this.calls.get(tool.id) ?? { before: new Map(), closed: false, diffs: new Map(), writes: false };

        this.calls.set(tool.id, call);

        if (call.closed) {
            return;
        }

        if (ENDED_WITHOUT_WRITING.has(tool.status)) {
            call.closed = true;
            call.before.clear();
            call.diffs.clear();

            return;
        }

        if (WRITE_KINDS.has(tool.kind) || WRITE_KINDS.has(typeof update.kind === "string" ? update.kind : "")) {
            call.writes = true;
        }

        this.collectDiffs(call, update);

        // The earlier text is only worth reading before the call ran, and only for a path no diff already covers.
        if (call.writes && (tool.status === "pending" || tool.status === "in_progress")) {
            this.snapshot(call, update);
        }

        if (tool.status === "completed") {
            call.closed = true;
            this.commit(call);
        }
    }

    /** The turn's summary, once what it started has finished; undefined when no file was listed. No update changes it afterwards. */
    public async summary(): Promise<TurnSummary | undefined> {
        this.sealed = true;

        let timer: ReturnType<typeof setTimeout> | undefined;

        await Promise.race([
            this.chain,
            new Promise((resolve) => {
                timer = setTimeout(resolve, SETTLE_MS);
            }),
        ]);
        clearTimeout(timer);

        return this.build();
    }

    private collectDiffs(call: CallState, update: Record<string, unknown>): void {
        const { content } = update;

        if (!Array.isArray(content)) {
            return;
        }

        for (const item of content) {
            if (!isRecord(item) || item.type !== "diff" || typeof item.path !== "string" || typeof item.newText !== "string") {
                continue;
            }

            const relative = this.files.relative(item.path);
            const oldText = typeof item.oldText === "string" ? item.oldText : null;

            if (relative !== undefined && item.newText.length <= MAX_FILE_BYTES && (oldText?.length ?? 0) <= MAX_FILE_BYTES) {
                call.diffs.set(relative, { newText: item.newText, oldText });
            }
        }
    }

    private snapshot(call: CallState, update: Record<string, unknown>): void {
        const { locations } = update;

        if (!Array.isArray(locations)) {
            return;
        }

        for (const location of locations) {
            const relative = isRecord(location) && typeof location.path === "string" ? this.files.relative(location.path) : undefined;

            if (relative !== undefined && !call.before.has(relative) && !call.diffs.has(relative)) {
                this.started = true;
                call.before.set(relative, this.files.read(relative));
            }
        }
    }

    private commit(call: CallState): void {
        for (const [relative, diff] of call.diffs) {
            this.started = true;
            this.enqueue(async () => {
                // The path is inside the folder as written; a link in it may still lead out.
                this.record(relative, diff.oldText, await this.files.confines(relative) ? diff.newText : undefined);
            });
        }

        for (const [relative, before] of call.before) {
            if (call.diffs.has(relative)) {
                continue;
            }

            this.enqueue(async () => {
                const [earlier, later] = await Promise.all([before, this.files.read(relative)]);

                this.record(relative, earlier, later);
            });
        }

        // The queued work holds what it needs; the call keeps nothing for the rest of the session.
        call.before.clear();
        call.diffs.clear();
    }

    private enqueue(work: () => Promise<void>): void {
        this.chain = runAfter(this.chain, work);
    }

    /** Keeps the first earlier text and the latest later text of a file; a side that cannot be known drops the file. */
    private record(relative: string, before: string | null | undefined, after: string | null | undefined): void {
        const known = this.tracked.get(relative);

        if (known === "dropped") {
            return;
        }

        if (before === undefined || after === undefined || before?.includes("\0") === true || after?.includes("\0") === true) {
            this.tracked.set(relative, "dropped");

            return;
        }

        const size = (before?.length ?? 0) + (after?.length ?? 0);

        if (Math.max(before?.length ?? 0, after?.length ?? 0) > MAX_FILE_BYTES || this.bytes + size > MAX_TRACKED_BYTES || (known === undefined && this.tracked.size >= MAX_SUMMARY_FILES)) {
            this.tracked.set(relative, "dropped");

            return;
        }

        if (known === undefined) {
            this.bytes += size;
            this.tracked.set(relative, { after, before });

            return;
        }

        this.bytes += (after?.length ?? 0) - (known.after?.length ?? 0);
        known.after = after;
    }

    private build(): TurnSummary | undefined {
        const files: ChangedFile[] = [];
        const patches: string[] = [];

        // eslint-disable-next-line unicorn/no-array-sort -- a copy; this package's TypeScript lib predates `toSorted`
        const entries = [...this.tracked].sort(([a], [b]) => a.localeCompare(b));

        for (const [relative, state] of entries) {
            if (state === "dropped") {
                continue;
            }

            const diff = unifiedDiff(relative, state.before, state.after);
            const created = state.before === null || state.after === null;

            // A write that left the file as it was is not a change; creating or deleting an empty file is.
            if (diff.added === 0 && diff.removed === 0 && (!created || state.before === state.after)) {
                continue;
            }

            files.push({ added: diff.added, path: this.scrub(relative), removed: diff.removed });
            patches.push(this.scrub(diff.patch));
        }

        if (files.length === 0) {
            return undefined;
        }

        const patch = patches.join("");

        return { files, patch: Buffer.byteLength(patch) > MAX_PATCH_BYTES ? { tooLarge: true } : patch };
    }
}
