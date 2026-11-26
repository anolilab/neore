/**
 * Reads the browser's frame while a screen shows it: once at the start (unless one was read a moment ago) and then on a
 * timer that skips a tick while a read is still out. Only the newest read may answer: one that answers after the
 * reader stopped is dropped. Outside React, so the timing is tested without a screen.
 */
import { settleQuietly } from "@/offline/quietly";

/** How often a frame is read while the screen is open and nothing else asked for one. */
export const FRAME_REFRESH_MS = 10_000;

/** A read asked for this soon after the last one is skipped: a busy agent's actions would spend the hour's reads. */
export const FRAME_MIN_GAP_MS = 3000;

export interface FrameReaderOptions<T> {
    every?: (ms: number, run: () => void) => () => void;
    /** When the screen's last read began (it starts readers one after another); `onRead` reports each new one. */
    lastReadAt: number;
    now?: () => number;
    onAnswer: (answer: T) => void;
    onFailure: (error: unknown) => void;
    onRead: (at: number) => void;
    read: () => Promise<T>;
}

export const startFrameReader = <T>({
    every = (ms, run) => {
        const timer = setInterval(run, ms);

        return () => clearInterval(timer);
    },
    lastReadAt,
    now = Date.now,
    onAnswer,
    onFailure,
    onRead,
    read,
}: FrameReaderOptions<T>): () => void => {
    let generation = 0;
    let isStopped = false;
    /** A read still out: the timer waits for it rather than replace it, so a slow read is never dropped for the next. */
    let isReading = false;

    const run = (): void => {
        onRead(now());
        isReading = true;
        generation += 1;

        const mine = generation;

        settleQuietly(async () => {
            try {
                const answer = await read();

                if (!isStopped && mine === generation) {
                    onAnswer(answer);
                }
            } catch (error) {
                if (!isStopped && mine === generation) {
                    onFailure(error);
                }
            }

            if (mine === generation) {
                isReading = false;
            }
        });
    };

    if (now() - lastReadAt >= FRAME_MIN_GAP_MS) {
        run();
    }

    const cancel = every(FRAME_REFRESH_MS, () => {
        if (!isReading) {
            run();
        }
    });

    return () => {
        isStopped = true;
        cancel();
    };
};
