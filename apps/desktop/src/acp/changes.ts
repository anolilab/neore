/**
 * What an agent's turn changed (plan §4.9). A file counts only when the agent's OWN tool call says it wrote it,
 * and only once that call completed:
 *
 * - **diff content**: an ACP tool call carrying `{ type: "diff", path, oldText, newText }`. Both sides are in the
 * message; nothing is read. A call that is first seen already complete still counts, since the message is the evidence.
 * - **a named path**: an edit, delete or move call that lists `locations` but carries no diff. The file's earlier
 * text is read when the call (or its permission request) first names it, the later text when the call completes. A
 * call first seen already complete has no earlier text to read, so it is left out rather than guessed.
 *
 * There is no `git status` and no folder-wide comparison, so a file somebody else edited in the folder is never
 * listed, and a write the call does not name is left out rather than guessed. The patch for a call is frozen when
 * it completes: a later edit of the file changes nothing here.
 *
 * Everything in a call is the agent's text. Paths are resolved against the approved folder and refused outside it
 * (`..`, an absolute path elsewhere, a symlink that leaves it), a refused path is never read, and sizes are bounded:
 * at most 200 paths, 1 MiB a side, 16 MiB of text held, and a diff budget for the whole turn (`unified-diff.ts`).
 */
/* eslint-disable no-param-reassign -- `CallState` and `Snapshot` are the recorder's own bookkeeping, changed in place as a call goes on */
import type { FileIo } from "./folder-files";
import { FolderFiles, MAX_FILE_BYTES } from "./folder-files";
import type { ChangedFile, TurnSummary } from "./host-events";
import { isSummaryPath, MAX_SUMMARY_FILES } from "./host-events";
import { newDiffLimits, unifiedDiff } from "./unified-diff";

export type { FileIo } from "./folder-files";

/** Text held for the files of one turn, in UTF-8 bytes: waiting in a call, being read, or kept for the summary. Past it, further files are left out. */
const MAX_TRACKED_BYTES = 16 * 1024 * 1024;

/** The patch kept for a turn, in UTF-8 bytes. See `turnEndEvent` for why it is below the backend's 256 KiB. */
export const MAX_PATCH_BYTES = 96 * 1024;
/** How long the end of a turn waits for the reads it started. */
const SETTLE_MS = 5000;

