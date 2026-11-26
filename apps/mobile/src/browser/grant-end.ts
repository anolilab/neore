import { withCatch } from "@/lib/guarded";
import { settleQuietly } from "@/offline/quietly";

/**
 * Waits for a grantee's grant to end on this device's clock. A grant ends without a write, so no live answer comes then:
 * the screen stops showing the page at its end (`onEnd`), then reads the status once (`reread`) to learn whether the
 * grant was renewed, which pushes nothing either. Another person's lease that runs out is waited for the same way,
 * with only the read. Outside React, so the timing is tested without a screen.
 */
export const watchGrantEnd = ({
    after = (ms, run) => {
        const timer = setTimeout(run, ms);

        return () => clearTimeout(timer);
    },
    endsAt,
    now = Date.now,
    onEnd = () => {},
    reread,
    rereadAt = endsAt,
}: {
    after?: (ms: number, run: () => void) => () => void;
    endsAt: number;
    now?: () => number;
    onEnd?: () => void;
    reread: () => void;
    /** When to read again, if later than `endsAt` (the page goes early, the read waits for the real end). */
    rereadAt?: number;
}): () => void => {
    const cancels = [
        after(Math.max(0, endsAt - now()), onEnd),
        after(Math.max(0, rereadAt - now()), reread),
    ];

    return () => {
        for (const cancel of cancels) {
            cancel();
        }
    };
};

/** How many times a status read that failed is tried again, and how long apart. */
export const REREAD_RETRIES = 3;
export const REREAD_RETRY_MS = 5000;

/**
 * Reads until a read answers: one that fails (a server error, a dropped connection) is tried again
 * {@link REREAD_RETRIES} times, {@link REREAD_RETRY_MS} apart, so a grant renewed or a lease ended is not missed for
 * good. `startedAt` is the moment the answering read began. Returns a cancel; nothing answers after it.
 */
export const readUntilAnswered = <T>({
    after = (ms, run) => {
        const timer = setTimeout(run, ms);

        return () => clearTimeout(timer);
    },
    now = Date.now,
    onAnswer,
    read,
}: {
    after?: (ms: number, run: () => void) => () => void;
    now?: () => number;
    onAnswer: (answer: T, startedAt: number) => void;
    read: () => Promise<T>;
}): () => void => {
    let isCancelled = false;
    let cancelWait: (() => void) | undefined;

    const attempt = (left: number): void => {
        const startedAt = now();

        settleQuietly(async () => {
            const answer = await withCatch(async () => {
                return { value: await read() };
            }, () => undefined);

            if (isCancelled) {
                return;
            }

            if (answer !== undefined) {
                onAnswer(answer.value, startedAt);
            } else if (left > 0) {
                cancelWait = after(REREAD_RETRY_MS, () => attempt(left - 1));
            }
        });
    };

    attempt(REREAD_RETRIES);

    return () => {
        isCancelled = true;
        cancelWait?.();
    };
};
