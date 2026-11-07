/**
 * The part of a check's log an agent reads: the lines around the failure, cut to a cap. Pure, so the cut is tested on
 * its own. A job log can run to megabytes; only its tail is read (`readTail`), and only an excerpt of that is kept.
 *
 * A job's log lives on a storage origin the API redirects to, at a signed address that needs no token. The address is
 * fetched only when it is https on one of the host's storage origins, and the token never goes along.
 */
import type { CheckLog } from "./types";

/** Longest excerpt one check gives an agent. */
export const LOG_EXCERPT_MAX_CHARS = 4000;

/** Bytes of a log's end that are kept while it streams past: the failure is near the end. */
export const LOG_TAIL_BYTES = 256_000;

/** Bytes read of one log before the read stops: past it, what was kept so far is the excerpt's source. */
export const LOG_READ_MAX_BYTES = 16_000_000;

/** Lines kept before a failure marker, and after it. */
const LINES_BEFORE = 20;
const LINES_AFTER = 5;

/** The storage origins a job log is handed to. A redirect anywhere else is not followed. */
const LOG_HOST_SUFFIXES = [".actions.githubusercontent.com", ".blob.core.windows.net"];

export const isLogAddress = (address: string): boolean => {
    try {
        const url = new URL(address);

        // An address that carries a user part is not one the host hands out.
        const plain = url.username.length === 0 && url.password.length === 0;

        return url.protocol === "https:" && plain && LOG_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
    } catch {
        return false;
    }
};

