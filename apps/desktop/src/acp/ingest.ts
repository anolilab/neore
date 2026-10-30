/**
 * Posts a coding agent's turn output to the backend (plans/acp-agent-host.md §4.2–4.5), straight from the main
 * process. The page is not in this path.
 *
 * - **One batch at a time per turn, at most one post per 250 ms** (`turn-channel.ts`). Deltas queued in between
 * are merged. A batch that is out is never changed: a retry carries exactly the events the first try did, since
 * the backend claims each by `(turnId, seq)` and drops one it already has.
 * - **Signed in Rust.** `sign` is `DeviceCore.signTurn`; the device secret never leaves it.
 * - **A 409 answers `{ next }` when a post starts past the backend's next free `seq`.** Only a restart's probe
 * (which starts far past on purpose) expects it: it learns where the backend is and sends from there, after the
 * same 250 ms. On an ordinary batch it means the backend lost output the host had already had acknowledged, and
 * the turn is no longer posted.
 * - **A post the backend will never take** (403 not ours, 400 a field past its limits, 413 a body past its cap) ends
 * the turn's posting. The host cuts every field to the backend's limits and every batch to its byte cap first,
 * so these mean version skew, not a long prompt.
 * - **Backoff, jittered and capped**, for anything that is not an answer: a network error, a 5xx, a 429, a 401
 * (a skewed clock or a revoked device looks like this). The batch is kept; the queue behind it is bounded.
 * - **A keepalive** (a post with no events) while a turn runs, so a long tool call is not mistaken for a dead host.
 * - **A turn cut off by a restart** is recorded on disk while it runs. On the next start each such turn is ended
 * with the reason `interrupted`, at the `seq` the backend says is next.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HostEvent, HostSessionInfo, PermissionOutcomeKind, PermissionRequestEvent, PostResult, SessionObserver } from "./host-events";
import { capPermissionRequest, capPrompt, capRequestId, capSessionInfo, endReasonOf } from "./host-events";
import type { MediaOptions } from "./media";
import { collectMedia, imageReferences } from "./media";
import { SessionLink } from "./session-link";
import type { ChannelHost } from "./turn-channel";
import { TurnChannel } from "./turn-channel";
import type { StopReason } from "./types";

export type { HostEvent, HostSessionInfo, PermissionOutcomeKind, PermissionRequestEvent, SessionObserver } from "./host-events";
export { KEEPALIVE_MS, POST_INTERVAL_MS } from "./turn-channel";

const REQUEST_TIMEOUT_MS = 20_000;
/** The most of a turn's text kept for its references; a reply is capped at the same length on the backend. */
const MAX_TURN_TEXT_CHARS = 256_000;
const REFUSED_STATUSES = new Set([400, 403, 413]);

export interface PosterOptions {
    /** This computer's paired device id; undefined while it is not paired. */
    deviceId: () => string | undefined;
    /** `&lt;backend origin>/hosts/ingest`. */
    endpoint: URL;
    fetch?: typeof fetch;
    log?: (message: string) => void;
    /** The files a turn's reply refers to (`media.ts`). Without it, a reply's images are text. */
    media?: Omit<MediaOptions, "deviceId" | "fetch" | "log" | "now">;
    now?: () => number;
    random?: () => number;
    /** `DeviceCore.signTurn`. */
    sign: (payload: string) => string;
    /** A file under the app's data folder, holding the turns that are running. */
    stateFile: string;
}

