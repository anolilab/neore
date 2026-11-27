/**
 * Whether the chat shows its link to the browser screen, outside React so the timing is tested without a screen. It
 * shows while the browser runs; for a reader it goes at the grant's end, and the status is read once at the real end
 * (a renewed grant pushes nothing). Hiding the link never cancels that read: a renewed grant shows it again.
 */
import type { BrowserStatus } from "./browser-api";
import { browserLinkUntil, GRANT_END_MARGIN_MS } from "./browser-view-state";
import { readUntilAnswered, watchGrantEnd } from "./grant-end";

export interface BrowserLinkWatch {
    /**
     * A status from the live query; `undefined` when the chat was refused. It cancels a read still out for the one before,
     * so an older answer never undoes it.
     */
    show: (status: BrowserStatus | undefined) => void;
    stop: () => void;
}

export const watchBrowserLink = ({
    after,
    now = Date.now,
    onChange,
    read,
}: {
    after?: (ms: number, run: () => void) => () => void;
    now?: () => number;
    onChange: (isShown: boolean) => void;
    read: () => Promise<BrowserStatus>;
}): BrowserLinkWatch => {
    let stopTimers: (() => void) | undefined;

    const show = (status: BrowserStatus | undefined): void => {
        // A newer status replaces the timers of the one before.
        stopTimers?.();
        stopTimers = undefined;

        const until = status === undefined ? undefined : browserLinkUntil(status, now());

        onChange(until !== undefined);

        if (until === undefined || until === Infinity) {
            return;
        }

        let stopRead: (() => void) | undefined;
        const stopWait = watchGrantEnd({
            after,
            endsAt: until,
            now,
            onEnd: () => onChange(false),
            reread: () => {
                stopRead = readUntilAnswered({ after, now, onAnswer: (answer) => show(answer), read });
            },
            rereadAt: until + GRANT_END_MARGIN_MS,
        });

        stopTimers = () => {
            stopWait();
            stopRead?.();
        };
    };

    return {
        show,
        stop: () => {
            stopTimers?.();
            stopTimers = undefined;
        },
    };
};
