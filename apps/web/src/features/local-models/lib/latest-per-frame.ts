export interface LatestPerFrame<T> {
    /** Drops the pending value; for a turn that ended without a reply to show. */
    cancel: () => void;
    /** Applies the pending value now rather than on the next frame. */
    flush: () => void;
    push: (value: T) => void;
}

/**
 * Keeps only the newest value pushed within an animation frame and applies it once per frame, so a reply that
 * streams many tokens a frame updates the chat once a frame. A hidden tab runs no frames: its value waits until the
 * tab is shown or `flush` runs.
 */
export const createLatestPerFrame = <T>(apply: (value: T) => void): LatestPerFrame<T> => {
    let pending: { value: T } | null = null;
    let frame: number | null = null;

    const cancel = () => {
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }

        pending = null;
    };

    const flush = () => {
        const next = pending;

        cancel();

        if (next) {
            apply(next.value);
        }
    };

    return {
        cancel,
        flush,
        push: (value: T) => {
            pending = { value };
            frame ??= requestAnimationFrame(flush);
        },
    };
};
