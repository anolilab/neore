import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";
import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { fromStoredAttachment, toStoredAttachment } from "@/features/chat/core/stores/prompt-queue-store";
import type { StoredAttachment } from "@/features/chat/core/utils/prompt-queue";

import type { ComposerDraft } from "./composer-drafts";
import {
    draftGeneration,
    draftOwnership,
    draftsClearedAt,
    hasDraftContent,
    peekComposerDraft,
    pruneClearMarkers,
    useParkedDraftStore,
    useSplitViewMountedStore,
} from "./composer-drafts";

/**
 * Unsent drafts in `localStorage`, so a reload, a crash or an app update does not lose them. Loaded lazily (see
 * `use-stored-drafts.ts`): the first paint never waits for it.
 *
 * Each draft is its own entry, `neore-draft:<userId>:<owner>` (owner: a chat id, or "new" for the new-chat composer), holding
 * `{ v: draft, t: savedAt, w: writeId }`. A write touches only the entries of drafts that changed on this page, and a draft
 * sent or emptied here is removed only while its entry still carries this page's last write id: another tab's entry is never
 * removed or rewritten unless edited here. Two tabs editing the same chat are last-write-wins. Reads look only at the current
 * account's entries; sign-out and an account switch remove only the departing account's (`dropStoredDrafts`), or every
 * account's when a sign-out cannot tell whose. What is kept is the text, attachments that finished uploading (by file id, never
 * their bytes) and references with a web URL (never a `blob:` or `data:` one). Every storage access is guarded: a failure only
 * means the draft is not kept.
 */

export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STORED_DRAFTS = 50;
export const DRAFT_WRITE_DELAY_MS = 400;
export const NEW_CHAT_DRAFT_KEY = "new";
/** How far ahead of this clock a saved time may be (another device's clock, a correction): later ones are unreadable. */
export const DRAFT_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export interface StoredDraft {
    a?: StoredAttachment[];
    r?: ReferenceSelection[];
    t: string;
}

interface Entry {
    t: number;
    v: StoredDraft;
    w: string;
}

type Content = Pick<ComposerDraft, "attachedReferences" | "composerAttachments" | "composerText">;

const storage = (): Storage | undefined => {
    try {
        return globalThis.localStorage ?? undefined;
    } catch {
        return undefined;
    }
};

