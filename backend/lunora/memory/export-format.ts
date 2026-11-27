/**
 * The user's own memories as text they can read: the Markdown file Memory settings downloads
 * (`exportMemoriesMarkdown`) and the short digest the messenger `/memory` command replies with.
 *
 * Pure: the rows, bot labels and clock come in; nothing is read here. Instants (`lastConfirmedAt`) become calendar
 * days in the user's timezone (UTC when unset or unknown, as everywhere in memory); the fact dates are stored as local
 * days already and are printed as they are. Evidence quotes are never included.
 */
import type { ImportApp } from "./import-logic";
import { isExpired } from "./dates";
import { localDayOf, resolveTimeZone } from "./reflection-logic";
import { MEMORY_TYPES, type MemoryType } from "./taxonomy";

export interface ExportMemoryRow {
    botId?: string;
    eventEnd?: string;
    eventStart?: string;
    importance?: number;
    importedFrom?: ImportApp;
    lastConfirmedAt: number;
    memory: string;
    pinned: boolean;
    source?: string;
    type: MemoryType;
    validUntil?: string;
}

/** Who a bot memory belongs to, as far as the user's shard can tell (`resolveMemoryBotLabels`). */
export type BotLabel = { kind: "deleted" | "shared" | "unknown" } | { kind: "named"; name: string };

const TYPE_TITLES: Record<MemoryType, string> = {
    activity: "Activity",
    context: "Context",
    experience: "Experience",
    identity: "Identity",
    preference: "Preferences",
};

/** Unpinned rows one export holds: the settings list's own cap, so the file holds what the list can show. */
export const MEMORY_EXPORT_MAX_ROWS = 2000;
/** Active rows one export reads at most: the account export's own memory cap. */
export const MEMORY_EXPORT_SCAN_ROWS = 5000;

const SCAN_LABEL = `${MEMORY_EXPORT_SCAN_ROWS.toLocaleString("en-US")} memories`;

/** The local day an export is dated (its header and its file name), in the user's timezone or UTC. */
export const exportDayOf = (now: number, timeZone: string | null | undefined): string => localDayOf(now, resolveTimeZone(timeZone));

const IMPORT_APPS: Record<ImportApp, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", other: "another assistant" };

const LINE_BREAKS = /[\r\n\u{2028}\u{2029}]+/gu;

/** One line of text: a memory or a bot name never starts a line (or a heading) of its own. */
const oneLine = (text: string): string => text.replaceAll(LINE_BREAKS, " ").trim();

/** One line, cut to `max` characters with an ellipsis. */
const cutTo = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const scopeOf = (row: ExportMemoryRow, bots: ReadonlyMap<string, BotLabel>, nameMax = Infinity): string => {
    if (row.botId === undefined) {
        return "all chats";
    }

    const label = bots.get(row.botId);

    switch (label?.kind) {
        case "named": {
            return `bot “${cutTo(oneLine(label.name), nameMax)}”`;
        }
        case "shared": {
            return "a shared chat's bot";
        }
        case "unknown": {
            return "a bot";
        }
        default: {
            return "a deleted bot";
        }
    }
};

const sourceOf = (row: ExportMemoryRow): string => {
    switch (row.source) {
        case "compressed": {
            return "summarised from earlier memories";
        }
        case "imported": {
            return `imported from ${IMPORT_APPS[row.importedFrom ?? "other"]}`;
        }
        case "manual": {
            return "added by you";
        }
        case "reflection": {
            return "combined from earlier memories overnight";
        }
        default: {
            // `auto`, or a row from before the column.
            return "learned in chat";
        }
    }
};

const datesOf = (row: ExportMemoryRow, timeZone: string, today: string): string[] => {
    const dates = [`last confirmed ${localDayOf(row.lastConfirmedAt, timeZone)}`];

    if (row.eventStart !== undefined && row.eventEnd !== undefined && row.eventEnd !== row.eventStart) {
        dates.push(`event ${row.eventStart} to ${row.eventEnd}`);
    } else if (row.eventStart !== undefined) {
        dates.push(`event ${row.eventStart}`);
    }

    if (row.validUntil !== undefined) {
        dates.push(isExpired(row, today) && !row.pinned ? `until ${row.validUntil} (ended)` : `until ${row.validUntil}`);
    }

    return dates;
};

/** Newest confirmation first. */
const byConfirmed = (a: ExportMemoryRow, b: ExportMemoryRow): number => b.lastConfirmedAt - a.lastConfirmedAt;

export interface MemoryMarkdownOptions {
    bots: ReadonlyMap<string, BotLabel>;
    now: number;
    timeZone: string | null | undefined;
    /** More rows exist than were read: the file says so. */
    truncated: boolean;
}

/**
 * The file: a header, the pinned memories, then one section per type (taxonomy order), newest confirmation first.
 * Each line is the memory, then its type (pinned section only), dates, source and scope.
 */
