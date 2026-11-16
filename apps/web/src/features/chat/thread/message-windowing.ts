/**
 * Pure decisions for MessageList: where a jump to a message lands, how far it pages back looking for it,
 * which new message animates in, and `#message-<id>` deep links.
 */

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

/** Older pages a jump may pull in when it does not know where its target sits. */
export const JUMP_MAX_PAGES = 10;

/** Older pages a jump may pull in when it knows its target's position, so a deep search hit is still reachable. */
export const JUMP_MAX_PAGES_WITH_POSITION = 200;

/**
 * Whether a jump that has not found its target should load another older page.
 * With a position the history is paged until it reaches turns older than the
 * target (then the message is gone, not just unloaded), within a larger cap;
 * without one only the small default budget applies.
 */
export const shouldLoadOlderForJump = (pagesLoaded: number, messages: ReadonlyArray<{ order?: number }>, position?: { order: number }): boolean => {
    if (!position) {
        return pagesLoaded < JUMP_MAX_PAGES;
    }

    const oldestOrder = messages[0]?.order;

    if (oldestOrder !== undefined && oldestOrder < position.order) {
        return false;
    }

    return pagesLoaded < JUMP_MAX_PAGES_WITH_POSITION;
};

/**
 * Only the newest message animates in. It must be the last one AND must not
 * have been present when the list first rendered — so opening a thread animates
 * nothing, and a row remounting (edit mode) never replays its entrance. Assistant rows are excluded: a live reply arrives through the
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