const remove = (key: string): void => {
    try {
        storage()?.removeItem(key);
    } catch {
        // Blocked storage holds nothing to remove.
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

const DRAFT_KEY_PREFIX = "neore-draft:";

/** The record preview builds kept every draft in. Removed, never read. */
export const LEGACY_DRAFTS_KEY = "neore:composer-drafts:v1";

/** The `localStorage` keys that start with `prefix`; none when storage is blocked. */
const draftKeys = (prefix: string): string[] => {
    try {
        return Object.keys(globalThis.localStorage).filter((key) => key.startsWith(prefix));
    } catch {
        return [];
    }
};

const draftKeyPrefix = (userId: string): string => `${DRAFT_KEY_PREFIX}${userId}:`;

export const draftKey = (userId: string, owner: string): string => `${draftKeyPrefix(userId)}${owner}`;

/** The entry under `key`; undefined when missing, expired, corrupt, empty or unreadable. */
const readEntry = (key: string, now = Date.now()): Entry | undefined => {
    try {
        const parsed: unknown = JSON.parse(storage()?.getItem(key) ?? "null");

        if (
            !isRecord(parsed) ||
            !isRecord(parsed.v) ||
            typeof parsed.v.t !== "string" ||
            typeof parsed.t !== "number" ||
            !Number.isFinite(parsed.t) ||
            parsed.t < now - DRAFT_TTL_MS ||
            parsed.t > now + DRAFT_CLOCK_SKEW_MS ||
            typeof parsed.w !== "string"
        ) {
            return undefined;
        }

        const a = Array.isArray(parsed.v.a) ? parsed.v.a.filter(isAttachment) : [];
        const r = Array.isArray(parsed.v.r) ? parsed.v.r.filter(isReference) : [];

        return parsed.v.t === "" && a.length === 0 && r.length === 0 ? undefined : { t: parsed.t, v: { a, r, t: parsed.v.t }, w: parsed.w };
    } catch {
        return undefined;
    }
};

/** Removes the expired and unreadable entries under `prefix`, and each account's beyond its {@link MAX_STORED_DRAFTS} newest. */
const prune = (prefix: string, now = Date.now()): void => {
    const byAccount = new Map<string, [string, number][]>();

    for (const key of draftKeys(prefix)) {
        const entry = readEntry(key, now);

        if (entry) {
            const account = key.slice(0, key.lastIndexOf(":"));

            byAccount.set(account, [...(byAccount.get(account) ?? []), [key, entry.t]]);
        } else {
            remove(key);
        }
    }

    for (const entries of byAccount.values()) {
        const overCap = entries.toSorted(([, left], [, right]) => right - left).slice(MAX_STORED_DRAFTS);

        for (const [key] of overCap) {
            remove(key);
        }
    }
};

const newWriteId = (): string =>
    typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const toStoredDraft = (content: Partial<Content> | undefined): StoredDraft | undefined => {
    if (!hasDraftContent(content)) {
        return undefined;
    }

    const a = (content?.composerAttachments ?? [])
        .map((attachment: PendingAttachment) => toStoredAttachment(attachment))
        .filter((stored) => stored !== undefined);
    const r = (content?.attachedReferences ?? []).filter(isReference);
    const t = content?.composerText ?? "";

    return t === "" && a.length === 0 && r.length === 0 ? undefined : { a, r, t };
};

/**
 * The chat the live composer belongs to: the last one whose composer mounted (or whose pane took focus). It keeps it after an
 * unmount (the text stays). `generation` is the clears of stored drafts when it was made: after a sign-out or an account switch
 * nothing is written for it.
 */
interface Binding {
    /** When it was made: a clear another tab marked after it (`draftsClearedAt`) forgets it too. */
    at: number;
    generation: number;
    owner: string;
    userId: string;
}

const state = {
    binding: undefined as Binding | undefined,

    /**
     * Set when the composer's content came along from another chat or account (single view keeps the text when you move on):
     * it stays `carriedFrom`'s draft until it is edited here (none after an account switch).
     */
    carried: false,
    carriedFrom: undefined as string | undefined,
    /** Chats seen locked this page load, until they bind unlocked: none of their drafts is stored. */
    locked: new Set<string>(),
    /** What this page last wrote or restored, by chat: unchanged content is not written again, and only this write is removed. */
    mine: new Map<string, { content: string; w: string }>(),
    /** The composer holds a route's prefilled message nobody edited: it is no chat's draft, and the chat's stored one stays. */
    prefill: false,
    /** An untouched prefilled message is being sent: the chat's draft comes back when the send ends. */
    prefillSending: false,

    /**
     * Set while the composer that owned the binding is unmounted (`releaseStoredDrafts`), to the chat its text was stored under:
     * nothing the shared composer gets meanwhile is stored, and that chat's entry stays.
     */
    released: undefined as string | undefined,
    started: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
};

/** This page's drafts now: the parked ones and the live composer under its owner, without locked chats. */
const snapshot = (owner: string): Map<string, StoredDraft> => {
    const drafts = new Map<string, StoredDraft>();

    for (const threadId of useParkedDraftStore.getState().threadIds) {
        const draft = toStoredDraft(peekComposerDraft(threadId));

        if (draft) {
            drafts.set(threadId, draft);
        }
    }

    // Carried text stays its first chat's; an untouched prefill is no chat's.
    const liveOwner = state.carried ? state.carriedFrom : owner;
    const live = state.prefill || state.released !== undefined ? undefined : toStoredDraft(useChatUIStore.getState());

    // An empty composer does not hide the chat's parked draft: focus moving to another pane parks it, then empties the composer.
    if (live && liveOwner !== undefined) {
        drafts.set(liveOwner, live);
    }

    for (const threadId of state.locked) {
        drafts.delete(threadId);
    }

    return drafts;
};

/**
 * After a sign-out or an account switch what this page wrote is gone, and the old account's draft must not come back. Nothing is
 * written until a composer binds again, and what the composer still holds is not stored until it is edited. Only a clear of the
 * binding's own account counts: the next account's composer may bind before the switch drops the departing account's drafts.
 */
const forgetIfCleared = (): void => {
    if (!state.binding || (draftGeneration(state.binding.userId) === state.binding.generation && draftsClearedAt(state.binding.userId) <= state.binding.at)) {
        return;
    }

    clearTimeout(state.timer);
    state.timer = undefined;
    state.binding = undefined;
    state.carried = true;
    state.carriedFrom = undefined;
    state.mine.clear();
};

/** Writes this page's drafts now, if a write is pending. */
export const flushStoredDrafts = (): void => {
    forgetIfCleared();

    const { binding, timer } = state;

    clearTimeout(timer);
    state.timer = undefined;

    if (timer === undefined || !binding) {
        return;
    }

    const current = snapshot(binding.owner);

    for (const [owner, { w }] of state.mine) {
        if (current.has(owner) || owner === state.released) {
            continue;
        }

        const key = draftKey(binding.userId, owner);

        // Sent or emptied here. An entry another tab wrote since is that tab's draft: it stays.
        if (readEntry(key)?.w === w) {
            remove(key);
        }

        state.mine.delete(owner);
    }

    const now = Date.now();

    for (const [owner, draft] of current) {
        const content = JSON.stringify(draft);
        const key = draftKey(binding.userId, owner);

        // Unchanged since this page wrote it: an entry another tab wrote since stays.
        if (state.mine.get(owner)?.content !== content) {
            const w = newWriteId();
            const store = storage();

            // Storage out of reach is no write: the next flush tries again (an emptied content never matches a draft's).
            if (store === undefined) {
                const mine = state.mine.get(owner);

                if (mine) {
                    state.mine.set(owner, { ...mine, content: "" });
                }

                continue;
            }

            try {
                store.setItem(key, JSON.stringify({ t: now, v: draft, w }));
                state.mine.set(owner, { content, w });
            } catch {
                // Full: this chat's older entry from this page must not come back stale on a reload.
                if (readEntry(key)?.w === state.mine.get(owner)?.w) {
                    remove(key);
                }

                state.mine.delete(owner);
            }
        }
    }

    prune(draftKeyPrefix(binding.userId), now);
};

const schedule = (): void => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        // Not `flushStoredDrafts` directly: it returns early without a timer.
        flushStoredDrafts();
    }, DRAFT_WRITE_DELAY_MS);
};

