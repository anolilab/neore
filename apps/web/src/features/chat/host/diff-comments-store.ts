"use client";

/**
 * The comments a person has drafted on host turns' diffs, per thread. In memory: they survive closing the diff view
 * and moving between chats, not a reload, and the server never sees them until they are sent as one message.
 */

import { create } from "zustand";

import type { DiffComment } from "./diff-comments";

/** The most comments one thread's draft holds; the message could not carry more anyway. */
export const MAX_DRAFT_COMMENTS = 30;

const NONE: ReadonlyArray<DiffComment> = [];

interface DiffCommentStore {
    add: (threadId: string, comment: Omit<DiffComment, "id">) => void;
    /** Drops the named comments (those that were sent), or the whole draft when none are named. */
    clear: (threadId: string, ids?: ReadonlyArray<string>) => void;
    drafts: Record<string, ReadonlyArray<DiffComment>>;
    remove: (threadId: string, id: string) => void;
}

export const useDiffCommentStore = create<DiffCommentStore>((set) => {
    return {
        add: (threadId, comment) => {
            set((state) => {
                const current = state.drafts[threadId] ?? NONE;

                return current.length >= MAX_DRAFT_COMMENTS
                    ? state
                    : { drafts: { ...state.drafts, [threadId]: [...current, { ...comment, id: crypto.randomUUID() }] } };
            });
        },
        clear: (threadId, ids) => {
            set((state) => {
                const { [threadId]: current = NONE, ...rest } = state.drafts;
                const kept = ids === undefined ? NONE : current.filter((comment) => !ids.includes(comment.id));

                return { drafts: kept.length === 0 ? rest : { ...rest, [threadId]: kept } };
            });
        },
        drafts: {},
        remove: (threadId, id) => {
            set((state) => {
                const { [threadId]: current = NONE, ...rest } = state.drafts;
                const kept = current.filter((comment) => comment.id !== id);

                return { drafts: kept.length === 0 ? rest : { ...rest, [threadId]: kept } };
            });
        },
    };
});

/** A thread's draft; the same array until it changes. */
export const useDiffDraft = (threadId: string): ReadonlyArray<DiffComment> => useDiffCommentStore((state) => state.drafts[threadId] ?? NONE);
