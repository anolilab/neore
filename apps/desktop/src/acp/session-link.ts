/** A session's link to its thread on the backend: `session_open` until the backend answers. */
import type { HostSessionInfo, PostResult } from "./host-events";
import { jitteredBackoff } from "./host-events";

export class SessionLink {
    /** `null`: this session is not posted (the computer is not paired). */
    public threadId: string | null | undefined;

    private attempts = 0;

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
            request: (payload: string) => Promise<PostResult>;
        },
    ) {}

    public stop(): void {
        clearTimeout(this.timer);
    }

    /** Posts `session_open` until the backend answers with the thread. */
    public async open(): Promise<void> {
        if (this.opening) {
            return;
        }

        this.opening = true;

        try {
            const deviceId = this.poster.deviceId();

            if (deviceId === undefined) {
                this.threadId = null;

                return;
            }

            const payload = JSON.stringify({ deviceId, events: [{ ...this.info, kind: "session_open" }], issuedAt: this.poster.now(), kind: "turn", sessionId: this.sessionId, v: 1 });
            const result = await this.poster.request(payload);

            if (result.kind === "ok" && result.threadId !== undefined) {
                this.threadId = result.threadId;
                this.poster.bound(this.sessionId, result.threadId);
            } else if (result.kind === "refused") {
                this.threadId = null;
            } else {
                this.retryLater();
            }
        } catch {
            this.retryLater();
        } finally {
            this.opening = false;
        }
    }

    private retryLater(): void {
        this.attempts += 1;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.open();
        }, jitteredBackoff(this.attempts, this.poster.random));
    }
}
