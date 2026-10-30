/** A session's link to its thread on the backend: `session_open` until the backend answers. */
import type { HostSessionInfo, PostResult } from "./host-events";
import { jitteredBackoff } from "./host-events";

export class SessionLink {
    /** `null`: this session is not posted (the computer is not paired). */
    public threadId: string | null | undefined;

    private attempts = 0;

    /** The local session is over: no more `session_open`. */
    private closed = false;

    private opening = false;

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
        clearTimeout(this.timer);
    }

    /** The local session ended: a `session_open` still being retried must not create a backend session for it. */
    public close(): void {
        this.closed = true;
        this.stop();

        if (this.threadId === undefined) {
            this.local();
        }
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

        try {
            const deviceId = this.poster.deviceId();

            if (deviceId === undefined) {
                this.local();

                return;
            }

            const payload = JSON.stringify({ deviceId, events: [{ ...this.info, kind: "session_open" }], issuedAt: this.poster.now(), kind: "turn", sessionId: this.sessionId, v: 1 });
            const result = await this.poster.request(payload);

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
