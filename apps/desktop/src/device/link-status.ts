import type { ReconnectView } from "./types";

/** What the local window says about a server's connection, from the engine's view of it. */
export const describeLink = (host: { connected: boolean; platform: string | null; reconnect: ReconnectView | null }, now: number): string => {
    if (host.connected) {
        return `connected (${host.platform ?? "unknown"})`;
    }

    const { reconnect } = host;

    if (reconnect === null) {
        return "not connected";
    }

    const attempt = reconnect.attempt === null ? "" : ` (attempt ${String(reconnect.attempt)} of ${String(reconnect.maxAttempts)})`;

    if (reconnect.phase === "connecting") {
        return `reconnecting${attempt}…`;
    }

    if (reconnect.phase === "gaveUp") {
        return `not connected — ${reconnect.reason ?? "the connection was lost"}. Retry to connect again.`;
    }

    const seconds = Math.max(1, Math.ceil(((reconnect.nextAttemptAt ?? now) - now) / 1000));

    return `connection lost — reconnecting${attempt} in ${String(seconds)} s`;
};

/** The note under a server whose ssh cannot share one connection between sessions, or `null`. */
export const multiplexingNote = (multiplexed: boolean): string | null => {
    if (multiplexed) {
        return null;
    }

    return "This computer's ssh cannot share a connection between sessions, so each server uses one ssh process of its own.";
};