export const formatMemoryMarkdown = (rows: ReadonlyArray<ExportMemoryRow>, options: MemoryMarkdownOptions): string => {
    const timeZone = resolveTimeZone(options.timeZone);
    const today = exportDayOf(options.now, timeZone);
    const line = (row: ExportMemoryRow, withType: boolean): string => {
        const details = [
            ...(withType ? [TYPE_TITLES[row.type].toLowerCase()] : []),
            ...datesOf(row, timeZone, today),
            sourceOf(row),
            scopeOf(row, options.bots),
        ];

        return `- ${oneLine(row.memory)} — ${details.join(" · ")}`;
    };
    const pinned = rows.filter((row) => row.pinned).toSorted(byConfirmed);
    const lines = [
        "# Your memories",
        "",
        `Exported ${today}. ${String(rows.length)} ${rows.length === 1 ? "memory" : "memories"}, ${String(pinned.length)} pinned. Dates are calendar days in ${timeZone}.`,
    ];

    if (options.truncated) {
        lines.push(
            "",
            `This file is cut: it holds the pinned memories and the ${String(MEMORY_EXPORT_MAX_ROWS)} most recently saved others among your newest ${SCAN_LABEL} (by when each was saved, not last confirmed). Older ones are left out; the account data export in Privacy settings holds up to ${SCAN_LABEL}, earlier versions included.`,
        );
    }

    if (rows.length === 0) {
        lines.push("", "Nothing is remembered yet.");
    }

    if (pinned.length > 0) {
        lines.push("", `## Pinned (${String(pinned.length)})`, "", ...pinned.map((row) => line(row, true)));
    }

    for (const type of MEMORY_TYPES) {
        const ofType = rows.filter((row) => !row.pinned && row.type === type).toSorted(byConfirmed);

        if (ofType.length > 0) {
            lines.push("", `## ${TYPE_TITLES[type]} (${String(ofType.length)})`, "", ...ofType.map((row) => line(row, false)));
        }
    }

    return `${lines.join("\n")}\n`;
};

/** Below Discord's 2000-character message limit: the digest is one message on every platform that allows that much. */
export const MEMORY_DIGEST_MAX_CHARS = 1800;
export const MEMORY_DIGEST_TOP = 10;
const DIGEST_LINE_MAX = 200;

export const MEMORY_OFF_DIGEST = "Memory is off for your account, so nothing new is remembered. Turn it on in Settings → Personalization → Memory.";
const DIGEST_POINTER = "The full list, with dates: Settings → Personalization → Memory → Download memories.";

/** The importance a row with none is read as, as retrieval and reflection read it (`retrieve-ranking.ts`, `reflection.ts`). */
const UNSCORED_IMPORTANCE = 50;
/** A bot name in a digest line is cut here, so one long name cannot fill a short message. */
const DIGEST_BOT_NAME_MAX = 40;

/** Pinned first, then the most important, then the most recently confirmed. */
const byWeight = (a: ExportMemoryRow, b: ExportMemoryRow): number =>
    Number(b.pinned) - Number(a.pinned) ||
    (b.importance ?? UNSCORED_IMPORTANCE) - (a.importance ?? UNSCORED_IMPORTANCE) ||
    b.lastConfirmedAt - a.lastConfirmedAt;

/**
 * The `/memory` reply: counts by type, then up to ten memories (pinned first; an unpinned one past its end date is
 * left out), each with its source and scope as the file labels them, cut to `maxChars` (the platform's message limit, at most {@link MEMORY_DIGEST_MAX_CHARS}). The pointer to the
 * full list always fits: a line that does not fit is skipped and the next tried. A bot name is cut to 40 characters.
 */
export const formatMemoryDigest = (
    rows: ReadonlyArray<ExportMemoryRow>,
    options: { bots: ReadonlyMap<string, BotLabel>; maxChars?: number; now: number; timeZone: string | null | undefined; truncated: boolean },
): string => {
    if (rows.length === 0) {
        return `Nothing is remembered yet.\n\n${DIGEST_POINTER}`;
    }

    const maxChars = Math.min(options.maxChars ?? MEMORY_DIGEST_MAX_CHARS, MEMORY_DIGEST_MAX_CHARS);
    const today = exportDayOf(options.now, options.timeZone);
    const counts = MEMORY_TYPES.map((type) => [type, rows.filter((row) => row.type === type).length] as const)
        .filter(([, count]) => count > 0)
        .map(([type, count]) => `${TYPE_TITLES[type].toLowerCase()} ${String(count)}`);
    const total = `${options.truncated ? "More than " : ""}${String(rows.length)}`;
    const head = `${total} ${rows.length === 1 ? "memory" : "memories"} (${counts.join(", ")}).`;
    const top = rows
        .filter((row) => row.pinned || !isExpired(row, today))
        .toSorted(byWeight)
        .slice(0, MEMORY_DIGEST_TOP)
        .map((row) => {
            const text = oneLine(row.memory);

            return `${row.pinned ? "📌" : "•"} ${cutTo(text, DIGEST_LINE_MAX)} — ${sourceOf(row)} · ${scopeOf(row, options.bots, DIGEST_BOT_NAME_MAX)}`;
        });
    const tail = `\n\n${DIGEST_POINTER}`;
    let body = head;
    let listed = 0;

    // An entry that does not fit the room left is skipped, not the end of the list: a shorter one after it may fit.
    for (const entry of top) {
        const next = `${body}${listed === 0 ? "\n\n" : "\n"}${entry}`;

        if (next.length + tail.length <= maxChars) {
            body = next;
            listed += 1;
        }
    }

    return `${body}${tail}`;
};
