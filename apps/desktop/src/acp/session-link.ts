/** A session's link to its thread on the backend: `session_open` until the backend answers, `close` when the session is over. */
import type { HostSessionInfo, PostResult } from "./host-events";
import { jitteredBackoff } from "./host-events";

/** A close that cannot be delivered is tried this many times; after that the backend's reaper and the session list are what remain. */
const MAX_CLOSE_ATTEMPTS = 6;

export class SessionLink {
    /** `null`: this session is not posted (the computer is not paired). */
    public threadId: string | null | undefined;

    private attempts = 0;

    private closeAttempts = 0;

    private closeTimer: ReturnType<typeof setTimeout> | undefined;

    /** The local session is over: no more `session_open`. */
    private closed = false;

    /** The poster is going away: nothing more is sent. */
    private halted = false;

    /** The `session_open` request being made, so a close can wait for the backend's answer to it. */
    private inflight: Promise<void> | undefined;

    private opening = false;

    /** A `session_open` was sent and the backend may have created the session (its answer was lost, or not yet known). */
    private posted = false;

    private timer: ReturnType<typeof setTimeout> | undefined;

    public constructor(
        private readonly sessionId: string,
        private readonly info: HostSessionInfo,
        private readonly poster: {
            bound: (sessionId: string, threadId: string) => void;
            deviceId: () => string | undefined;
            now: () => number;
            random: () => number;
            /** The session will not be posted: turns waiting on its thread are over. */
            released: (sessionId: string) => void;
            request: (payload: string) => Promise<PostResult>;
        },
    ) {}

    public stop(): void {
        this.halted = true;
        clearTimeout(this.timer);
        clearTimeout(this.closeTimer);
    }

    /** The local session ended: a `session_open` still being retried must not create a backend session for it. */
    public close(): void {
        this.closed = true;
        clearTimeout(this.timer);

        if (this.threadId === undefined) {
            this.local();
        }
    }

    /**
     * The local session is over and its turns are delivered: the backend ends the session now instead of leaving it
     * `idle` until someone reads it as stale. A session the backend never heard of has nothing to close. A close
     * waits for an open still in flight: sent first, it would be answered "unknown" and the open would then create
     * a session nobody closes.
     */
    public async announceClose(): Promise<void> {
        await this.inflight;

        const deviceId = this.poster.deviceId();

        if (deviceId === undefined || this.halted || !this.posted) {
            return;
        }

        const payload = JSON.stringify({ close: true, deviceId, events: [], issuedAt: this.poster.now(), kind: "turn", sessionId: this.sessionId, v: 1 });
        let result: PostResult;

        try {
            result = await this.poster.request(payload);
        } catch {
            result = { kind: "retry" };
        }

        if (result.kind !== "retry" || this.halted || this.closeAttempts >= MAX_CLOSE_ATTEMPTS) {
            return;
        }

        this.closeAttempts += 1;
        this.closeTimer = setTimeout(() => {
            this.closeTimer = undefined;
            this.announceClose();
        }, jitteredBackoff(this.closeAttempts, this.poster.random));
    }

    /** The computer was paired after this session opened: tries `session_open` again if it was left local. */
    public paired(): void {
        if (this.closed || this.threadId !== null) {
            return;
        }

        this.threadId = undefined;
        this.open();
    }

    /** Posts `session_open` until the backend answers with the thread. */
    public async open(): Promise<void> {
        if (this.opening || this.closed) {
            return;
        }

        this.opening = true;
        this.inflight = this.attempt();
        await this.inflight;
    }

    private async attempt(): Promise<void> {
        try {
            const deviceId = this.poster.deviceId();

            if (deviceId === undefined) {
                this.local();

                return;
            }

            const payload = JSON.stringify({ deviceId, events: [{ ...this.info, kind: "session_open" }], issuedAt: this.poster.now(), kind: "turn", sessionId: this.sessionId, v: 1 });

            this.posted = true;

            const result = await this.poster.request(payload);

            if (result.kind === "refused" || (result.kind === "ok" && result.ended)) {
                this.posted = false;
            }

            if (this.closed) {
                return;
            }

            if (result.kind === "ok" && result.threadId !== undefined) {
                // An ended session (its thread was deleted in the app) takes no more turns.
                if (result.ended) {
                    this.local();
                } else {
                    this.threadId = result.threadId;
                    this.poster.bound(this.sessionId, result.threadId);
                }
            } else if (result.kind === "refused") {
                this.local();
            } else {
                this.retryLater();
            }
        } catch {
            this.retryLater();
        } finally {
            this.opening = false;
        }
    }

    private local(): void {
        this.threadId = null;
        this.poster.released(this.sessionId);
    }

    private retryLater(): void {
        if (this.closed) {
            return;
        }

        this.attempts += 1;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.open();
        }, jitteredBackoff(this.attempts, this.poster.random));
    }
}
