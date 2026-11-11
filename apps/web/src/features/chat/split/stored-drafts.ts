import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";
import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { fromStoredAttachment, toStoredAttachment } from "@/features/chat/core/stores/prompt-queue-store";
import type { StoredAttachment } from "@/features/chat/core/utils/prompt-queue";

import type { ComposerDraft } from "./composer-drafts";
import { draftGeneration, DRAFTS_STORAGE_KEY, hasDraftContent, peekComposerDraft, useParkedDraftStore } from "./composer-drafts";

/**
 * Unsent drafts in `localStorage`, so a reload, a crash or an app update does not lose them. Loaded lazily (see
 * `use-stored-drafts.ts`): the first paint never waits for it.
 *
 * One record holds one account's drafts (`u`), keyed by chat ("new" for the new-chat composer). A record of another account
 * reads as empty and is replaced by the next write; sign-out and an account switch remove it (`dropStoredDrafts`). What is kept
 * is the text, attachments that finished uploading (by file id, never their bytes) and references with a web URL (never a
 * `blob:` or `data:` one). This page's drafts are the live composer under its chat plus the drafts parked in split view; a chat
 * this page wrote that has none now is removed, and one written by another tab is left alone. Every storage access is guarded:
 * a failure only means the draft is not kept.
 */

export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STORED_DRAFTS = 50;
export const DRAFT_WRITE_DELAY_MS = 400;
export const NEW_CHAT_DRAFT_KEY = "new";

export interface StoredDraft {
    a?: StoredAttachment[];
    /** When it was last written. */
    at: number;
    r?: ReferenceSelection[];
    t: string;
}

type Content = Pick<ComposerDraft, "attachedReferences" | "composerAttachments" | "composerText">;

const storage = (): Storage | undefined => {
    try {
        return globalThis.localStorage ?? undefined;
    } catch {
        return undefined;
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const WEB_URL = /^https?:\/\//u;

const isWebUrl = (url: unknown): url is string => typeof url === "string" && url.length <= 4096 && WEB_URL.test(url);

const isReference = (value: unknown): value is ReferenceSelection =>
    isRecord(value) && typeof value.id === "string" && typeof value.mimeType === "string" && isWebUrl(value.url);

const isAttachment = (value: unknown): value is StoredAttachment =>
    isRecord(value) &&
    typeof value.fileId === "string" &&
    value.fileId !== "" &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    ["document", "file", "image"].includes(value.kind as string);

const readDraft = (value: unknown, oldest: number): StoredDraft | undefined => {
    if (!isRecord(value) || typeof value.t !== "string" || typeof value.at !== "number" || value.at < oldest) {
        return undefined;
    }

    const a = Array.isArray(value.a) ? value.a.filter(isAttachment) : [];
    const r = Array.isArray(value.r) ? value.r.filter(isReference) : [];

    return value.t === "" && a.length === 0 && r.length === 0 ? undefined : { a, at: value.at, r, t: value.t };
};

/** `userId`'s stored drafts that have not expired; empty for another account's record, a corrupt one or no storage. */
export const readStoredDrafts = (userId: string, now = Date.now()): Map<string, StoredDraft> => {
    const drafts = new Map<string, StoredDraft>();

    try {
        const raw = storage()?.getItem(DRAFTS_STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : undefined;

        if (isRecord(parsed) && parsed.u === userId && isRecord(parsed.d)) {
            for (const [key, value] of Object.entries(parsed.d)) {
                const draft = readDraft(value, now - DRAFT_TTL_MS);

                if (draft) {
                    drafts.set(key, draft);
                }
            }
        }
    } catch {
        // Unreadable: no drafts.
    }

    return drafts;
};

/** Keeps the newest {@link MAX_STORED_DRAFTS}; an empty set removes the record. */
const writeStoredDrafts = (userId: string, drafts: Map<string, StoredDraft>): boolean => {
    try {
        const kept = [...drafts].toSorted(([, left], [, right]) => right.at - left.at).slice(0, MAX_STORED_DRAFTS);

        if (kept.length === 0) {
            storage()?.removeItem(DRAFTS_STORAGE_KEY);
        } else {
            storage()?.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ d: Object.fromEntries(kept), u: userId }));
        }

        return true;
    } catch {
        return false;
    }
};

const toStoredDraft = (content: Partial<Content> | undefined, at: number): StoredDraft | undefined => {
    if (!hasDraftContent(content)) {
        return undefined;
    }

    const a = (content?.composerAttachments ?? [])
        .map((attachment: PendingAttachment) => toStoredAttachment(attachment))
        .filter((stored) => stored !== undefined);
    const r = (content?.attachedReferences ?? []).filter(isReference);
    const t = content?.composerText ?? "";

    return t === "" && a.length === 0 && r.length === 0 ? undefined : { a, at, r, t };
};

/** The chat the live composer belongs to: the last one whose composer mounted. It keeps it after an unmount (the text stays). */
interface Binding {
    owner: string;
    userId: string;
}

