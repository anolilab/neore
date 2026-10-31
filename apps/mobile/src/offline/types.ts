/** A row as the cache hands it back: `syncedAt` is when this device last read it from the server. */
export type Synced<T> = T & { syncedAt: number };

export interface CachedThread {
    id: string;
    /** "host" for a thread run on a paired computer. */
    runner?: "host";
    status: string;
    title: string;
    updatedAt: number;
}

export interface CachedMessage {
    createdAt: number;
    id: string;
    role: string;
    status: string;
    text: string;
    threadId: string;
    /** The message's own version stamp; the creation time when the server gives none. */
    updatedAt?: number;
}

export interface CachedStatus {
    id: string;
    kind: "host" | "worker";
    label: string;
    /** The device's last heartbeat for a host, the last event for a worker run. */
    lastSeenAt?: number;
    status: string;
    threadId?: string;
    updatedAt: number;
}

export type ThreadRow = Synced<CachedThread>;
export type MessageRow = Synced<CachedMessage> & { updatedAt: number };
export type StatusRow = Synced<CachedStatus>;
/** A status as a screen shows it: `fromCache` is true until a live read has replaced the saved copy. */
export type ShownStatus = StatusRow & { fromCache: boolean };
