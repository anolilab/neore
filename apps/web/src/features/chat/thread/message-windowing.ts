/**
 * Pure windowing decisions for MessageList virtualization.
 *
 * The list splits into a virtualized HEAD (older messages, only the visible
 * slice mounted) and a TAIL that is always mounted. Keeping the tail real DOM
 * is what preserves stick-to-bottom, the streaming placeholder's live region,
 * and find-in-page over the part of the conversation people actually search.
 */

/** Below this many messages nothing is virtualized — the whole thread stays in the DOM. */
export const VIRTUALIZE_THRESHOLD = 60;

/** The newest N messages are always mounted, whatever the scroll position. */
export const ALWAYS_MOUNTED_TAIL = 30;

/** localStorage key that opts a browser into virtualization while it is unverified. */
export const VIRTUALIZE_FLAG_KEY = "neore:virtualize-messages";

export interface WindowPlan {
    /** Messages `[0, headCount)` go through the virtualizer; the rest render normally. */
    headCount: number;
    virtualized: boolean;
}

interface WindowPlanOptions {
    enabled: boolean;
    tail?: number;
    threshold?: number;
}

export const getWindowPlan = (count: number, { enabled, tail = ALWAYS_MOUNTED_TAIL, threshold = VIRTUALIZE_THRESHOLD }: WindowPlanOptions): WindowPlan => {
    if (!enabled || count <= threshold || count <= tail) {
        return { headCount: 0, virtualized: false };
    }

    return { headCount: count - Math.max(0, tail), virtualized: true };
};

/**
 * Where a jump target lives: in the virtualized head (scroll the virtualizer
 * first so the row mounts), in the mounted tail, or not loaded at all.
 */
export type JumpTarget = { index: number; kind: "head" } | { index: number; kind: "tail" } | { kind: "missing" };

export const resolveJumpTarget = (messageIds: ReadonlyArray<string>, targetId: string, plan: WindowPlan): JumpTarget => {
    const index = messageIds.indexOf(targetId);

    if (index === -1) {
        return { kind: "missing" };
    }

    return plan.virtualized && index < plan.headCount ? { index, kind: "head" } : { index, kind: "tail" };
};

/** Where a stored message sits in its thread; see `resolveJumpMessageId`. */
export interface MessagePosition {
    order: number;
    stepOrder: number;
}

/**
 * The rendered message a stored message belongs to. Usually the same id, but an
 * assistant turn's steps are merged into ONE rendered message named after its
 * FIRST step — so a search hit on a later step matches no rendered id. The
 * owning message is then the last one of the same `order` whose `stepOrder`
 * does not exceed the hit's.
 */
export const resolveJumpMessageId = (
    messages: ReadonlyArray<{ id: string; order?: number; stepOrder?: number }>,
    targetId: string,
    position?: MessagePosition,
): string | undefined => {
    if (messages.some((message) => message.id === targetId)) {
        return targetId;
    }

    if (!position) {
        return undefined;
    }

    let owner: string | undefined;

    for (const message of messages) {
        if (message.order === position.order && (message.stepOrder ?? 0) <= position.stepOrder) {
            owner = message.id;
        }
    }

    return owner;
};

/**
 * Only the newest message animates in. It must be the last one AND must not
 * have been present when the list first rendered — so opening a thread animates
 * nothing, and a row remounting (virtualization, edit mode) never replays its
 * entrance. Assistant rows are excluded: a live reply arrives through the
 * streaming placeholder, and fading in the persisted row that replaces it would
 * flash already-visible text.
 */
export const shouldAnimateEntrance = ({
    index,
    initialIds,
    messageId,
    role,
    total,
}: {
    index: number;
    initialIds: ReadonlySet<string>;
    messageId: string;
    role: string;
    total: number;
}): boolean => role === "user" && index === total - 1 && !initialIds.has(messageId);

const MESSAGE_HASH = /^#message-(.+)$/;

/** Reads `#message-<id>` deep links. */
export const parseMessageHash = (hash: string): string | undefined => {
    const match = MESSAGE_HASH.exec(hash);

    if (!match?.[1]) {
        return undefined;
    }

    try {
        return decodeURIComponent(match[1]);
    } catch {
        // A malformed escape is a broken link, not a crash.
        return undefined;
    }
};

export const readVirtualizeFlag = (): boolean => {
    try {
        return globalThis.localStorage?.getItem(VIRTUALIZE_FLAG_KEY) === "1";
    } catch {
        return false;
    }
};