/** Focus moved to `owner`'s pane: the parked drafts are written now, and the live composer is that pane's from here on. */
const handOver = (owner: string | undefined): void => {
    schedule();
    flushStoredDrafts();

    if (state.binding && owner !== undefined) {
        state.binding = { ...state.binding, owner };
    }
};

/** Once per page load, on first use: the old single record, expired entries and drafts over the cap go. */
const start = (): void => {
    if (state.started) {
        return;
    }

    state.started = true;
    remove(LEGACY_DRAFTS_KEY);
    prune(DRAFT_KEY_PREFIX);
    pruneClearMarkers(DRAFT_TTL_MS);
    draftOwnership.handOver = handOver;
};

/** Removes a locked chat's stored draft now, from any account, and stores none for it until it binds unlocked (`LockedChatGate`). */
export const lockStoredDraft = (owner: string): void => {
    start();
    state.locked.add(owner);
    state.mine.delete(owner);

    for (const key of draftKeys(DRAFT_KEY_PREFIX)) {
        if (key.endsWith(`:${owner}`)) {
            remove(key);
        }
    }
};

/** Fills an empty composer with `owner`'s stored draft, unless the chat has one parked in split view (which is the newer). */
const restore = (owner: string, userId: string): void => {
    const ui = useChatUIStore.getState();
    const entry = readEntry(draftKey(userId, owner));

    if (entry && !hasDraftContent(ui) && !hasDraftContent(peekComposerDraft(owner))) {
        ui.restoreComposer({
            attachedReferences: entry.v.r ?? [],
            composerAttachments: (entry.v.a ?? []).map((attachment, index) => fromStoredAttachment(attachment, index)),
            composerText: entry.v.t,
        });
        // Restored here: sent or emptied before the next write, it is removed.
        state.mine.set(owner, { content: JSON.stringify(entry.v), w: entry.w });
    }
};

