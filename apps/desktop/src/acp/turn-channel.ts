/** One turn's output on its way to the backend, in order, one batch at a time (`ingest.ts` has the rules). */
import type { HostEvent, PostResult } from "./host-events";
import { jitteredBackoff, wireBytes } from "./host-events";

/** At most one post per turn in this interval. */
export const POST_INTERVAL_MS = 250;
/** A turn with nothing to say still posts this often, so the backend's reaper does not time it out. */
export const KEEPALIVE_MS = 30_000;
/** Where a probe for the backend's next `seq` starts; far past anything a turn writes, so the answer is a 409. */
const PROBE_SEQ = 1_000_000_000;

/** A text event's longest text. The backend takes 65536; a smaller piece keeps a post well under its body cap after JSON escaping, twice. */
const MAX_EVENT_TEXT = 16_000;
/** What one post's events add to its body, in UTF-8 bytes. The backend refuses a body past 256 KiB; the rest is the envelope and headroom. */
const MAX_BATCH_BYTES = 200_000;
const MAX_BATCH_EVENTS = 200;
/** Unsent output a turn holds while the backend is out of reach; past this, new text is dropped, not the turn. */
const MAX_PENDING_JSON = 4_000_000;

const jsonLength = (event: HostEvent): number => JSON.stringify(event).length;

interface Inflight {
    events: HostEvent[];
    firstSeq: number;
}

/** What a channel needs from the poster it belongs to. */
export interface ChannelHost {
    /**
     * The backend closed a turn this host has not ended (Stop, the reaper, a revoke), so the agent may still be
     * running it. A cancel that never arrived (the page was throttled or closed, the call expired) is made good here.
     */
    readonly endedByBackend: (channel: TurnChannel) => void;
    readonly finished: (channel: TurnChannel) => void;
    readonly log: (message: string) => void;
    readonly now: () => number;
    readonly random: () => number;
    readonly send: (channel: TurnChannel, firstSeq: number, events: HostEvent[]) => Promise<PostResult>;
    /** `null`: the session is not posted. `undefined`: its thread is not known yet. */
    readonly threadOf: (sessionId: string) => string | null | undefined;
}

/** One turn's output on its way to the backend. */
export class TurnChannel {
    public threadId: string | undefined;

    private attempts = 0;

    private dropped = 0;

    /** The batch being sent, or waiting for its retry. It is never changed or merged into. */
    private inflight: Inflight | undefined;

    private keepalive: ReturnType<typeof setTimeout> | undefined;

    private lastPostAt = 0;

    private nextSeq = 0;

    private pending: HostEvent[] = [];

    private pendingJson = 0;

    /** Resuming a turn from a previous run: the first post only finds out where the backend is. */
    private probe: boolean;

    /** Set once `turn_end` is queued; nothing is accepted after it. */
    private sealed = false;

    private sending = false;

    private stopped = false;

    private timer: ReturnType<typeof setTimeout> | undefined;

    public constructor(
        private readonly host: ChannelHost,
        public readonly sessionId: string,
        public readonly turnId: string,
        threadId: string | undefined,
        probe: boolean,
    ) {
        this.threadId = threadId;
        this.probe = probe;
    }

    /** Whether output is still waiting to be delivered. */
    public get busy(): boolean {
        return this.inflight !== undefined || this.pending.length > 0;
    }

    public enqueue(event: HostEvent): void {
        if (this.sealed || this.stopped) {
            return;
        }

        // Over the cap while the backend is out of reach: output is dropped, but the turn's own start and end are kept.
        if (event.kind !== "turn_start" && event.kind !== "turn_end" && this.pendingJson > MAX_PENDING_JSON) {
            this.dropped += 1;

            return;
        }

        const isText = event.kind === "text" || event.kind === "reasoning";

        const last = this.pending.at(-1);

        // Adjacent deltas of one kind merge into one event, up to the event cap.
        if (isText && last?.kind === event.kind && last.text.length + event.text.length <= MAX_EVENT_TEXT) {
            last.text += event.text;
            this.pendingJson += event.text.length;
        } else {
            this.pending.push(event);
            this.pendingJson += jsonLength(event);
        }

        this.schedule(Math.max(0, POST_INTERVAL_MS - (this.host.now() - this.lastPostAt)));
    }

    public append(kind: "reasoning" | "text", delta: string): void {
        for (let start = 0; start < delta.length; start += MAX_EVENT_TEXT) {
            this.enqueue({ kind, text: delta.slice(start, start + MAX_EVENT_TEXT) });
        }
    }

    /** Queues the end of the turn. The channel takes nothing after it. */
    public end(reason: "cancelled" | "failed" | "finished" | "interrupted", error?: string): void {
        if (this.sealed) {
            return;
        }

        this.enqueue({ kind: "turn_end", reason, ...(error !== undefined && { error: error.slice(0, 1000) }) });
        this.sealed = true;
    }