const WRITE_KINDS = new Set(["delete", "edit", "move"]);
/** A call that ended this way wrote nothing that counts (a decline or a cancel is ours; ACP has neither). */
const ENDED_WITHOUT_WRITING = new Set(["cancelled", "declined", "failed"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A file's text kept for the summary; `size` is both sides in UTF-8 bytes. */
interface Tracked {
    after: string | null;
    afterSize: number;
    before: string | null;
    size: number;
}

/** The earlier text of a file a call names, read when the call was first seen. */
interface Snapshot {
    /** The call ended without writing before the read finished: nothing is to be held for it. */
    abandoned: boolean;
    read: Promise<string | null | undefined>;
    /** Bytes held for the text once read, counted in `held`. */
    size: number;
}

interface CallState {
    /** The paths this call took a slot for. */
    admitted: Set<string>;
    before: Map<string, Snapshot>;
    /** Terminal: failed, cancelled or declined, or already completed. Later updates change nothing. */
    closed: boolean;
    diffs: Map<string, { newText: string; oldText: string | null; size: number }>;
    writes: boolean;
}

const runAfter = async <T>(previous: Promise<unknown>, work: () => Promise<T>): Promise<T> => {
    await previous;

    return await work();
};

/** The promise's end, however it went: a chain that waits on it must not be broken by it. */
const settled = async (promise: Promise<unknown>): Promise<void> => {
    try {
        await promise;
    } catch {
        // The caller of the promise sees the failure.
    }
};

const sizeOf = (text: string | null | undefined): number => text === null || text === undefined ? 0 : Buffer.byteLength(text);

interface ToolSeen {
    id: string;
    kind: string;
    status: string;
}

export class TurnChanges {
    private readonly calls = new Map<string, CallState>();

    private readonly files: FolderFiles;

    private readonly tracked = new Map<string, Tracked | "dropped">();

    /** Bytes of the texts kept in `tracked`. */
    private bytes = 0;

    /** Work done in the order the calls completed, so two writes to one file land in order. */
    private chain: Promise<void> = Promise.resolve();

    /** Bytes of texts waiting in calls or being read; they move to `bytes` or are let go. */
    private held = 0;

    /** The snapshot reads, in line: one file is read at a time, so the room left is known before the next. */
    private reading: Promise<void> = Promise.resolve();

    private sealed = false;

    private started = false;

    /** The paths taking one of the {@link MAX_SUMMARY_FILES} slots, with how many calls named each. A dropped file gives its slot back. */
    private readonly uses = new Map<string, number>();

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

        const call = this.calls.get(tool.id) ?? { admitted: new Set(), before: new Map(), closed: false, diffs: new Map(), writes: false };

        this.calls.set(tool.id, call);

        if (call.closed) {
            return;
        }

        if (ENDED_WITHOUT_WRITING.has(tool.status)) {
            this.abandon(call);

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

    /** A slot for the path, for this call. False when the turn already lists as many paths as it may. */
    private admit(call: CallState, relative: string): boolean {
        if (this.tracked.get(relative) === "dropped") {
            return false;
        }

        if (call.admitted.has(relative)) {
            return true;
        }

        const uses = this.uses.get(relative);

        if (uses === undefined && this.uses.size >= MAX_SUMMARY_FILES) {
            return false;
        }

        this.uses.set(relative, (uses ?? 0) + 1);
        call.admitted.add(relative);

        return true;
    }

    /** Room for `size` more bytes of text; takes it when there is. */
    private reserve(size: number): boolean {
        if (this.bytes + this.held + size > MAX_TRACKED_BYTES) {
            return false;
        }

        this.held += size;

        return true;
    }

    /** A call that wrote nothing: what it held and the slots it took go back. */
    private abandon(call: CallState): void {
        call.closed = true;

        for (const diff of call.diffs.values()) {
            this.held -= diff.size;
        }

        for (const snapshot of call.before.values()) {
            // A read still running holds nothing yet; it will see this and keep nothing.
            snapshot.abandoned = true;
            this.held -= snapshot.size;
            snapshot.size = 0;
        }

        for (const relative of call.admitted) {
            const uses = (this.uses.get(relative) ?? 1) - 1;

            if (uses > 0) {
                this.uses.set(relative, uses);
            } else if (!this.tracked.has(relative)) {
                this.uses.delete(relative);
            }
        }

        call.before.clear();
        call.diffs.clear();
        call.admitted.clear();
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

            // Characters are never more than bytes, so a text with too many of them is too big without measuring it.
            if (relative === undefined) {
                continue;
            }

            // Characters are never more than bytes, so a text with too many of them is too big without measuring it.
            const tooBig = item.newText.length > MAX_FILE_BYTES || (oldText?.length ?? 0) > MAX_FILE_BYTES;
            const size = tooBig ? Number.POSITIVE_INFINITY : sizeOf(item.newText) + sizeOf(oldText);

            // The latest update wins: an earlier, smaller diff of this path is not what the call ended with.
            if (size > 2 * MAX_FILE_BYTES) {
                this.held -= call.diffs.get(relative)?.size ?? 0;
                call.diffs.delete(relative);

                continue;
            }

            if (!this.admit(call, relative)) {
                continue;
            }

            this.held -= call.diffs.get(relative)?.size ?? 0;
            call.diffs.delete(relative);

            if (this.reserve(size)) {
                call.diffs.set(relative, { newText: item.newText, oldText, size });
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

            if (relative === undefined || call.before.has(relative) || call.diffs.has(relative)) {
                continue;
            }

            if (!this.admit(call, relative)) {
                continue;
            }

            const snapshot: Snapshot = { abandoned: false, read: Promise.resolve(undefined), size: 0 };

            this.started = true;
            snapshot.read = this.readEarlier(snapshot, relative);
            call.before.set(relative, snapshot);
        }
    }

    /** Reads one at a time, and stops reading once the turn holds as much text as it may. */
    private readEarlier(snapshot: Snapshot, relative: string): Promise<string | null | undefined> {
        const read = runAfter(this.reading, async () => {
            if (snapshot.abandoned || this.bytes + this.held >= MAX_TRACKED_BYTES) {
                return undefined;
            }

            const text = await this.files.read(relative);

            // The call ended without writing meanwhile: nothing is to be held for it.
            if (snapshot.abandoned) {
                return undefined;
            }

            snapshot.size = sizeOf(text);
            this.held += snapshot.size;

            return text;
        });

        this.reading = settled(read);

        return read;
    }

    private commit(call: CallState): void {
        for (const [relative, diff] of call.diffs) {
            this.started = true;
            this.enqueue(async () => {
                // The path is inside the folder as written; a link in it may still lead out.
                const confined = await this.files.confines(relative);

                this.held -= diff.size;
                this.record(relative, diff.oldText, confined ? diff.newText : undefined);
            });
        }

        for (const [relative, snapshot] of call.before) {
            if (call.diffs.has(relative)) {
                // The diff stands in for the snapshot; the bytes the read held go back once it has finished.
                this.enqueue(async () => {
                    await snapshot.read;
                    this.held -= snapshot.size;
                });

                continue;
            }

            this.enqueue(async () => {
                const [earlier, later] = await Promise.all([snapshot.read, this.files.read(relative)]);

                this.held -= snapshot.size;
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

    private drop(relative: string): void {
        const known = this.tracked.get(relative);

        if (known !== undefined && known !== "dropped") {
            this.bytes -= known.size;
        }

        this.tracked.set(relative, "dropped");
        this.uses.delete(relative);
    }

    /** Keeps the first earlier text and the latest later text of a file; a side that cannot be known drops the file. */
    private record(relative: string, before: string | null | undefined, after: string | null | undefined): void {
        const known = this.tracked.get(relative);

        if (known === "dropped") {
            return;
        }

        if (before === undefined || after === undefined || before?.includes("\0") === true || after?.includes("\0") === true) {
            this.drop(relative);

            return;
        }

        const afterSize = sizeOf(after);
        const kept = known?.size ?? 0;
        const size = (known === undefined ? sizeOf(before) : kept - known.afterSize) + afterSize;

        if (Math.max(sizeOf(before), afterSize) > MAX_FILE_BYTES || this.bytes - kept + size + this.held > MAX_TRACKED_BYTES) {
            this.drop(relative);

            return;
        }

        this.bytes += size - kept;
        this.tracked.set(relative, known === undefined ? { after, afterSize, before, size } : { ...known, after, afterSize, size });
    }

    private build(): TurnSummary | undefined {
        const files: ChangedFile[] = [];
        const patches: string[] = [];
        const limits = newDiffLimits(MAX_PATCH_BYTES);
        let overflow = false;

        // eslint-disable-next-line unicorn/no-array-sort -- a copy; this package's TypeScript lib predates `toSorted`
        const entries = [...this.tracked].sort(([a], [b]) => a.localeCompare(b));

        for (const [relative, state] of entries) {
            // The path as it is sent, after masking: the backend refuses the whole post for one it does not take.
            const shown = state === "dropped" ? "" : this.scrub(relative);

            if (state === "dropped" || !isSummaryPath(shown)) {
                continue;
            }

            const diff = unifiedDiff(relative, state.before, state.after, limits);
            const created = state.before === null || state.after === null;

            // A write that left the file as it was is not a change; creating or deleting an empty file is.
            if (diff.added === 0 && diff.removed === 0 && (!created || state.before === state.after)) {
                continue;
            }

            files.push({ added: diff.added, path: shown, removed: diff.removed });

            if (diff.overflow === true) {
                overflow = true;
            } else {
                patches.push(this.scrub(diff.patch));
            }
        }

        if (files.length === 0) {
            return undefined;
        }

        const patch = patches.join("");

        return { files, patch: overflow || Buffer.byteLength(patch) > MAX_PATCH_BYTES ? { tooLarge: true } : patch };
    }
}
