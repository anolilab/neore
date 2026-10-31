import { settleQuietly } from "./quietly";

export interface ReconnectRefresher {
    /** Tells the refresher whether the app is offline now. Coming back online runs the refresh once. */
    update: (isOffline: boolean) => void;
}

/**
 * Reads again when the app comes back online. It takes a refresh callback and nothing else, so there is no path
 * from a reconnect to a write.
 */
export const createReconnectRefresher = (refresh: () => Promise<void> | void): ReconnectRefresher => {
    let wasOffline = false;

    return {
        update: (isOffline) => {
            const reconnected = wasOffline && !isOffline;

            wasOffline = isOffline;

            if (reconnected) {
                // The refresh reports its own failure; a reconnect has nobody to tell.
                settleQuietly(async () => refresh());
            }
        },
    };
};
