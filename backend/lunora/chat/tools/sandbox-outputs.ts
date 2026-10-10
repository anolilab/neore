/**
 * Files a sandbox run writes to {@link SANDBOX_OUTPUT_DIR}, handed back to the
 * user as chat files.
 *
 * The directory is snapshotted before the run and listed again after it; only
 * files that are new or changed since the snapshot are collected, so a thread's
 * persistent sandbox does not re-deliver last turn's chart on every call. Each
 * collected file is stored content-addressed through `storeFile({ userId,
 * threadId })`, which writes the `chatFiles` row and the caller's (and the
 * thread owner's) `chatFileAccess` grant. The tool result carries only a
 * `storage:<key>` reference: `agent/stored-media.ts` signs it when the message
 * is read, and only for a reader whose message owner holds that grant
 * (`lib/storage-ownership.ts`), so nothing persists a URL and nobody else can
 * have the file signed for them.
 *
 * What the sandbox wrote is untrusted — the agent ran arbitrary code there —
 * so type comes from an allowlist keyed by extension, never from the file, and
 * size, count and total are capped before anything is read.
 */
import { toStorageRef } from "../../lib/storage-ref";

export const SANDBOX_OUTPUT_DIR = "/home/user/output";

/** Files collected per run; the rest are reported as skipped. */
export const MAX_OUTPUT_FILES = 10;

/** Per file. */
export const MAX_OUTPUT_FILE_BYTES = 10 * 1024 * 1024;

/** Across one run's collected files. */
export const MAX_OUTPUT_TOTAL_BYTES = 25 * 1024 * 1024;

/** Longest filename kept; longer names are truncated, extension preserved. */
const MAX_FILENAME_LENGTH = 120;

/**
 * Extension → content type. Anything else is skipped. No HTML, no scripts, no
 * executables: the signed-storage route serves active types as attachments,
 * but there is no reason for a sandbox run to hand one out at all. SVG is
 * allowed because charts are the main use; it is served sandboxed by CSP and
 * displayed through `<img>`, which never runs its script.
 */
export const SANDBOX_OUTPUT_TYPES: Readonly<Record<string, string>> = {
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    svg: "image/svg+xml",
    tsv: "text/tab-separated-values",
    txt: "text/plain",
    wav: "audio/wav",
    webp: "image/webp",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip",
};

const ALLOWED_CONTENT_TYPES: ReadonlyArray<string> = [...new Set(Object.values(SANDBOX_OUTPUT_TYPES))];

/** The part of an E2B `EntryInfo` this module reads. */
export interface SandboxEntry {
    modifiedTime?: Date;
    name: string;
    path: string;
    size: number;
    symlinkTarget?: string;
    type?: string;
}

/** The part of an E2B `Sandbox` this module uses. */
export interface OutputSandbox {
    files: {
        list: (path: string, options?: { depth?: number }) => Promise<SandboxEntry[]>;
        makeDir: (path: string) => Promise<boolean>;
        read: (path: string, options: { format: "bytes" }) => Promise<Uint8Array>;
    };
}

export type OutputSnapshot = ReadonlyMap<string, string>;

export type SkipReason = "failed" | "too-large" | "too-many" | "total-too-large" | "unsupported-type";

export interface SandboxOutputFile {
    mediaType: string;
    name: string;
    size: number;
    /** `storage:<key>` — signed when the message is read, never stored as a URL. */
    url: string;
}

export interface SkippedOutputFile {
    name: string;
    reason: SkipReason;
}

export interface SandboxOutputs {
    files: SandboxOutputFile[];
    skippedFiles: SkippedOutputFile[];
}

interface PlannedFile {
    mediaType: string;
    name: string;
    path: string;
    size: number;
}

export interface CollectionPlan {
    collect: PlannedFile[];
    skipped: SkippedOutputFile[];
}

/** Store the bytes as a chat file and return its storage key. */
export type StoreOutput = (bytes: Uint8Array, file: { mediaType: string; name: string }) => Promise<string>;

/** What the tool tells the model about the directory; spliced into tool descriptions. */
export const SANDBOX_OUTPUT_INSTRUCTIONS = `To hand a file to the user (a chart, a spreadsheet, a report), save it to ${SANDBOX_OUTPUT_DIR}/. New or changed files there are attached to your reply for download (at most ${MAX_OUTPUT_FILES} per run, ${MAX_OUTPUT_FILE_BYTES / 1024 / 1024} MB each; types: ${Object.keys(SANDBOX_OUTPUT_TYPES).join(", ")}). Mention them by name; do not print their contents.`;

const fingerprint = (entry: SandboxEntry): string => `${entry.size}:${entry.modifiedTime?.getTime() ?? ""}`;

