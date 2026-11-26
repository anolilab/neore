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
