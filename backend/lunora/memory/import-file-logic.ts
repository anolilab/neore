/**
 * Pure rules for importing memories from a text or JSON file (`memory/import.ts`, `importMemoryFile`). The file is
 * untrusted: every limit is checked here, before anything is embedded or written, and nothing is read from it that a
 * limit has not bounded. Entries keep the user's wording; the write path (`importFacts`) does the embedding, secret
 * redaction and de-duplication against stored memories.
 *
 * Text: one memory per non-empty line, never per blank-line-separated paragraph. Memories are short single facts, a
 * bulleted or numbered list is the common shape of an export, and a paragraph would fuse several facts into one row
 * that dedup could never match again. A bullet or number in front of a line is removed, as for a paste.
 *
 * JSON: an array whose items are strings, or objects with a text field (`content`, `text` or `memory`) and an
 * optional `type`. Any other top-level shape is refused; an item of another shape is counted as invalid.
 */
import { SECRET_NAME } from "../lib/secret-redaction";
import {
    capImportText,
    IMPORT_MAX_FACT_CHARS,
    importDedupKey,
    isLongEnoughFact,
    LINE_BREAK_RE,
    looksSensitive,
    redactImportText,
    unwrapImportLine,
} from "./import-logic";
import { isMemoryType, type MemoryType } from "./taxonomy";

/**
 * Largest file accepted, in UTF-8 bytes. The file travels as a JSON string in a request body the runtime reads with a
 * 1,048,576-byte cap (a 413 before the action runs). JSON escaping grows a quote, a backslash or a line break to two
 * bytes, so a file near the runtime's own size can be refused by the transport; half of it leaves room for those. A
 * file made mostly of control characters (six bytes each once escaped) can still exceed the cap and be refused there.
 */
export const MEMORY_FILE_MAX_BYTES = 500_000;

/** Most entries (non-empty lines, or array items) one file may hold; a file with more is refused, not cut. */
export const MEMORY_FILE_MAX_ENTRIES = 5000;

/** Longest single entry, as the longest stored fact. A longer one is skipped and counted, never cut. */
export const MEMORY_FILE_ENTRY_MAX_CHARS = IMPORT_MAX_FACT_CHARS;

/** Entries parsed, and written, per batch. */
export const MEMORY_FILE_BATCH_SIZE = 25;

/**
 * Most entries a file may hold to be imported in the request that sends it. One write of a batch costs a dozen fixed
 * calls plus its dedup budget, and a Worker request is capped on subrequests, so an inline import is one batch. A
 * larger file waits for the background import.
 */
export const MEMORY_FILE_INLINE_MAX_ENTRIES = MEMORY_FILE_BATCH_SIZE;

/** Type given to a text entry, and to a JSON one that names none: a type that never decays. */
export const MEMORY_FILE_DEFAULT_TYPE: MemoryType = "context";

/** Shown for a file over {@link MEMORY_FILE_MAX_BYTES}, whether the length or the byte count is what refuses it. */
export const MEMORY_FILE_TOO_LARGE_MESSAGE = `The file is larger than ${String(MEMORY_FILE_MAX_BYTES / 1000)} KB.`;

export const MEMORY_FILE_TOO_LARGE_INLINE_MESSAGE = `This file has more than ${String(MEMORY_FILE_INLINE_MAX_ENTRIES)} memories. Importing larger files is not available yet; it will come in a later change.`;

const TEXT_FIELDS = ["content", "text", "memory"] as const;
const BYTE_ORDER_MARK = "\u{FEFF}";

export type MemoryFileFormat = "json" | "text";

export type MemoryFileErrorCode = "bad_json" | "bad_shape" | "empty" | "secret_continues" | "too_large" | "too_many_entries";

/** A file refused as a whole. The message is shown to the user as is. */
export class MemoryFileError extends Error {
    readonly code: MemoryFileErrorCode;

    constructor(code: MemoryFileErrorCode, message: string) {
        super(message);
        this.name = "MemoryFileError";
        this.code = code;
    }
}

export interface MemoryFileEntry {
    memory: string;
    type: MemoryType;
}