/** Code-point order, independent of the runtime's locale (unlike `localeCompare`). */
const comparePaths = (a: string, b: string): number => {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

const isRegularFile = (entry: SandboxEntry): boolean => entry.type === "file" && !entry.symlinkTarget;

const extensionOf = (name: string): string => {
    const dot = name.lastIndexOf(".");

    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** A display name for a path under the output dir: its relative path, control characters stripped, length capped. */
export const outputFileName = (path: string): string => {
    const relative = path.startsWith(`${SANDBOX_OUTPUT_DIR}/`) ? path.slice(SANDBOX_OUTPUT_DIR.length + 1) : (path.split("/").pop() ?? path);
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    const clean = relative.replaceAll(/[\u{0}-\u{1F}\u{7F}]/gu, "").trim() || "file";

    if (clean.length <= MAX_FILENAME_LENGTH) {
        return clean;
    }

    const extension = extensionOf(clean);
    const suffix = extension ? `.${extension}` : "";

    return `${clean.slice(0, MAX_FILENAME_LENGTH - suffix.length)}${suffix}`;
};

/** `path → fingerprint` for every regular file listed. */
export const snapshotOf = (entries: ReadonlyArray<SandboxEntry>): OutputSnapshot =>
    new Map(entries.filter((entry) => isRegularFile(entry)).map((entry) => [entry.path, fingerprint(entry)]));

/**
 * Which listed files to collect: regular files (no symlinks — one could point
 * anywhere in the sandbox) that are new or changed since `before`, of an
 * allowed type, within the caps. Oldest-first order is not knowable, so files
 * are taken in code-point path order, which keeps the result deterministic.
 */
export const planOutputCollection = (before: OutputSnapshot, after: ReadonlyArray<SandboxEntry>): CollectionPlan => {
    const collect: PlannedFile[] = [];
    const skipped: SkippedOutputFile[] = [];
    let total = 0;

    const changed = after
        .filter((entry) => isRegularFile(entry) && before.get(entry.path) !== fingerprint(entry))
        .toSorted((a, b) => comparePaths(a.path, b.path));

    for (const entry of changed) {
        const name = outputFileName(entry.path);
        const mediaType = SANDBOX_OUTPUT_TYPES[extensionOf(name)];

        if (!mediaType) {
            skipped.push({ name, reason: "unsupported-type" });
        } else if (entry.size > MAX_OUTPUT_FILE_BYTES) {
            skipped.push({ name, reason: "too-large" });
        } else if (collect.length >= MAX_OUTPUT_FILES) {
            skipped.push({ name, reason: "too-many" });
        } else if (total + entry.size > MAX_OUTPUT_TOTAL_BYTES) {
            skipped.push({ name, reason: "total-too-large" });
        } else {
            total += entry.size;
            collect.push({ mediaType, name, path: entry.path, size: entry.size });
        }
    }

    return { collect, skipped };
};

const LIST_DEPTH = 3;

/** Snapshot the output dir before a run, creating it so the model can write there straight away. */
export const snapshotSandboxOutputs = async (sandbox: OutputSandbox): Promise<OutputSnapshot> => {
    await sandbox.files.makeDir(SANDBOX_OUTPUT_DIR);

    return snapshotOf(await sandbox.files.list(SANDBOX_OUTPUT_DIR, { depth: LIST_DEPTH }));
};

/**
 * Collect what the run wrote. A failure to read or store one file skips that
 * file rather than failing the run: the tool's own output is still valid.
 */
export const collectSandboxOutputs = async (sandbox: OutputSandbox, before: OutputSnapshot, store: StoreOutput): Promise<SandboxOutputs> => {
    let after: SandboxEntry[];

    try {
        after = await sandbox.files.list(SANDBOX_OUTPUT_DIR, { depth: LIST_DEPTH });
    } catch {
        // The run removed the directory; there is nothing to collect.
        return { files: [], skippedFiles: [] };
    }

    const plan = planOutputCollection(before, after);
    const files: SandboxOutputFile[] = [];
    const skippedFiles = [...plan.skipped];

    for (const planned of plan.collect) {
        try {
            const bytes = await sandbox.files.read(planned.path, { format: "bytes" });

            // The listing's size is the sandbox's word; the bytes are what gets stored.
            if (bytes.byteLength > MAX_OUTPUT_FILE_BYTES) {
                skippedFiles.push({ name: planned.name, reason: "too-large" });
                continue;
            }

            const key = await store(bytes, { mediaType: planned.mediaType, name: planned.name });

            files.push({ mediaType: planned.mediaType, name: planned.name, size: bytes.byteLength, url: toStorageRef(key) });
        } catch {
            skippedFiles.push({ name: planned.name, reason: "failed" });
        }
    }

    return { files, skippedFiles };
};

export const sandboxOutputContentTypes = (): ReadonlyArray<string> => ALLOWED_CONTENT_TYPES;
