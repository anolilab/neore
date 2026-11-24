import type { FindableMessage } from "@/features/chat/thread/find/match";

import type { AsideEntry } from "../aside-store";

/** The attribute on each entry's row, which the highlights look rows up by. */
export const ASIDE_ENTRY_ATTRIBUTE = "data-aside-entry-id";

/**
 * The panel's entries as the thread find matches them: one message per entry, its question then its answer, so
 * the matches come out in the order the panel shows them. The row's question and answer are its searchable text.
 */
export const asideFindMessages = (entries: ReadonlyArray<AsideEntry>): FindableMessage[] =>
    entries.map((entry) => {
        return {
            id: entry.id,
            parts:
                entry.answer === undefined
                    ? [{ text: entry.question, type: "text" }]
                    : [
                          { text: entry.question, type: "text" },
                          { text: entry.answer, type: "text" },
                      ],
            role: "user",
        };
    });
