/** Statuses that mean work is in flight. A cached one is a last-known state, so it is never shown as live. */
const IN_FLIGHT = new Set(["busy", "pending", "queued", "running", "starting", "streaming"]);

const SETTLED: Record<string, string> = {
    abort: "Stopped",
    active: "Active",
    archived: "Archived",
    ended: "Ended",
    error: "Failed",
    failed: "Failed",
    finish: "Finished",
    idle: "Idle",
    success: "Finished",
};

interface FormatOptions {
    locale?: string;
    now?: number;
    timeZone?: string;
}

const formatMoment = (at: number, { locale, now = Date.now(), timeZone }: FormatOptions): string => {
    const sameDay = (value: number) => new Intl.DateTimeFormat("en-CA", { dateStyle: "short", timeZone }).format(value);
    const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(at);

    if (sameDay(at) === sameDay(now)) {
        return time;
    }

    return `${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone }).format(at)}, ${time}`;
};

/** Words for the sync time: the time alone on the day of the sync, with the date on an earlier day. */
export const lastSyncedLabel = (syncedAt: number | undefined, options: FormatOptions = {}): string => {
    if (syncedAt === undefined) {
        return "Not synced yet";
    }

    return `Last synced ${formatMoment(syncedAt, options)}`;
};

/**
 * The status to show for a row. Online and live it is the live status. Offline, or read from the cache, an in-flight
 * status becomes "Last seen": the cache knows the session was running when it was read, not that it is running now.
 */
export const displayStatus = (
    status: string,
    { fromCache = false, isOffline, lastSeenAt, ...format }: FormatOptions & { fromCache?: boolean; isOffline: boolean; lastSeenAt: number | undefined },
): string => {
    // A host that stopped answering is "last seen" whether or not this phone is online: the phone never hears from a host itself.
    if (status === "offline") {
        return lastSeenAt === undefined ? "Last seen" : `Last seen ${formatMoment(lastSeenAt, format)}`;
    }

    if (!IN_FLIGHT.has(status)) {
        return SETTLED[status] ?? status;
    }

    if (!isOffline && !fromCache) {
        return "Running";
    }

    return lastSeenAt === undefined ? "Last seen" : `Last seen ${formatMoment(lastSeenAt, format)}`;
};