const settledAfter = async (previous: Promise<void>, read: Promise<unknown>): Promise<void> => {
    await previous;
    await read;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class HostPoster implements SessionObserver {
    private readonly channelHost: ChannelHost;

    private readonly channels = new Map<string, TurnChannel>();

    /** What each session shows the backend, to name its agent and folder when a reply's files are read. */
    private readonly infos = new Map<string, HostSessionInfo>();

    private readonly sessions = new Map<string, SessionLink>();

    /** The text of each running turn, kept for the references its reply makes (capped). */
    private readonly texts = new Map<string, string>();

    private stopped = false;

    /** Serialises writes of the state file; a write never overtakes the one before it. */
    private writing: Promise<void> = Promise.resolve();

    public constructor(private readonly options: PosterOptions) {
        this.channelHost = {
            finished: (channel) => {
                this.channels.delete(channel.turnId);
                this.texts.delete(channel.turnId);
                this.persist();
            },
            log: (message) => this.options.log?.(message),
            now: () => this.now(),
            random: () => this.random(),
            send: async (channel, firstSeq, events) => await this.sendTurn(channel, firstSeq, events),
            threadOf: (sessionId) => this.sessions.get(sessionId)?.threadId,
        };
    }

    // ─── From the sessions ──────────────────────────────────────────────────

    public sessionOpened(sessionId: string, info: HostSessionInfo): void {
        this.infos.set(sessionId, info);

        const link = new SessionLink(sessionId, capSessionInfo(info), {
            bound: (id, threadId) => this.bindThread(id, threadId),
            deviceId: () => this.options.deviceId(),
            now: () => this.now(),
            random: () => this.random(),
            released: (id) => this.releaseChannels(id),
            request: async (payload) => await this.request(payload),
        });

        this.sessions.set(sessionId, link);

        if (this.options.deviceId() === undefined) {
            // Not paired: the session stays on this computer.
            link.threadId = null;

            return;
        }

        link.open();
    }

    /** This computer was paired: the sessions that stayed local while it was not now open on the backend. */
    public paired(): void {
        for (const link of this.sessions.values()) {
            link.paired();
        }
    }

    public sessionEnded(sessionId: string): void {
        this.sessions.get(sessionId)?.close();
    }

    public turnStarted(sessionId: string, turnId: string, user: string): void {
        const link = this.sessions.get(sessionId);

        if (link === undefined || link.threadId === null || this.stopped) {
            return;
        }

        const channel = new TurnChannel(this.channelHost, sessionId, turnId, link.threadId, false);

        this.channels.set(turnId, channel);
        channel.enqueue({ kind: "turn_start", text: capPrompt(user) });
        this.persist();
    }

    public text(_sessionId: string, turnId: string, delta: string): void {
        const channel = this.channels.get(turnId);

        if (channel === undefined) {
            return;
        }

        channel.append("text", delta);

        if (this.options.media !== undefined) {
            const kept = this.texts.get(turnId) ?? "";

            // Past the cap nothing more is kept, so a long turn costs nothing more per delta.
            if (kept.length < MAX_TURN_TEXT_CHARS) {
                this.texts.set(turnId, (kept + delta).slice(0, MAX_TURN_TEXT_CHARS));
            }
        }
    }

    public thought(_sessionId: string, turnId: string, delta: string): void {
        this.channels.get(turnId)?.append("reasoning", delta);
    }

    public tool(_sessionId: string, turnId: string, tool: { id: string; kind: string; status: string; title: string }): void {
        this.channels.get(turnId)?.enqueue({ id: tool.id.slice(0, 128), kind: "tool", status: tool.status, title: tool.title.slice(0, 500), toolKind: tool.kind.slice(0, 64) });
    }

    public permissionRequested(_sessionId: string, turnId: string, request: PermissionRequestEvent): void {
        this.channels.get(turnId)?.enqueue(capPermissionRequest(request));
    }

    public permissionResolved(_sessionId: string, turnId: string, requestId: string, outcome: PermissionOutcomeKind): void {
        this.channels.get(turnId)?.enqueue({ kind: "permission_resolved", outcome, requestId: capRequestId(requestId) });
    }

    public turnEnded(sessionId: string, turnId: string, reason: StopReason | "failed", error?: string): void {
        const channel = this.channels.get(turnId);

        if (channel === undefined) {
            return;
        }

        const text = this.texts.get(turnId) ?? "";
        const info = this.infos.get(sessionId);

        this.texts.delete(turnId);

        // A turn that failed leaves no reply to show files in; one without an image reference has nothing to read.
        if (endReasonOf(reason) === "failed" || this.stopped || info === undefined || this.options.media === undefined || imageReferences(text).length === 0) {
            channel.end(endReasonOf(reason), error);

            return;
        }

        // Never rejects: every failure inside is caught, and the turn ends whatever happens.
        // eslint-disable-next-line unicorn/prefer-await -- turnEnded is synchronous, and the call has no rejection to await
        this.attachMediaThenEnd(channel, info, text, endReasonOf(reason), error).catch(() => {});
    }

    /**
     * Reads and uploads the files the reply refers to, queues their events and only then the end of the turn: the
     * channel takes nothing after it. The turn stays open meanwhile (its keepalive keeps the backend's reaper off).
     * Whatever goes wrong, the turn still ends.
     */
    private async attachMediaThenEnd(channel: TurnChannel, info: HostSessionInfo, text: string, reason: "cancelled" | "failed" | "finished", error?: string): Promise<void> {
        const { media } = this.options;

        try {
            if (media !== undefined) {
                const events = await collectMedia(
                    { ...media, deviceId: this.options.deviceId, ...this.options.fetch && { fetch: this.options.fetch }, ...this.options.log && { log: this.options.log }, now: () => this.now() },
                    info.agentKey,
                    info.folderId,
                    text,
                );

                for (const event of events) {
                    channel.enqueue(event);
                }
            }
        } catch (error_) {
            this.options.log?.(`[acp-host] a reply's files could not be attached: ${(error_ as Error).name}`);
        } finally {
            channel.end(reason, error);
        }
    }

    // ─── Start and stop ─────────────────────────────────────────────────────

    /** Ends, as `interrupted`, every turn a previous run left behind. Call once after the core is up. */
    public async recover(): Promise<void> {
        const read = this.readState();

        // A write queued from here on lands after the read, so it cannot drop the turns the read is about to find.
        this.writing = settledAfter(this.writing, read);

        const leftovers = await read;

        for (const left of leftovers) {
            if (this.channels.has(left.turnId)) {
                continue;
            }

            const channel = new TurnChannel(this.channelHost, left.sessionId, left.turnId, left.threadId, true);

            this.channels.set(left.turnId, channel);
            channel.end("interrupted");
        }
    }

    /** Stops every timer. Output not yet sent is lost, as the process is going away; the next start ends those turns as interrupted. */
    public stop(): void {
        this.stopped = true;

        for (const channel of this.channels.values()) {
            channel.stop();
        }

        for (const link of this.sessions.values()) {
            link.stop();
        }
    }

    /** Resolves once the running-turns file is up to date. */
    public async persisted(): Promise<void> {
        await this.writing;
    }

    /** Whether any turn still has output to deliver. */
    public get busy(): boolean {
        for (const channel of this.channels.values()) {
            if (channel.busy) {
                return true;
            }
        }

        return false;
    }

    // ─── Posting ────────────────────────────────────────────────────────────

    /** A session that will not be posted: the turns still waiting on its thread end instead of holding output for ever. */
    private releaseChannels(sessionId: string): void {
        for (const channel of this.channels.values()) {
            if (channel.sessionId === sessionId && channel.threadId === undefined) {
                channel.release();
            }
        }
    }

    private bindThread(sessionId: string, threadId: string): void {
        for (const channel of this.channels.values()) {
            if (channel.sessionId === sessionId) {
                channel.bindThread(threadId);
            }
        }

        this.persist();
    }

    private async sendTurn(channel: TurnChannel, firstSeq: number, events: HostEvent[]): Promise<PostResult> {
        const deviceId = this.options.deviceId();

        // Not paired yet, or the session's thread not known yet: the turn waits, it is not refused (a recovered
        // turn must survive a start that comes before pairing).
        if (deviceId === undefined || channel.threadId === undefined) {
            return { kind: "retry" };
        }

        const payload = JSON.stringify({
            deviceId,
            events,
            firstSeq,
            issuedAt: this.now(),
            kind: "turn",
            sessionId: channel.sessionId,
            threadId: channel.threadId,
            turnId: channel.turnId,
            v: 1,
        });

        return await this.request(payload);
    }

    /** One signed POST, mapped to what the poster does next. */
    private async request(payload: string): Promise<PostResult> {
        const response = await (this.options.fetch ?? fetch)(this.options.endpoint, {
            body: JSON.stringify({ payload, signature: this.options.sign(payload) }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        let body: unknown = null;

        try {
            body = await response.json();
        } catch {
            // Not JSON (a proxy's error page): the status below decides.
        }

        const fields = isRecord(body) ? body : {};

        if (response.status === 409 && typeof fields.next === "number") {
            return { kind: "gap", next: fields.next };
        }

        if (response.ok && typeof fields.next === "number") {
            return {
                ended: fields.ended === true,
                kind: "ok",
                next: fields.next,
                ...typeof fields.threadId === "string" && { threadId: fields.threadId },
            };
        }

        // 403, 400 and 413 are the backend saying it will never take this post (not our turn, a field past its limits,
        // a body past its cap); sending the same batch again would loop for ever. Every other failure is worth another try.
        return REFUSED_STATUSES.has(response.status) ? { kind: "refused" } : { kind: "retry" };
    }

    // ─── The turns that are running, on disk ────────────────────────────────

    private async readState(): Promise<{ sessionId: string; threadId: string; turnId: string }[]> {
        try {
            const parsed: unknown = JSON.parse(await readFile(this.options.stateFile, "utf8"));
            const turns = isRecord(parsed) && Array.isArray(parsed.turns) ? parsed.turns : [];

            return turns.flatMap((entry: unknown) =>
                isRecord(entry) && typeof entry.sessionId === "string" && typeof entry.threadId === "string" && typeof entry.turnId === "string"
                    ? [{ sessionId: entry.sessionId, threadId: entry.threadId, turnId: entry.turnId }]
                    : [],
            );
        } catch {
            return [];
        }
    }

    private async writeState(): Promise<void> {
        const turns: { sessionId: string; threadId: string; turnId: string }[] = [];

        for (const channel of this.channels.values()) {
            if (channel.threadId !== undefined) {
                turns.push({ sessionId: channel.sessionId, threadId: channel.threadId, turnId: channel.turnId });
            }
        }

        try {
            await mkdir(path.dirname(this.options.stateFile), { recursive: true });
            await writeFile(`${this.options.stateFile}.tmp`, JSON.stringify({ turns }), { mode: 0o600 });
            await rename(`${this.options.stateFile}.tmp`, this.options.stateFile);
        } catch (error) {
            this.options.log?.(`[acp-host] could not record the running turns: ${(error as Error).message}`);
        }
    }

    /** Rewrites the file after the writes already queued, so an older state never lands over a newer one. */
    private persist(): void {
        this.writing = this.writeAfter(this.writing);
    }

    private async writeAfter(previous: Promise<void>): Promise<void> {
        await previous;
        await this.writeState();
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    private random(): number {
        return (this.options.random ?? Math.random)();
    }
}
