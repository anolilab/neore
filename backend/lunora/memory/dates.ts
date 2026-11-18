/**
 * The days a memory is tied to. Every value is a local calendar day
 * (`YYYY-MM-DD`) in the user's timezone, the same form as `localDayOf`.
 *
 * - `validUntil`: the last day the fact holds ("in Lisbon until the 20th"). The
 *   day after, retrieval stops injecting it and nightly reflection retires it.
 * - `eventStart` / `eventEnd`: the day or days something happens. An event
 *   stays true after it is over, so it is never retired for its dates alone.
 *
 * A birthday or other yearly date has neither: it repeats, so it never ends.
 */
export interface FactDates {
    eventEnd?: string;
    eventStart?: string;
    validUntil?: string;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day in `YYYY-MM-DD` form, or `undefined`. */
const asDay = (value: string | null | undefined): string | undefined => {
    const match = value ? DAY_RE.exec(value.trim()) : null;

    if (!match) {
        return undefined;
    }

    const [, year, month, day] = match.map(Number) as [number, number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));

    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? match[0] : undefined;
};

/**
 * The dates an extractor returned, cleaned: malformed days dropped, an end
 * without a start read as a one-day event, an end before its start dropped, and
 * a one-day event stored as its start only.
 */
export const normalizeFactDates = (raw: { eventEnd?: string | null; eventStart?: string | null; validUntil?: string | null }): FactDates => {
    const validUntil = asDay(raw.validUntil);
    let eventStart = asDay(raw.eventStart);
    let eventEnd = asDay(raw.eventEnd);

    if (eventStart === undefined) {
        eventStart = eventEnd;
        eventEnd = undefined;
    }

    if (eventEnd !== undefined && eventStart !== undefined && eventEnd <= eventStart) {
        eventEnd = undefined;
    }

    return { ...(eventStart && { eventStart }), ...(eventEnd && { eventEnd }), ...(validUntil && { validUntil }) };
};

/**
 * Dates a person typed in the memory editor, or `undefined` when they cannot be stored: an empty field is no date,
 * any other must be a real day, and an event end needs a start it does not precede. An end on the start day is a
 * one-day event, stored as its start.
 */
export const userFactDates = (raw: { eventEnd?: string; eventStart?: string; validUntil?: string }): FactDates | undefined => {
    const typed = (value: string | undefined): string | false | undefined => (value?.trim() ? (asDay(value) ?? false) : undefined);
    const eventStart = typed(raw.eventStart);
    const eventEnd = typed(raw.eventEnd);
    const validUntil = typed(raw.validUntil);

    if (eventStart === false || eventEnd === false || validUntil === false) {
        return undefined;
    }

    if (eventEnd !== undefined && (eventStart === undefined || eventEnd < eventStart)) {
        return undefined;
    }

    return normalizeFactDates({ eventEnd, eventStart, validUntil });
};

export const hasFactDates = (dates: FactDates): boolean => dates.validUntil !== undefined || dates.eventStart !== undefined || dates.eventEnd !== undefined;

/** Whether the fact stopped holding before `today` (both local days). */
export const isExpired = (dates: { validUntil?: string | null }, today: string): boolean => typeof dates.validUntil === "string" && dates.validUntil < today;

export const sameFactDates = (a: FactDates, b: FactDates): boolean =>
    a.eventStart === b.eventStart && a.eventEnd === b.eventEnd && a.validUntil === b.validUntil;

/**
 * THE DATE RULE, the one place it is decided. When a newer statement revises,
 * merges into or confirms a memory, the newer statement's dates replace the
 * memory's, all three together: a date the newer statement does not carry is
 * cleared, a date it carries is set. `undefined` when nothing changes.
 *
 * Written through a `dates` field that replaces all three columns
 * (`reviseExtractedMemory`, `updateMemoryInternal`, reflection's patch op), so a cleared date is removed.
 */
export const restatedDates = (current: FactDates, newer: FactDates): FactDates | undefined => {
    const next = factDatesOf(newer);

    return sameFactDates(factDatesOf(current), next) ? undefined : next;
};

/** Two events on different days are two occurrences (two trips, two appointments), however alike their text. */
export const differentEventDays = (a: FactDates, b: FactDates): boolean =>
    a.eventStart !== undefined && b.eventStart !== undefined && a.eventStart !== b.eventStart;

/**
 * What a restatement does to the memory it matched, by {@link restatedDates}: the same dates
 * reconfirm it (`confirm`); other dates `replace` it with the newer statement, text and dates
 * together, so the text never names one day while the columns hold another. A pinned row is
 * kept as the user pinned it, and an event on another day is another occurrence: the newer
 * statement is saved `beside` it.
 */
export const restatementOutcome = (matched: FactDates & { pinned?: boolean }, newer: FactDates): "beside" | "confirm" | "replace" => {
    if (restatedDates(matched, newer) === undefined) {
        return "confirm";
    }

    return matched.pinned === true || differentEventDays(matched, newer) ? "beside" : "replace";
};

/** The three date columns of a write that replaces them: an absent date is `undefined`, which `patchRow` removes. */
export const dateColumns = (dates: FactDates): Required<Record<keyof FactDates, string | undefined>> => {
    return { eventEnd: dates.eventEnd, eventStart: dates.eventStart, validUntil: dates.validUntil };
};

/** The dates as a suffix for a prompt line, e.g. ` (happens 2026-11-20; holds until 2026-11-22)`. */
export const describeFactDates = (dates: FactDates): string => {
    const parts: string[] = [];

    if (dates.eventStart) {
        parts.push(dates.eventEnd ? `happens ${dates.eventStart} to ${dates.eventEnd}` : `happens ${dates.eventStart}`);
    }

    if (dates.validUntil) {
        parts.push(`holds until ${dates.validUntil}`);
    }

    return parts.length > 0 ? ` (${parts.join("; ")})` : "";
};

/** Only the date columns of a row, without empty keys. */
export const factDatesOf = (row: { eventEnd?: string | null; eventStart?: string | null; validUntil?: string | null }): FactDates => {
    return {
        ...(row.eventStart && { eventStart: row.eventStart }),
        ...(row.eventEnd && { eventEnd: row.eventEnd }),
        ...(row.validUntil && { validUntil: row.validUntil }),
    };
};