// eslint-disable-next-line no-control-regex -- terminal colour codes are exactly what this removes
const ANSI = /\u{1B}\[[\d;?]*[A-Za-z]/gu;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u;
const ERROR_MARKER = /##\[error\]/u;
const ERROR_WORDS = /\b(?:error|failed|failure|panicked|exception)\b/iu;

const LINE_BREAK = /\r?\n/u;

const cleanLine = (line: string): string => line.replace(TIMESTAMP, "").replaceAll(ANSI, "").trimEnd();

/** The last `maxChars` of `text`, starting on a whole line when one fits. */
const tailOf = (text: string, maxChars: number): string => {
    if (maxChars <= 0) {
        return "";
    }

    if (text.length <= maxChars) {
        return text;
    }

    const cut = text.slice(-maxChars);
    const newline = cut.indexOf("\n");

    return newline !== -1 && newline < cut.length - 1 ? cut.slice(newline + 1) : cut;
};

/**
 * The lines around the failure markers (the host's own `##[error]`, else words that name one), the last ones first
 * when they do not all fit, else the log's tail. `partial` says the text given is already only part of the log.
 */
const cutLog = (raw: string, maxChars: number, partial: boolean): CheckLog => {
    const lines = raw.split(LINE_BREAK).map((line) => cleanLine(line));

    while (lines.length > 0 && lines.at(-1) === "") {
        lines.pop();
    }

    if (lines.length === 0) {
        return { excerpt: "", source: "job_log", truncated: partial };
    }

    const markerAt = (pattern: RegExp): number[] => lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
    const hosted = markerAt(ERROR_MARKER);
    const markers = hosted.length > 0 ? hosted : markerAt(ERROR_WORDS);

    if (markers.length === 0) {
        const whole = lines.join("\n");
        const excerpt = tailOf(whole, maxChars);

        return { excerpt, source: "job_log", truncated: partial || excerpt.length < whole.length };
    }

    // Windows around each marker, merged where they overlap, taken from the last one back until the cap.
    const windows: { end: number; marker: number; start: number }[] = [];

    for (const index of markers) {
        const start = Math.max(0, index - LINES_BEFORE);
        const end = Math.min(lines.length, index + LINES_AFTER + 1);
        const last = windows.at(-1);

        if (last && start <= last.end) {
            last.end = Math.max(last.end, end);
            last.marker = index;
        } else {
            windows.push({ end, marker: index, start });
        }
    }

    const kept: string[] = [];
    let used = 0;
    let cut = false;

    for (const window of windows.toReversed()) {
        const text = lines.slice(window.start, window.end).join("\n");
        const separator = kept.length > 0 ? 5 : 0;

        if (used + separator + text.length > maxChars) {
            // Even the last window does not fit: its failure line stays, with as many lines before it as there is room for.
            if (kept.length === 0) {
                kept.unshift(aroundMarker(lines, window, maxChars));
            }

            cut = true;
            break;
        }

        kept.unshift(text);
        used += separator + text.length;
    }

    const covered = windows.length === 1 && windows[0]?.start === 0 && windows[0].end === lines.length;

    return { excerpt: kept.join("\n...\n"), source: "job_log", truncated: partial || cut || !covered };
};

/** The failure line of a window that does not fit, cut to `maxChars`, and the lines just before it while they fit. */
const aroundMarker = (lines: string[], window: { marker: number; start: number }, maxChars: number): string => {
    const marker = lines[window.marker] ?? "";

    if (marker.length >= maxChars) {
        return marker.slice(0, Math.max(0, maxChars));
    }

    const kept = [marker];
    let used = marker.length;

    for (let index = window.marker - 1; index >= window.start; index -= 1) {
        const line = lines[index] ?? "";

        if (used + 1 + line.length > maxChars) {
            break;
        }

        kept.unshift(line);
        used += 1 + line.length;
    }

    return kept.join("\n");
};

/** Room kept for the marker line at the head of a cut excerpt. */
const MARKER_ROOM = 64;

/**
 * The excerpt with its marker: `[truncated, N more lines]` first when lines of the text were left out, so a reader of
 * the excerpt alone knows it is part of the log. Inside `maxChars` all told.
 */
export const excerptLog = (raw: string, maxChars: number = LOG_EXCERPT_MAX_CHARS, partial = false): CheckLog => {
    const lineCount = raw.split(LINE_BREAK).length;
    const cut = cutLog(raw, maxChars - MARKER_ROOM, partial);

    if (!cut.truncated) {
        return cut;
    }

    const shownLines = cut.excerpt === "" ? 0 : cut.excerpt.split("\n").filter((line) => line !== "...").length;
    const more = Math.max(0, lineCount - shownLines);
    const where = partial ? " before these" : "";
    const marker = more > 0 ? `[truncated, ${String(more)} more lines${where}]` : "[truncated]";

    // However small the budget, the excerpt never passes it: the marker first, then what fits of the cut.
    return { ...cut, excerpt: `${marker}\n${cut.excerpt}`.slice(0, Math.max(0, maxChars)) };
};

/**
 * A body read to its end keeping only its last `keepBytes`, and at most `maxBytes` read. `endReached` is `false` when
 * the read stopped first (the cap, or a cut-off after some bytes): the text kept is then not the body's end.
 */
export const readTail = async (
    response: Response,
    keepBytes: number = LOG_TAIL_BYTES,
    maxBytes: number = LOG_READ_MAX_BYTES,
): Promise<{ endReached: boolean; partial: boolean; text: string }> => {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let kept = 0;
    let received = 0;
    let dropped = false;
    let endReached = false;

    while (reader) {
        let next: ReadableStreamReadResult<Uint8Array>;

        try {
            next = await reader.read();
        } catch (error) {
            // Cut off (the deadline, the connection): what was read is still the log's latest part. Nothing read is a failure.
            if (received === 0) {
                throw error;
            }

            dropped = true;
            break;
        }

        const { done, value } = next;

        if (done) {
            endReached = true;
            break;
        }

        // A chunk that crosses the read cap is taken only up to it: nothing past the cap is kept or counted.
        const room = maxBytes - received;
        // A copy, not a view: the bytes past the cap must not keep the chunk's buffer alive.
        const taken = value.byteLength > room ? value.slice(0, room) : value;

        received += taken.byteLength;
        // A chunk larger than what is kept is copied down to its tail: neither it nor its buffer stays whole.
        const tail = taken.byteLength > keepBytes ? taken.slice(taken.byteLength - keepBytes) : taken;

        if (tail !== taken) {
            dropped = true;
        }

        chunks.push(tail);
        kept += tail.byteLength;

        while (chunks.length > 1 && kept - (chunks[0]?.byteLength ?? 0) >= keepBytes) {
            kept -= chunks.shift()?.byteLength ?? 0;
            dropped = true;
        }

        if (received >= maxBytes) {
            await reader.cancel().catch(() => undefined);
            dropped = true;
            break;
        }
    }

    const bytes = new Uint8Array(kept);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    const start = Math.max(0, bytes.byteLength - keepBytes);

    return { endReached, partial: dropped || start > 0, text: new TextDecoder().decode(bytes.subarray(start)) };
};

/** The excerpt of a log read with {@link readTail}, marked when the read did not reach the log's end. */
export const excerptRead = (read: { endReached: boolean; partial: boolean; text: string }, maxChars: number): CheckLog => {
    if (read.endReached) {
        return excerptLog(read.text, maxChars, read.partial);
    }

    // The log goes on past what was read: said at the end, where its failure may still be. Inside the cap all told.
    const ending = "\n[truncated, the log goes on past what was read]";
    const log = excerptLog(read.text, maxChars - ending.length, read.partial);

    const excerpt = `${log.excerpt}${ending}`;

    // A budget smaller than the ending keeps the ending's own last characters: never more than the cap.
    return { ...log, endRead: false, excerpt: maxChars <= 0 ? "" : excerpt.slice(-maxChars), truncated: true };
};