export interface ParsedMemoryFile {
    /** The kept entries in file order, in batches of at most {@link MEMORY_FILE_BATCH_SIZE}. */
    batches: MemoryFileEntry[][];
    /** Entries whose normalised text an earlier entry of the file already had. */
    duplicates: number;
    /** Entries kept: the sum of the batches. */
    entries: number;
    /** Entries that are not a memory: a wrong shape, too short, or a secret or sensitive identifier. */
    invalid: number;
    /** Entries longer than {@link MEMORY_FILE_ENTRY_MAX_CHARS}. */
    tooLong: number;
    /** Entries read: kept, duplicate, too long and invalid. Blank lines are not entries. */
    total: number;
}

type Prepared = { memory: string; status: "ok" } | { status: "blank" } | { status: "invalid" } | { status: "tooLong" };

/**
 * The longest raw entry worth redacting. A marker is longer than the shortest secret it replaces, so an entry past the
 * limit can shrink below it, but not from beyond ten times as long.
 */
const MEMORY_FILE_ENTRY_PREPARE_MAX_CHARS = MEMORY_FILE_ENTRY_MAX_CHARS * 10;

/** One raw entry as a memory: wrapping removed, whitespace collapsed, secrets redacted, then its length checked. */
const prepareEntry = (raw: string): Prepared => {
    const unwrapped = unwrapImportLine(raw);

    if (raw.trim() === "") {
        return { status: "blank" };
    }

    if (unwrapped === "") {
        return { status: "invalid" };
    }

    if (unwrapped.length > MEMORY_FILE_ENTRY_PREPARE_MAX_CHARS) {
        return { status: "tooLong" };
    }

    const cleaned = redactImportText(raw);

    if (cleaned === null) {
        return { status: "invalid" };
    }

    if (cleaned.length > MEMORY_FILE_ENTRY_MAX_CHARS) {
        return { status: "tooLong" };
    }

    const memory = capImportText(cleaned);

    return memory !== null && isLongEnoughFact(memory) && !looksSensitive(memory) ? { memory, status: "ok" } : { status: "invalid" };
};

/** The items as slices of at most `size`. */
export const toBatches = <T>(items: ReadonlyArray<T>, size: number): T[][] => {
    const batches: T[][] = [];

    for (let start = 0; start < items.length; start += size) {
        batches.push(items.slice(start, start + size));
    }

    return batches;
};

const SECRET_LABEL = new RegExp(String.raw`\b${SECRET_NAME}["']?[^\S\n]*[:=]`, "giu");

/** Where the quote `quote` that opened a value at `from` is closed on this line (the index after it), or `-1`. */
const closingQuoteOnLine = (line: string, from: number, quote: string): number => {
    for (let index = from; index < line.length; index += 1) {
        if (line[index] === "\\") {
            index += 1;
        } else if (line[index] === quote) {
            return index + 1;
        }
    }

    return -1;
};

/** True when the line ends in an unescaped backslash: an odd run of them, ignoring trailing whitespace. One scan from the end. */
const endsInLineContinuation = (line: string): boolean => {
    const trimmed = line.trimEnd();
    let backslashes = 0;

    while (trimmed[trimmed.length - backslashes - 1] === "\\") {
        backslashes += 1;
    }

    return backslashes % 2 === 1;
};

/**
 * True when one line names a secret (`DB_PASSWORD=`, `api_token:`) and its value does not end on that line: nothing
 * follows the `=` or `:`, a quote opened right after it has no matching one later on the line, or the line ends in an
 * unescaped backslash (a line continuation). Such a value goes on to the next line, and the redaction reads one line at
 * a time, so its continuation would be read as a memory. The file is refused rather than guessing where the value ends.
 * A label inside a quoted value already read is skipped.
 */
const secretContinues = (line: string): boolean => {
    let named = false;
    let readUntil = 0;

    for (const match of line.matchAll(SECRET_LABEL)) {
        if (match.index < readUntil) {
            continue;
        }

        let start = match.index + match[0].length;

        while (start < line.length && line[start]?.trim() === "") {
            start += 1;
        }

        if (start === line.length) {
            return true;
        }

        const quote = line[start];

        if (quote === '"' || quote === "'") {
            readUntil = closingQuoteOnLine(line, start + 1, quote);

            if (readUntil === -1) {
                return true;
            }
        }

        named = true;
    }

    return named && endsInLineContinuation(line);
};

/** The one-based number of the first line of `lines` that {@link secretContinues}, or `undefined`. */
const firstSecretContinuingLine = (lines: ReadonlyArray<string>): number | undefined => {
    const index = lines.findIndex((line) => secretContinues(line));

    return index === -1 ? undefined : index + 1;
};