    /** The session's thread is known: posting can start. */
    public bindThread(threadId: string): void {
        this.threadId = threadId;
        this.schedule(0);
    }

    /** The session will not be posted: a flush now finds that and ends the channel. */
    public release(): void {
        this.schedule(0);
    }

    public stop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
        clearTimeout(this.keepalive);
    }

    private schedule(delayMs: number): void {
        if (this.timer !== undefined || this.stopped) {
            return;
        }

        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, delayMs);
    }

    private async flush(): Promise<void> {
        if (this.sending || this.stopped) {
            return;
        }

        if (this.threadId === undefined) {
            const known = this.host.threadOf(this.sessionId);

            // A refused session is not posted at all: ending here frees the channel instead of letting events pile up behind it.
            if (known === null) {
                this.finish();

                return;
            }

            this.threadId = known;
        }

        if (this.threadId === undefined) {
            // The session is still being opened; its open binds the thread and schedules this.
            return;
        }

        // A batch waiting for its retry goes again as it was. Otherwise the next one is taken, or, with nothing
        // queued, an empty keepalive.
        if (this.inflight === undefined) {
            const events = this.probe ? this.takeAll() : this.takeBatch();

            this.inflight = { events, firstSeq: this.probe ? PROBE_SEQ : this.nextSeq };
            this.pendingJson = this.pending.reduce((sum, event) => sum + jsonLength(event), 0);
        }

        await this.transmit(this.inflight);
    }

    private takeAll(): HostEvent[] {
        const all = [...this.pending];

        this.pending.length = 0;

        return all;
    }

    private takeBatch(): HostEvent[] {
        const batch: HostEvent[] = [];
        let size = 0;

        while (this.pending.length > 0 && batch.length < MAX_BATCH_EVENTS) {
            const [next] = this.pending;
            const length = next === undefined ? 0 : wireBytes(next);

            if (next === undefined || (batch.length > 0 && size + length > MAX_BATCH_BYTES)) {
                break;
            }

            size += length;
            batch.push(next);
            this.pending.shift();
        }

        return batch;
    }

    private async transmit(inflight: Inflight): Promise<void> {
        this.lastPostAt = this.host.now();
        this.sending = true;
        clearTimeout(this.keepalive);
        this.keepalive = undefined;

        let result: PostResult;

        try {
            result = await this.host.send(this, inflight.firstSeq, inflight.events);
        } catch {
            result = { kind: "retry" };
        } finally {
            this.sending = false;
        }

        if (this.stopped) {
            return;
        }

        switch (result.kind) {
            case "gap": {
                await this.resend(inflight, result.next);
                break;
            }
            case "ok": {
                this.attempts = 0;
                this.probe = false;
                this.inflight = undefined;
                this.nextSeq = result.next;

                if (result.ended && !this.sealed) {
                    this.host.endedByBackend(this);
                }

                if (result.ended || inflight.events.some((event) => event.kind === "turn_end")) {
                    this.finish();
                } else {
                    this.afterAck();
                }

                break;
            }
            case "refused": {
                this.host.log("[acp-host] the backend refused this turn's output; it is no longer posted");
                this.finish();
                break;
            }
            default: {
                this.attempts += 1;
                // `inflight` stays as it is; what is queued meanwhile waits behind it. Output that arrived during the
                // post left a 250 ms timer: the backoff replaces it, or the outage is retried at the normal cadence.
                clearTimeout(this.timer);
                this.timer = undefined;
                this.schedule(jitteredBackoff(this.attempts, this.host.random));
            }
        }
    }

    /** The backend said where it is. A probe learns its position this way; anything else resends from there. */
    private async resend(inflight: Inflight, next: number): Promise<void> {
        if (!this.probe && next < inflight.firstSeq) {
            this.host.log("[acp-host] the backend lost output this host had already sent; the turn is no longer posted");
            this.finish();

            return;
        }

        this.probe = false;
        this.nextSeq = next;
        this.inflight = { events: inflight.events.slice(Math.max(0, next - inflight.firstSeq)), firstSeq: next };
        // The resend is a post like any other: it waits out the interval.
        this.schedule(Math.max(0, POST_INTERVAL_MS - (this.host.now() - this.lastPostAt)));
    }

    /** After an acknowledged batch: more output waits, or the turn idles under a keepalive. */
    private afterAck(): void {
        if (this.pending.length > 0) {
            this.schedule(Math.max(0, POST_INTERVAL_MS - (this.host.now() - this.lastPostAt)));

            return;
        }

        this.keepalive = setTimeout(() => {
            this.keepalive = undefined;
            this.flush();
        }, KEEPALIVE_MS);
    }

    private finish(): void {
        if (this.dropped > 0) {
            this.host.log(`[acp-host] ${String(this.dropped)} pieces of output were dropped while the backend was out of reach`);
        }

        this.stop();
        this.pending.length = 0;
        this.inflight = undefined;
        this.host.finished(this);
    }
}
