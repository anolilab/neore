/**
 * A session's link to its thread on the backend: `session_open` until the backend answers, again whenever what it reports
 * changes (the agent's options), and `close` when the session is over.
 */
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

    /** The backend has answered an open with the thread: a later re-post only carries changed options. */
    private confirmed = false;

    /** The info changed while an open was in flight: once it is answered, the open goes out again with the new info. */
    private stale = false;

    /** A `session_open` was sent and the backend may have created the session (its answer was lost, or not yet known). */
    private posted = false;

    private timer: ReturnType<typeof setTimeout> | undefined;

    public constructor(
        private readonly sessionId: string,
        private info: HostSessionInfo,
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
        this.closeTimer = setTimeout(
            () => {
                this.closeTimer = undefined;
                this.announceClose();
            },
            jitteredBackoff(this.closeAttempts, this.poster.random),
        );
    }

    /**
     * The session's info changed. A post in flight or waiting to be retried sends the new info; otherwise it is posted now.
     * The backend keeps it only when its report is newer than the one stored, so an open that arrives late changes nothing.
     */
    public update(info: HostSessionInfo): void {
        this.info = info;

        if (this.closed || this.threadId === null || this.timer !== undefined) {
            return;
        }

        if (this.opening) {
            this.stale = true;

            return;
        }

        this.open();
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
        // A re-post for a session the backend already opened (its options changed): a refusal of it drops the change only. A
        // session the backend started knows its thread before its first open, so the thread alone does not say this.
        const rebind = this.confirmed;

        try {
            const deviceId = this.poster.deviceId();

            if (deviceId === undefined) {
                this.local();

                return;
            }

            // The agent's options ride as their own event after the open, in the same post.
            const { options, ...info } = this.info;
            const events = [{ ...info, kind: "session_open" }, ...(options === undefined ? [] : [{ kind: "session_options", options }])];
            const payload = JSON.stringify({ deviceId, events, issuedAt: this.poster.now(), kind: "turn", sessionId: this.sessionId, v: 1 });

            this.posted = true;

            const result = await this.poster.request(payload);

            if ((result.kind === "refused" && !rebind) || (result.kind === "ok" && result.ended)) {
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
                    this.confirmed = true;
                    this.poster.bound(this.sessionId, result.threadId);
                }
            } else if (result.kind === "refused") {
                // A refused re-post leaves the session and its thread as they are: turns still post into it, and its close still goes out.
                if (!rebind) {
                    this.local();
                }
            } else {
                this.retryLater();
            }
        } catch {
            this.retryLater();
        } finally {
            this.opening = false;
        }

        const again = this.stale;

        this.stale = false;

        if (again && !this.closed && this.timer === undefined && typeof this.threadId === "string") {
            this.open();
        }
    }

    private local(): void {
        this.threadId = null;
        // A later open (after pairing) is a first open again.
        this.confirmed = false;
        this.poster.released(this.sessionId);
    }

    private retryLater(): void {
        if (this.closed) {
            return;
        }

        this.attempts += 1;
        this.timer = setTimeout(
            () => {
                this.timer = undefined;
                this.open();
            },
            jitteredBackoff(this.attempts, this.poster.random),
        );
    }
}