/** A raw entry before preparing: its text (or `undefined` for a wrong shape) and the type it names. */
type RawEntry = { text: string | undefined; type: MemoryType };

/** An item's text, or `undefined` when a secret in it continues past its line: the item is skipped, the file is not. */
const itemText = (text: string): string | undefined => (firstSecretContinuingLine(text.split(LINE_BREAK_RE)) === undefined ? text : undefined);

const textOfJsonItem = (item: unknown): RawEntry => {
    if (typeof item === "string") {
        return { text: itemText(item), type: MEMORY_FILE_DEFAULT_TYPE };
    }

    if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return { text: undefined, type: MEMORY_FILE_DEFAULT_TYPE };
    }

    const record = item as { [key: string]: unknown };
    const field = TEXT_FIELDS.find((name) => typeof record[name] === "string" && (record[name] as string).trim() !== "");
    const type = isMemoryType(record.type) ? record.type : MEMORY_FILE_DEFAULT_TYPE;

    return { text: field === undefined ? undefined : itemText(record[field] as string), type };
};

const rawEntriesOf = (content: string, format: MemoryFileFormat): RawEntry[] => {
    const body = content.startsWith(BYTE_ORDER_MARK) ? content.slice(1) : content;

    if (format === "text") {
        const lines = body.split(LINE_BREAK_RE);
        const continuing = firstSecretContinuingLine(lines);

        if (continuing !== undefined) {
            throw new MemoryFileError(
                "secret_continues",
                `Line ${String(continuing)} holds a password or key whose value continues on the next line. Remove it and try again.`,
            );
        }

        return lines
            .filter((line) => line.trim() !== "")
            .map((text) => {
                return { text, type: MEMORY_FILE_DEFAULT_TYPE };
            });
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(body);
    } catch {
        throw new MemoryFileError("bad_json", "The file is not valid JSON.");
    }

    if (!Array.isArray(parsed)) {
        throw new MemoryFileError("bad_shape", 'The JSON must be an array of strings, or of objects with a "content", "text" or "memory" field.');
    }

    return parsed.map((item) => textOfJsonItem(item));
};

/**
 * The file as batches of memories to write, with a count of everything left out. Refuses the file as a whole (a
 * {@link MemoryFileError}) when it is over the size limit, is not valid for its format, holds more than
 * {@link MEMORY_FILE_MAX_ENTRIES} entries, or holds no entry at all. Entries are prepared a batch at a time.
 */
export const parseMemoryFile = (content: string, format: MemoryFileFormat): ParsedMemoryFile => {
    // UTF-16 length is at most the byte length: a string over the byte limit by length is over it by bytes too.
    if (content.length > MEMORY_FILE_MAX_BYTES || new TextEncoder().encode(content).length > MEMORY_FILE_MAX_BYTES) {
        throw new MemoryFileError("too_large", MEMORY_FILE_TOO_LARGE_MESSAGE);
    }

    const raw = rawEntriesOf(content, format);

    if (raw.length > MEMORY_FILE_MAX_ENTRIES) {
        throw new MemoryFileError("too_many_entries", `The file has more than ${String(MEMORY_FILE_MAX_ENTRIES)} memories.`);
    }

    const seen = new Set<string>();
    const kept: MemoryFileEntry[] = [];
    const counts = { duplicates: 0, invalid: 0, tooLong: 0, total: 0 };

    for (const batch of toBatches(raw, MEMORY_FILE_BATCH_SIZE)) {
        for (const { text, type } of batch) {
            const prepared: Prepared = text === undefined ? { status: "invalid" } : prepareEntry(text);

            if (prepared.status === "blank") {
                continue;
            }

            counts.total += 1;

            if (prepared.status !== "ok") {
                counts[prepared.status] += 1;
                continue;
            }

            const key = importDedupKey(prepared.memory);

            if (seen.has(key)) {
                counts.duplicates += 1;
            } else {
                seen.add(key);
                kept.push({ memory: prepared.memory, type });
            }
        }
    }

    if (counts.total === 0) {
        throw new MemoryFileError("empty", "The file has no memories in it.");
    }

    return { batches: toBatches(kept, MEMORY_FILE_BATCH_SIZE), entries: kept.length, ...counts };
};
