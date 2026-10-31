export type NeedsYouKind = "approval" | "question";

/** How long a needs-you icon blinks after its state first appears for a thread (WCAG 2.2.2: nothing blinks past 5 s). */
export const NEEDS_YOU_BLINK_MS = 5000;

const MAX_ENTRIES = 200;
const KINDS: ReadonlyArray<NeedsYouKind> = ["approval", "question"];

/** First time each thread+state was seen, so a remounted row (virtualisation, regrouping) does not restart the window. */
const firstSeen = new Map<string, number>();

const keyOf = (threadId: string, kind: NeedsYouKind): string => `${threadId}:${kind}`;

/** Milliseconds of blinking left for this thread+state; records the first sighting. 0 once the window has passed. */
export const claimBlinkWindow = (threadId: string, kind: NeedsYouKind, now: number): number => {
    const key = keyOf(threadId, kind);
    const seenAt = firstSeen.get(key);

    if (seenAt === undefined) {
        firstSeen.set(key, now);

        if (firstSeen.size > MAX_ENTRIES) {
            // Map keeps insertion order: drop the oldest sighting.
            const oldest = firstSeen.keys().next().value;

            if (oldest !== undefined) {
                firstSeen.delete(oldest);
            }
        }

        return NEEDS_YOU_BLINK_MS;
    }

    return Math.max(0, seenAt + NEEDS_YOU_BLINK_MS - now);
};

/** The thread no longer waits: forget it, so a later pause may blink again. */
export const releaseBlinkWindow = (threadId: string): void => {
    for (const kind of KINDS) {
        firstSeen.delete(keyOf(threadId, kind));
    }
};

export const resetBlinkWindows = (): void => {
    firstSeen.clear();
};