/** A route's message is in the composer: the chat it lands on keeps its stored draft, which is not this page's to remove. */
const holdPrefill = (owner: string | undefined): void => {
    state.prefill = true;
    state.carried = false;

    if (owner !== undefined) {
        state.mine.delete(owner);
    }
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
        // The send of an untouched prefilled message ended: the chat's own draft comes back now, unless the failed send's text
        // came back first (it matched the prefill again, so it is held as one).
        if (state.prefillSending && previous.isSubmitting && !next.isSubmitting) {
            state.prefillSending = false;

            if (!state.prefill) {
                draftOwnership.prefill = undefined;

                if (state.binding && !hasDraftContent(next)) {
                    restore(state.binding.owner, state.binding.userId);
                }
            }
        }

        if (
            next.composerText === previous.composerText &&
            next.composerAttachments === previous.composerAttachments &&
            next.attachedReferences === previous.attachedReferences
        ) {
            return;
        }

        const previousIds = previous.composerAttachments.map((attachment) => attachment.id).join(",");

        // Edited here: the content is this chat's draft now. An upload finishing changes no id, and is no edit.
        if (
            next.composerText !== previous.composerText ||
            next.attachedReferences !== previous.attachedReferences ||
            next.composerAttachments.map((attachment) => attachment.id).join(",") !== previousIds
        ) {
            const { binding } = state;

            if (state.released !== undefined) {
                // Edited with no chat's composer on the page: no chat's draft. The released chat's entry stays its draft, and is no
                // longer this page's to remove.
                state.mine.delete(state.released);
                state.carried = true;
                state.carriedFrom = undefined;
            } else if (next.composerText !== "" && next.composerText === draftOwnership.prefill) {
                holdPrefill(binding?.owner);
            } else {
                const emptied = state.prefill && !hasDraftContent(next);

                state.prefill = false;
                state.carried = false;

                if (emptied && next.isSubmitting) {
                    // Sent: a failed send hands the text back, and it must stay the prefill, not overwrite the chat's draft. The
                    // draft comes back once the send ends (above).
                    state.prefillSending = true;
                } else {
                    draftOwnership.prefill = undefined;

                    // The prefilled message was cleared: the chat's own draft comes back.
                    if (emptied && binding) {
                        restore(binding.owner, binding.userId);
                    }
                }
            }
        }

        schedule();
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
 * chat's stored draft back. Text being typed is never replaced: `restoreComposer` does nothing to a composer with content.
 */
export const bindStoredDrafts = (owner: string, userId: string, locked: boolean): void => {
    start();
    // A pending write is the previous chat's state (a draft just emptied, say): it lands first, so it is not read back stale. After a
    // sign-out the previous binding is forgotten, pending write or not.
    flushStoredDrafts();

    // Before the first binding, the composer's text is the chat's whose composer showed with it (`use-stored-drafts.ts`); from
    // before a sign-out or an account switch, it is no account's.
    const { first } = draftOwnership;
    const previous = state.binding ?? (first && first.generation !== draftGeneration(first.userId) ? { owner: "", userId: "" } : first);
    const switchedUser = previous !== undefined && previous.userId !== userId;
    const moved = previous !== undefined && previous.owner !== owner && !useSplitViewMountedStore.getState().mounted;
    const ui = useChatUIStore.getState();

    if (switchedUser) {
        state.mine.clear();
    }

    state.prefill = false;
    state.released = undefined;

    if (ui.composerText !== "" && ui.composerText === draftOwnership.prefill) {
        holdPrefill(owner);
    } else if (switchedUser || moved) {
        // In split view the composer is emptied and refilled with the focused pane's own draft, so nothing is carried there. Text
        // carried on through several chats is still the first one's.
        const from = state.carried ? state.carriedFrom : previous.owner;

        state.carried = hasDraftContent(ui) && (switchedUser || from !== owner);
        state.carriedFrom = switchedUser ? undefined : from;
    }

    state.binding = { at: Date.now(), generation: draftGeneration(userId), owner, userId };
    listen();

    if (locked) {
        lockStoredDraft(owner);
    } else {
        state.locked.delete(owner);
        restore(owner, userId);
    }

    // What changed before this module loaded, or under the chat the composer showed before, is written now.
    schedule();
};

/**
 * The composer of `owner` unmounted and no other took over yet (`useStoredDrafts`' cleanup): its pending write lands now, and
 * nothing the shared composer gets from here on is stored under `owner`. Its entry stays: it is the chat's draft. The binding
 * itself stays, so the next composer still sees where any text came from.
 */
export const releaseStoredDrafts = (owner: string): void => {
    if (state.binding?.owner !== owner) {
        return;
    }

    flushStoredDrafts();
    state.released = state.carried ? state.carriedFrom : owner;
};

/** For tests: forgets this page's state and stops listening. */
export const resetStoredDraftsForTests = (): void => {
    clearTimeout(state.timer);
    state.timer = undefined;
    state.binding = undefined;
    state.carried = false;
    state.carriedFrom = undefined;
    state.locked.clear();
    state.mine.clear();
    state.prefill = false;
    state.prefillSending = false;
    state.released = undefined;
    state.started = false;
    listening.stop?.();
};
