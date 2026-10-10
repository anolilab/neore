/**
 * Cursor pagination for list endpoints.
 *
 * Every list answers `{ data: [...], nextCursor: string | null }` and accepts
 * `?limit=&cursor=`. The cursor is OPAQUE: base64url JSON that wraps either the
 * underlying procedure's own continuation cursor (`n`, native — threads,
 * messages) or an offset into a bounded list (`o` — the procedures that return
 * a complete, capped array: memories, tasks, knowledge files, skills). Callers
 * never learn which, so a list can move from one to the other without a
 * breaking change.
 */
import { PublicApiError } from "./errors";

export const DEFAULT_PAGE_SIZE = 20;

export const MAX_PAGE_SIZE = 100;

type CursorPayload = { c: string; k: "n" } | { k: "o"; o: number };

const toBase64Url = (text: string): string => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const fromBase64Url = (value: string): string => {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));

    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0));
};

const encode = (payload: CursorPayload): string => toBase64Url(JSON.stringify(payload));

const decode = (cursor: string): CursorPayload => {
    try {
        const parsed = JSON.parse(fromBase64Url(cursor)) as unknown;

        if (parsed && typeof parsed === "object") {
            const candidate = parsed as { c?: unknown; k?: unknown; o?: unknown };

            if (candidate.k === "n" && typeof candidate.c === "string") {
                return { c: candidate.c, k: "n" };
            }

            if (candidate.k === "o" && typeof candidate.o === "number" && Number.isSafeInteger(candidate.o) && candidate.o >= 0) {
                return { k: "o", o: candidate.o };
            }
        }
    } catch {
        // fall through
    }

    throw new PublicApiError("invalid_request", "The cursor is malformed. Pass back `nextCursor` from a previous page unchanged.");
};

/** `?limit=` — defaults to 20, clamped to 1..100, rejects non-numbers. */
export const parseLimit = (raw: string | undefined): number => {
    if (raw === undefined || raw === "") {
        return DEFAULT_PAGE_SIZE;
    }

    const value = Number(raw);

    if (!Number.isSafeInteger(value) || value < 1) {
        throw new PublicApiError("invalid_request", "`limit` must be a positive integer.");
    }

    return Math.min(value, MAX_PAGE_SIZE);
};

export const encodeNativeCursor = (cursor: string | null, isDone: boolean): string | null => (isDone || !cursor ? null : encode({ c: cursor, k: "n" }));

/** The procedure cursor to resume from, or `null` for the first page. */
export const decodeNativeCursor = (cursor: string | undefined): string | null => {
    if (!cursor) {
        return null;
    }

    const payload = decode(cursor);

    if (payload.k !== "n") {
        throw new PublicApiError("invalid_request", "The cursor belongs to a different list.");
    }

    return payload.c;
};

/** Page an already-materialised array. */
export const paginateArray = <T>(items: ReadonlyArray<T>, cursor: string | undefined, limit: number): { data: T[]; nextCursor: string | null } => {
    let offset = 0;

    if (cursor) {
        const payload = decode(cursor);

        if (payload.k !== "o") {
            throw new PublicApiError("invalid_request", "The cursor belongs to a different list.");
        }

        offset = payload.o;
    }

    const data = items.slice(offset, offset + limit);
    const next = offset + data.length;

    return { data, nextCursor: next < items.length ? encode({ k: "o", o: next }) : null };
};
