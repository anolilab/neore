/**
 * The dock / launcher badge for finished runs, set from the site through
 * `neoreNative.setBadge(count)`. `app.setBadgeCount` covers macOS and Linux.
 * Windows is skipped: its taskbar overlay needs a generated icon per count.
 */

export const MAX_BADGE_COUNT = 999;

/** Non-numbers, NaN and Infinity are refused; a finite number is truncated, then clamped to 0..999. */
export const clampBadgeCount = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError("setBadge: count must be a finite number");
    }

    return Math.min(MAX_BADGE_COUNT, Math.max(0, Math.trunc(value)));
};

const supportsBadge = (platform: NodeJS.Platform): boolean => platform === "darwin" || platform === "linux";

/** The sender shape the main process checks; `senderFrame` is what `isTrustedUrl` reads. */
export interface BadgeSender {
    senderFrame?: { url: string } | null;
}

/**
 * The `neore:set-badge` handler. An untrusted sender is refused before the
 * payload is looked at; on a platform without a badge the call is accepted and does nothing.
 */
export const createSetBadgeHandler
    = <Event extends BadgeSender>(dependencies: { isTrusted: (event: Event) => boolean; platform: NodeJS.Platform; setBadgeCount: (count: number) => void }) =>
        (event: Event, payload: unknown): void => {
            if (!dependencies.isTrusted(event)) {
                throw new Error("setBadge: untrusted sender");
            }

            const count = clampBadgeCount(payload);

            if (supportsBadge(dependencies.platform)) {
                dependencies.setBadgeCount(count);
            }
        };
