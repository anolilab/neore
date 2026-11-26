/**
 * Reads the browser's frame while a screen shows it: once at the start, on a timer, and whenever the screen asks
 * (`request`, on an agent action). One read is out at a time and is never dropped for a newer one; a request made while
 * one is out, or within {@link FRAME_MIN_GAP_MS} of the last, is kept and served as soon as it may run. Only a read that
 * answers after the reader stopped is dropped. Outside React, so the timing is tested without a screen.
 */
import { settleQuietly } from "@/offline/quietly";

/** How often a frame is read while the screen is open and nothing else asked for one. */
export const FRAME_REFRESH_MS = 10_000;

/** A read asked for this soon after the last one waits: a busy agent's actions would spend the hour's reads. */
export const FRAME_MIN_GAP_MS = 3000;

export interface FrameReaderOptions<T> {
    after?: (ms: number, run: () => void) => () => void;
    every?: (ms: number, run: () => void) => () => void;
    now?: () => number;
    onAnswer: (answer: T) => void;
    onFailure: (error: unknown) => void;
    read: () => Promise<T>;
}

export interface FrameReader {
    /** Asks for a read now, or as soon as the read out has answered and the gap has passed. */
    request: () => void;
    stop: () => void;
}

export const startFrameReader = <T>({
    after = (ms, run) => {
        const timer = setTimeout(run, ms);

        return () => clearTimeout(timer);
    },
    every = (ms, run) => {
        const timer = setInterval(run, ms);

        return () => clearInterval(timer);
    },
    now = Date.now,
    onAnswer,
    onFailure,
    read,
}: FrameReaderOptions<T>): FrameReader => {
    let isStopped = false;
    let isReading = false;
    let isPending = false;
    let lastReadAt = -Infinity;
    let cancelWait: (() => void) | undefined;
    /** Set below: a read that answers serves a request kept while it was out. */
    let request: () => void = () => {};

    const run = (): void => {
        isPending = false;
        isReading = true;
        lastReadAt = now();

        settleQuietly(async () => {
            try {
                const answer = await read();

                if (!isStopped) {
                    onAnswer(answer);
                }
            } catch (error) {
                if (!isStopped) {
                    onFailure(error);
                }
            }

            isReading = false;

            if (isPending && !isStopped) {
                request();
            }
        });
    };

    request = (): void => {
        if (isStopped) {
            return;
        }

        if (isReading) {
            isPending = true;

            return;
        }

        const wait = lastReadAt + FRAME_MIN_GAP_MS - now();

        if (wait > 0) {
            isPending = true;
            cancelWait ??= after(wait, () => {
                cancelWait = undefined;

                if (isPending && !isReading && !isStopped) {
                    run();
                }
            });

            return;
        }

        run();
    };

    run();

    // The timer asks like anything else, so the gap holds for it too; a tick while a read is out is skipped.
    const cancel = every(FRAME_REFRESH_MS, () => {
        if (!isReading) {
            request();
        }
    });

    return {
        request,
        stop: () => {
            isStopped = true;
            cancel();
            cancelWait?.();
        },
    };
};