const state = {
    binding: undefined as Binding | undefined,
    /** The clears of stored drafts when the pending write was scheduled; a write that a clear overtook is dropped. */
    generation: draftGeneration(),
    /** Chats seen locked this page load: none of their drafts is stored. */
    locked: new Set<string>(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    /** The chats whose draft this page stored, so one that has none now is removed. */
    written: new Set<string>(),
};

/** This page's drafts now: the parked ones and the live composer under its chat, without locked chats. */
const snapshot = (owner: string, now: number): Map<string, StoredDraft> => {
    const drafts = new Map<string, StoredDraft>();

    for (const threadId of useParkedDraftStore.getState().threadIds) {
        const draft = toStoredDraft(peekComposerDraft(threadId), now);

        if (draft) {
            drafts.set(threadId, draft);
        }
    }

    const live = toStoredDraft(useChatUIStore.getState(), now);

    // An empty composer does not hide the chat's parked draft: focus moving to another pane parks it, then empties the composer.
    if (live) {
        drafts.set(owner, live);
    }

    for (const threadId of state.locked) {
        drafts.delete(threadId);
    }

    return drafts;
};

/** Writes this page's drafts now, if a write is pending. */
export const flushStoredDrafts = (): void => {
    if (state.timer === undefined) {
        return;
    }

    clearTimeout(state.timer);
    state.timer = undefined;

    const { binding } = state;

    if (!binding || draftGeneration() !== state.generation) {
        // Signed out or switched since: what this page wrote is gone, and the old account's draft must not come back.
        state.written.clear();

        return;
    }

    const now = Date.now();
    const stored = readStoredDrafts(binding.userId, now);
    const current = snapshot(binding.owner, now);
    const removed = [...state.written, ...state.locked].filter((key) => !current.has(key));

    for (const key of removed) {
        stored.delete(key);
    }

    for (const [key, draft] of current) {
        stored.set(key, draft);
    }

    if (!writeStoredDrafts(binding.userId, stored)) {
        // Full: at least what was removed or changed must not come back stale on a reload.
        for (const key of current.keys()) {
            stored.delete(key);
        }

        writeStoredDrafts(binding.userId, stored);
    }

    state.written = new Set(current.keys());
};

const schedule = (): void => {
    if (state.timer === undefined) {
        state.generation = draftGeneration();
    } else {
        clearTimeout(state.timer);
    }

    // Started at the first change after a write, so a clear between them always wins.
    state.timer = setTimeout(() => {
        // Not `flushStoredDrafts` directly: it returns early without a timer.
        flushStoredDrafts();
    }, DRAFT_WRITE_DELAY_MS);
};

const onPageHide = (): void => {
    flushStoredDrafts();
};

const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
        flushStoredDrafts();
    }
};

const listening = { stop: undefined as (() => void) | undefined };

const listen = (): void => {
    if (listening.stop) {
        return;
    }

    const stopComposer = useChatUIStore.subscribe((next, previous) => {
        if (
            next.composerText !== previous.composerText ||
            next.composerAttachments !== previous.composerAttachments ||
            next.attachedReferences !== previous.attachedReferences
        ) {
            schedule();
        }
    });
    const stopParked = useParkedDraftStore.subscribe(schedule);

    globalThis.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);

    listening.stop = () => {
        stopComposer();
        stopParked();
        globalThis.removeEventListener("pagehide", onPageHide);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        listening.stop = undefined;
    };
};

/**
 * Called when a chat's composer mounts: from now on the live composer is stored under `owner`. An empty composer gets the
 * chat's stored draft back, unless the chat has one parked in split view (which is the newer). Text being typed is never
 * replaced: `restoreComposer` does nothing to a composer with content.
 */
export const bindStoredDrafts = (owner: string, userId: string, locked: boolean): void => {
    // A pending write is the previous chat's state (a draft just emptied, say): it lands first, so it is not read back stale.
    flushStoredDrafts();

    if (state.binding && state.binding.userId !== userId) {
        state.written.clear();
    }

    state.binding = { owner, userId };
    listen();

    if (locked) {
        state.locked.add(owner);
    } else {
        state.locked.delete(owner);

        const ui = useChatUIStore.getState();
        const stored = readStoredDrafts(userId).get(owner);

        if (stored && !hasDraftContent(ui) && !hasDraftContent(peekComposerDraft(owner))) {
            ui.restoreComposer({
                attachedReferences: stored.r ?? [],
                composerAttachments: (stored.a ?? []).map((attachment, index) => fromStoredAttachment(attachment, index)),
                composerText: stored.t,
            });
        }
    }

    // What changed before this module loaded, or under the chat the composer showed before, is written now.
    schedule();
};

/** For tests: forgets this page's state and stops listening. */
export const resetStoredDraftsForTests = (): void => {
    clearTimeout(state.timer);
    state.timer = undefined;
    state.binding = undefined;
    state.locked.clear();
    state.written.clear();
    listening.stop?.();
};
