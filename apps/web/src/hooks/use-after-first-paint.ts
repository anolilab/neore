import { useEffect, useState } from "react";

/** How long after the browser first goes idle the deferred work may start. */
const AFTER_FIRST_PAINT_DELAY_MS = 3000;

// Once per page load: after first paint has passed, later mounts need not wait again.
const firstPaint = { passed: false };

/**
 * `false` until first paint has settled — the browser went idle, then
 * {@link AFTER_FIRST_PAINT_DELAY_MS} more — and `true` from then on.
 *
 * For queries a screen does not need to DRAW (changelog badge, usage ring,
 * admin link, impersonation banner): gate them on this so they do not join
 * first paint's burst. Every query queues on the single `__root__` shard, so a
 * burst is first paint's latency — and the budget `e2e/first-paint.e2e.test.ts`
 * holds the app to.
 */
const useAfterFirstPaint = (): boolean => {
    const [ready, setReady] = useState(firstPaint.passed);

    useEffect(() => {
        if (ready) {
            return undefined;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        const start = () => {
            timer = setTimeout(() => {
                firstPaint.passed = true;
                setReady(true);
            }, AFTER_FIRST_PAINT_DELAY_MS);
        };
        const idle = typeof globalThis.requestIdleCallback === "function" ? globalThis.requestIdleCallback(start, { timeout: 2000 }) : undefined;

        if (idle === undefined) {
            start();
        }

        return () => {
            if (idle !== undefined) {
                globalThis.cancelIdleCallback(idle);
            }

            clearTimeout(timer);
        };
    }, [ready]);

    return ready;
};

export default useAfterFirstPaint;
