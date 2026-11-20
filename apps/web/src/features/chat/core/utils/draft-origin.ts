import { stripHiddenText } from "@neore/ai/utils";

/**
 * Text that entered the composer without the person typing it: a prompt link (`?prompt=`), a desktop `neore://new?text=`
 * link, or a saved prompt someone else wrote. A send whose text still holds any of it names where it came from
 * (`draftFrom`), and the backend saves the prompt marked (`backend/lunora/lib/not-typed-text.ts`), so the agent never
 * reads it as the person's own words when deciding what it may do on their behalf (a saved site login).
 *
 * Kept by the text itself rather than on the draft: a draft moves between panes, is stored for a reload, queued, and
 * handed back after a failed send, and each of those would otherwise have to carry the mark. Matching is loose on purpose
 * and errs toward marking: a send containing any long line of it, or all of a short one, is marked.
 */
export type DraftOrigin = "promptLink" | "sharedPrompt" | "shellLink";

interface Noted {
    /** Each line long enough to tell apart, and the whole text, as they are compared. */
    fragments: string[];
    origin: DraftOrigin;
}

const STORAGE_KEY = "neore:not-typed-drafts";
/** The drafts kept: a stored draft older than this many others may be sent unmarked. */
const MAX_NOTED = 20;
const MAX_FRAGMENT_CHARS = 20_000;
/** A line shorter than this matches only a send that is exactly it: "ok" must not mark every later message. */
const MIN_FRAGMENT_CHARS = 12;

const normalize = (text: string): string => stripHiddenText(text).text.replaceAll(/\s+/gu, " ").trim();

const readStored = (): Noted[] => {
    try {
        const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "[]");

        return Array.isArray(parsed) ? (parsed as Noted[]).filter((entry) => Array.isArray(entry?.fragments)) : [];
    } catch {
        return [];
    }
};

// Kept in memory too, for when storage is unavailable (private mode): this page load still marks.
const memory: { noted: Noted[] } = { noted: [] };

/** Read again on every use: another tab may have noted a draft this one sends (stored drafts are shared, `stored-drafts.ts`). */
const notedDrafts = (): Noted[] => {
    const stored = readStored();

    return [...stored, ...memory.noted.filter((entry) => stored.every((other) => other.fragments[0] !== entry.fragments[0]))];
};

/** Notes that `text` was put into the composer from `origin`. */
export const noteDraftOrigin = (origin: DraftOrigin, text: string): void => {
    const whole = normalize(text).slice(0, MAX_FRAGMENT_CHARS);

    if (whole === "") {
        return;
    }

    const lines = text
        .split("\n")
        .map((line) => normalize(line).slice(0, MAX_FRAGMENT_CHARS))
        .filter((line) => line.length >= MIN_FRAGMENT_CHARS);

    memory.noted = [{ fragments: [...new Set([whole, ...lines])], origin }, ...notedDrafts()].slice(0, MAX_NOTED);

    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(memory.noted));
    } catch {
        // Storage is full or blocked: the note lives for this page load only.
    }
};

/** Notes a saved prompt's text when someone else wrote it (an organization's shared prompt); an unknown viewer counts as someone else. */
export const noteSavedPrompt = (prompt: { userId: string }, viewerId: string | undefined, text: string): void => {
    if (prompt.userId !== viewerId) {
        noteDraftOrigin("sharedPrompt", text);
    }
};

/** Where the text of a send came from when it holds a draft the person did not type; `undefined` for their own. */
export const draftOriginOf = (text: string): DraftOrigin | undefined => {
    const sent = normalize(text);

    if (sent === "") {
        return undefined;
    }

    return notedDrafts().find((entry) =>
        entry.fragments.some((fragment) => (fragment.length >= MIN_FRAGMENT_CHARS ? sent.includes(fragment) : sent === fragment)),
    )?.origin;
};

/** A request's `draftFrom` for `text`, spread into its body: nothing for the person's own words. */
export const draftFromField = (text: string): { draftFrom?: DraftOrigin } => {
    const origin = draftOriginOf(text);

    return origin === undefined ? {} : { draftFrom: origin };
};

/** Forgets every note, for a test. */
export const resetDraftOrigins = (): void => {
    memory.noted = [];

    try {
        globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch {
        // Nothing stored.
    }
};
