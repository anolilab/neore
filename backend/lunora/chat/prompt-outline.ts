/**
 * The prompt outline of a chat: one entry per user prompt on the active path, for
 * the thread minimap. The minimap only knows the prompts that are loaded, and a
 * long chat loads its history a page at a time; this lists the older ones before
 * their pages arrive, and the rail jumps to them through the list's own logic.
 *
 * It is a read of the chat like opening it: `resolveThreadReadAccess` decides (owner
 * or live grantee), a locked chat is refused without its proof, and a public viewer
 * without a grant gets no outline. The scan is bounded, so the outline of a huge chat
 * covers its newest rows (`truncated`).
 */
import { v } from "lunorash/server";

import { listActivePathPage } from "../agent/branches";
import { listMessagesByThreadIdHandler } from "../agent/client";
import { extractText } from "../agent/shared";
import { resolveThreadReadAccess } from "../agent/thread-read-access";
import { throwThreadLocked } from "../lib/thread-lock";
import { liteAuthQuery } from "../lib/crpc";
import { throwThreadNotFound } from "../lib/error-helpers";
import { MAX_LENGTH } from "../lib/validators";

const PAGE_ROWS = 100;

/**
 * Rows scanned, newest first: exactly the minimap jump's reach. The jump starts from a first page of 20 rows and loads
 * up to `JUMP_MAX_PAGES` (10) pages of `JUMP_PAGE_SIZE` (50) more (`message-list.tsx`, `initialNumItems` in
 * `use-hydrated-messages.ts`). A prompt the outline lists past this could not be jumped to. Keep the two in step.
 */
export const MAX_OUTLINE_ROWS = 20 + 10 * 50;
/** Prompts returned; the oldest beyond this are dropped. */
export const MAX_OUTLINE_PROMPTS = 500;
/** The client shortens this further for the tooltip. */
export const OUTLINE_TEXT_CHARS = 200;

const WHITESPACE = /\s+/g;
// `[label](target)` keeps its label, as the rail's preview shows it. Stripped before the cut: a cut inside a target leaves
// an open link that no later step can recognise. Same shape as the rail's own pattern (`minimap-items.ts`).
const MARKDOWN_LINK_RE = /\[([^[\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))*\)/g;

/** A prompt's text as the outline carries it: one line, its links reduced to their labels, cut short. */
export const outlineText = (text: string | undefined): string =>
    (text ?? "").replaceAll(MARKDOWN_LINK_RE, "$1").replaceAll(WHITESPACE, " ").trim().slice(0, OUTLINE_TEXT_CHARS);

interface OutlinePage {
    continueCursor: null | string;
    isDone: boolean;
    rows: OutlineRow[];
}

interface OutlineRow {
    _id: string;
    message?: unknown;
    text?: string;
    tool: boolean;
}

/** The text the message view shows: the stored model message first, the `text` column for a row without one. */
const promptText = (row: OutlineRow): string | undefined => {
    const fromMessage = row.message ? extractText(row.message as Parameters<typeof extractText>[0]) : "";

    return fromMessage || row.text;
};

/** `message` is the stored model message; a user prompt is a non-tool row with role `user`. */
export const isUserPromptRow = (row: OutlineRow): boolean => !row.tool && (row.message as { role?: string } | undefined)?.role === "user";

export const getThreadPromptOutline = liteAuthQuery
    .input({
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ items: v.array(v.object({ id: v.string(), text: v.string() })), truncated: v.boolean() }))
    .query(async ({ args: { threadId, unlockProof }, ctx: context }) => {
        const access = await resolveThreadReadAccess(context, threadId, context.user.userId, unlockProof);

        // Missing, someone else's and not shared look the same: the outline does not tell a stranger which ids exist.
        if (!access) {
            return throwThreadNotFound();
        }

        if (access.kind === "locked") {
            return throwThreadLocked();
        }

        // A public viewer without a grant sees the share page's allow-list, which has no outline.
        if (access.kind === "redacted") {
            return { items: [], truncated: false };
        }

        const newestFirst: { id: string; text: string }[] = [];
        let cursor: string | null = null;
        let scanned = 0;
        let truncated = false;

        while (scanned < MAX_OUTLINE_ROWS) {
            // The last page is clamped so the scan stops at the jump's reach, not a page past it.
            const numberItems = Math.min(PAGE_ROWS, MAX_OUTLINE_ROWS - scanned);
            // A branched thread lists its active path; `null` keeps every other thread on the direct index scan.
            const pathPage = await listActivePathPage(context, access.thread, { cursor, numItems: numberItems }, unlockProof, false);
            // No tool or status filter here: with both unset the reader is one index scan. Filtered, it merges one
            // stream per status and tool flag, and each stops at 1,024 rows. `isUserPromptRow` drops the tool rows.
            const page: OutlinePage = pathPage
                ? { continueCursor: pathPage.continueCursor, isDone: pathPage.isDone, rows: pathPage.page }
                : await listMessagesByThreadIdHandler(context, {
                      order: "desc",
                      paginationOpts: { cursor, numItems: numberItems },
                      threadId,
                      unlockProof,
                  }).then((result) => {
                      return { continueCursor: result.continueCursor, isDone: result.isDone, rows: result.page };
                  });

            for (const row of page.rows) {
                if (isUserPromptRow(row)) {
                    newestFirst.push({ id: row._id, text: outlineText(promptText(row)) });
                }
            }

            // The newest MAX_OUTLINE_PROMPTS are already known once one more prompt is found; the scan
            // need not read the rest of its rows to know the outline is truncated. Same items and flag.
            if (newestFirst.length > MAX_OUTLINE_PROMPTS) {
                break;
            }

            scanned += page.rows.length;

            if (page.isDone || page.continueCursor === null) {
                break;
            }

            cursor = page.continueCursor;
            truncated = scanned >= MAX_OUTLINE_ROWS;
        }

        const items = newestFirst.slice(0, MAX_OUTLINE_PROMPTS).toReversed();

        return { items, truncated: truncated || newestFirst.length > MAX_OUTLINE_PROMPTS };
    });
