/**
 * Posts a coding agent's turn output to the backend (acp-agent-host.md §4.2–4.5), straight from the main
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
 * - **Backoff, jittered and capped**, for anything that is not an answer: a network error, a 5xx, a 429, a 409 that
 * names no `next` (the session's previous turn is still ending), a redirect (never followed: the signed body is
 * not sent to wherever it points). The batch is kept; the queue behind it is bounded.
 * - **A 401 is retried for a while, then it ends the posting.** The backend answers 401 alike for a skewed clock
 * and for a device that was removed, so one blip must not drop a turn; but a streak of them that has lasted a
 * minute is a revoked computer, and posting for ever would only keep its turns in memory and in the running-turns
 * file. The streak ends with any other answer, and with a gap of a minute between two 401s.
 * - **A keepalive** (a post with no events) while a turn runs, so a long tool call is not mistaken for a dead host.
 * - **A turn cut off by a restart** is recorded on disk while it runs. On the next start each such turn is ended
 * with the reason `interrupted`, at the `seq` the backend says is next.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ChildEvent } from "./children";
import type { AgentUsage, HostEvent, HostSessionInfo, PermissionOutcomeKind, PermissionRequestEvent, PostResult, SessionObserver, SessionStatePatch, ToolReport, TurnSummary } from "./host-events";
import { capExit, capPermissionRequest, capPrompt, capRequestId, capSessionInfo, childHostEvents, endReasonOf } from "./host-events";
import type { ImportIo } from "./import-post";
import type { MediaOptions } from "./media";
import { collectMedia, imageReferences } from "./media";
import type { PlanEntry } from "./plan";
import { SessionLink } from "./session-link";
import { MAX_TOOL_OUTPUT_CHARS } from "./tool-output";
import type { ChannelHost } from "./turn-channel";
import { TurnChannel } from "./turn-channel";
import type { StopReason } from "./types";

export type { HostEvent, HostSessionInfo, PermissionOutcomeKind, PermissionRequestEvent, SessionObserver } from "./host-events";
export { KEEPALIVE_MS, POST_INTERVAL_MS } from "./turn-channel";

const REQUEST_TIMEOUT_MS = 20_000;
/** The most of a turn's text kept for its references; a reply is capped at the same length on the backend. */
const MAX_TURN_TEXT_CHARS = 256_000;
const REFUSED_STATUSES = new Set([400, 403, 413]);

/** Agent state is coalesced to one post per session per this many ms; a failed post waits this long before its retry. */
const STATE_DEBOUNCE_MS = 2000;
const STATE_RETRY_MS = 30_000;

/** A report is posted this many times at most while nothing newer replaces it; then it is dropped (the agent's next report carries the value again). */
export const MAX_STATE_ATTEMPTS = 10;

/**
 * A report waiting to be posted. `at` is when the agent's value was observed, not when it is sent: a value sent again
 * after a newer one was posted carries its old `at`, and the backend drops it.
 */
interface PendingState extends SessionStatePatch {
    at: number;
}

/**
 * The report to keep after a send failed: a field observed later wins, whichever send it went out with. Two sends can be in
 * flight at once, so the one that failed may be the older value; it must not replace the newer one.
 */
export const newerPending = (failed: PendingState, waiting: PendingState | undefined): PendingState => {
    if (waiting === undefined) {
        return failed;
    }

    const [older, newer] = waiting.at < failed.at ? [waiting, failed] : [failed, waiting];
    const usage = mergeUsage(older.usage, newer.usage);

    return { ...older, ...newer, ...usage !== undefined && { usage }, at: newer.at };
};

/** A usage report's counts are the newer ones; the cost is the newer one when it has one, otherwise the older one (a running total). */
const mergeUsage = (older: AgentUsage | undefined, newer: AgentUsage | undefined): AgentUsage | undefined => {
    if (newer === undefined) {
        return older;
    }

    const cost = newer.cost ?? older?.cost;

    return { size: newer.size, used: newer.used, ...cost !== undefined && { cost } };
};
/** A run of 401s this long and this many is a device the backend no longer knows, not a clock blip. */
const REVOKED_AFTER_MS = 60_000;
const REVOKED_AFTER_ATTEMPTS = 5;

export interface PosterOptions {
    /** Stops a turn the backend ended while this computer's agent was still on it (`AcpManager.cancelTurn`). */
    cancelTurn?: (sessionId: string, turnId: string) => void;
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

/** A turn recorded on disk while it runs. */
export interface RunningTurn {
    sessionId: string;
    threadId: string;
    turnId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A call id the backend accepts (at most 128 bytes). A longer id is cut and followed by a hash of the whole, so two ids that share a
 * prefix stay two calls. The cut is at 24 characters, so the result stays under the byte limit for any characters.
 */
const boundedCallId = (id: string): string => {
    if (Buffer.byteLength(id) <= 128) {
        return id;
    }

    return `${id.slice(0, 24)}#${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
};

export class HostPoster implements SessionObserver {
    private readonly channelHost: ChannelHost;

    private readonly channels = new Map<string, TurnChannel>();

    /** Sessions that ended locally and wait for their turns to drain before the backend is told. */
    private readonly closing = new Set<string>();

    /** What each session shows the backend, to name its agent and folder when a reply's files are read. */
    private readonly infos = new Map<string, HostSessionInfo>();

    private readonly sessions = new Map<string, SessionLink>();

    /** The agent's own reports not yet posted, by session: the newest value of each field (`sessionState`). */
    private readonly pendingState = new Map<string, PendingState>();

    /** The last observation time handed out. A later report never gets an earlier one, even if the desktop clock went back. */
    private lastObservedAt = 0;

    private stateTimer: ReturnType<typeof setTimeout> | undefined;

    /** When the pending timer fires: a sooner report moves it earlier, a later one leaves it. */
    private stateDueAt: number | undefined;

    /** Sessions whose state post is on its way: at most one per session, so a session's reports stay in order. */
    private readonly stateInFlight = new Set<string>();

    /** When a session's failed report may be retried: its own backoff, unaffected by other sessions' reports. */
    private readonly stateRetryAt = new Map<string, number>();

    /** Failed posts of a session's current report, reset by a fresh report or a success (`MAX_STATE_ATTEMPTS`). */
    private readonly stateAttempts = new Map<string, number>();

    /** When a session last posted its report: its next one waits out `STATE_DEBOUNCE_MS` from it, whichever pass runs. */
    private readonly stateSentAt = new Map<string, number>();

    /** What each running turn's calls last posted as their output (`tool_output`), by turn and call id. */
    private readonly postedOutput = new Map<string, string>();

    /** The text of each running turn, kept for the references its reply makes (capped). */
    private readonly texts = new Map<string, string>();

    private stopped = false;

    /** The run of consecutive 401s, if any: its length, when it began and when the latest came. */
    private unauthorized: { count: number; last: number; reported: boolean; since: number } | undefined;

    /** What the last run left running, until `recover` has ended it. */
    private unrecovered: RunningTurn[] = [];

    /** Serialises writes of the state file; a write never overtakes the one before it. */
    private writing: Promise<void> = Promise.resolve();

    public constructor(private readonly options: PosterOptions) {
        this.channelHost = {
            endedByBackend: (channel) => this.options.cancelTurn?.(channel.sessionId, channel.turnId),
            finished: (channel) => {
                this.channels.delete(channel.turnId);
                this.texts.delete(channel.turnId);

                for (const key of this.postedOutput.keys()) {
                    if (key.startsWith(`${channel.turnId}\u{0}`)) {
                        this.postedOutput.delete(key);
                    }
                }

                this.persist();
                this.closeWhenDrained(channel.sessionId);
            },
            log: (message) => this.options.log?.(message),
            now: () => this.now(),
            random: () => this.random(),
            send: async (channel, firstSeq, events) => await this.sendTurn(channel, firstSeq, events),
            threadOf: (sessionId) => this.sessions.get(sessionId)?.threadId,
        };
    }

    // ─── From the sessions ──────────────────────────────────────────────────

    public sessionOpened(sessionId: string, info: HostSessionInfo, threadId?: string): void {
        this.infos.set(sessionId, info);

        const link = new SessionLink(sessionId, capSessionInfo(info), {
            bound: (id, thread) => this.bindThread(id, thread),
            deviceId: () => this.options.deviceId(),
            now: () => this.now(),
            random: () => this.random(),
            released: (id) => this.releaseChannels(id),
            request: async (payload) => await this.request(payload),
        });

        this.sessions.set(sessionId, link);

        if (this.pendingState.has(sessionId)) {
            this.scheduleState(STATE_DEBOUNCE_MS);
        }

        if (this.options.deviceId() === undefined) {
            // Not paired: the session stays on this computer.
            link.threadId = null;

            return;
        }

        // A session the backend started already has its thread; the open still goes out, to turn it from starting to idle.
        link.threadId = threadId;
        link.open();
    }

    /**
     * What the agent reported about itself. The newest value of each field is kept until the next post, so a burst of
     * usage updates (one per model step) costs one post, not one each.
     */
    public sessionState(sessionId: string, patch: SessionStatePatch): void {
        const pending = this.pendingState.get(sessionId);
        // A usage report inside the same window that leaves the cost out keeps the cost before it: the agent's cost is cumulative.
        const usage = patch.usage === undefined ? pending?.usage : { ...pending?.usage, ...patch.usage };

        // Never earlier than the last one: the backend drops a report older than the stored one, and keeps an equal one.
        const at = Math.max(this.now(), this.lastObservedAt);

        this.lastObservedAt = at;
        this.pendingState.set(sessionId, { ...pending, ...patch, ...usage !== undefined && { usage }, at });
        // A fresh report is the newest value, so it does not wait out its own session's backoff: the next flush sends it.
        this.stateRetryAt.delete(sessionId);
        this.stateAttempts.delete(sessionId);
        this.scheduleState(STATE_DEBOUNCE_MS);
    }

    /** This computer was paired: the sessions that stayed local while it was not now open on the backend. */
    public paired(): void {
        for (const link of this.sessions.values()) {
            link.paired();
        }

        // Reports held for sessions that were opened while unpaired go out once their threads are bound.
        if (this.pendingState.size > 0) {
            this.scheduleState(STATE_DEBOUNCE_MS);
        }
    }

    public sessionEnded(sessionId: string): void {
        this.sessions.get(sessionId)?.close();
        this.closing.add(sessionId);
        this.closeWhenDrained(sessionId);
    }

    public turnReceived(sessionId: string, turnId: string, user: string): void {
        this.turnStarted(sessionId, turnId, user);
    }

    /**
     * A message for a session that is not open yet (`early-sends.ts`): the thread comes with the command, so the turn
     * is posted now. It reaches the backend as `received` and keeps its reaper window moving while it waits.
     */
    public turnHeld(sessionId: string, turnId: string, user: string, threadId: string): void {
        if (this.stopped || this.options.deviceId() === undefined || this.channels.has(turnId)) {
            return;
        }

        const channel = new TurnChannel(this.channelHost, sessionId, turnId, threadId, false);

        this.channels.set(turnId, channel);
        channel.enqueue({ kind: "turn_start", text: capPrompt(user) });
        this.persist();
    }

    /** Ends a turn whose message was held while the app went down: a stream waiting for it ends with the reason instead of reaping as silent. */
    public endLapsedTurn(sessionId: string, turnId: string, threadId: string, end: { error?: string; reason: "failed" | "interrupted" }): void {
        if (this.stopped || this.channels.has(turnId)) {
            return;
        }

        const channel = new TurnChannel(this.channelHost, sessionId, turnId, threadId, true);

        this.channels.set(turnId, channel);
        channel.end(end.reason, end.error);
    }

    /** The first call for a turn opens its channel with the user's prompt; a later one (the turn it was queued for now running) finds it open. */
    public turnStarted(sessionId: string, turnId: string, user: string): void {
        const link = this.sessions.get(sessionId);

        if (link === undefined || link.threadId === null || this.stopped || this.channels.has(turnId)) {
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

    /**
     * A call's state, and, in a `tool_output` event of its own, what it printed and how its terminal ended, posted only
     * when that changed: a status update does not resend the output, and the `tool` event keeps its stored shape.
     */
    public tool(_sessionId: string, turnId: string, tool: ToolReport): void {
        const channel = this.channels.get(turnId);

        if (channel === undefined) {
            return;
        }

        const id = boundedCallId(tool.id);

        channel.enqueue({ id, kind: "tool", status: tool.status, title: tool.title.slice(0, 500), toolKind: tool.kind.slice(0, 64) });

        if (tool.output === undefined && tool.exit === undefined) {
            return;
        }

        const printed = {
            id,
            kind: "tool_output" as const,
            output: (tool.output ?? "").slice(-MAX_TOOL_OUTPUT_CHARS),
            ...tool.exit !== undefined && { exit: capExit(tool.exit) },
        };
        const key = `${turnId}\u{0}${id}`;
        const signature = JSON.stringify(printed);

        // An empty output with nothing posted before it and no exit has nothing to clear.
        if (printed.output === "" && !this.postedOutput.has(key) && tool.exit === undefined) {
            return;
        }

        // Recorded only once the channel takes it: a dropped output (its queue over the cap) is sent again by the next report.
        if (this.postedOutput.get(key) !== signature && channel.enqueue(printed)) {
            this.postedOutput.set(key, signature);
        }
    }

    public child(_sessionId: string, turnId: string, spawnId: string, event: ChildEvent): void {
        for (const posted of childHostEvents(spawnId, event)) {
            this.channels.get(turnId)?.enqueue(posted);
        }
    }

    public plan(_sessionId: string, turnId: string, entries: PlanEntry[]): void {
        this.channels.get(turnId)?.enqueue({ entries, kind: "plan" });
    }

    public permissionRequested(_sessionId: string, turnId: string, request: PermissionRequestEvent): void {
        this.channels.get(turnId)?.enqueue(capPermissionRequest(request));
    }

    public permissionResolved(_sessionId: string, turnId: string, requestId: string, outcome: PermissionOutcomeKind): void {
        this.channels.get(turnId)?.enqueue({ kind: "permission_resolved", outcome, requestId: capRequestId(requestId) });
    }

    public turnEnded(sessionId: string, turnId: string, reason: StopReason | "failed", error?: string, summary?: TurnSummary): void {
        const channel = this.channels.get(turnId);

        if (channel === undefined) {
            return;
        }

        const text = this.texts.get(turnId) ?? "";
        const info = this.infos.get(sessionId);

        this.texts.delete(turnId);

        // A turn that failed leaves no reply to show files in; one without an image reference has nothing to read.
        if (info === undefined || this.stopped || this.options.media === undefined || endReasonOf(reason) === "failed" || imageReferences(text).length === 0) {
            channel.end(endReasonOf(reason), error, summary);

            return;
        }

        // Never rejects: every failure inside is caught, and the turn ends whatever happens.
        // eslint-disable-next-line unicorn/prefer-await -- turnEnded is synchronous, and the call has no rejection to await
        this.attachMediaThenEnd(channel, info, text, endReasonOf(reason), error, summary).catch(() => {});
    }

    /** What an import needs to post: the same signing, endpoint and clock the turns use. */
    public importIo(): ImportIo {
        return {
            deviceId: () => this.options.deviceId(),
            now: () => this.now(),
            random: () => this.random(),
            request: async (payload) => await this.request(payload),
        };
    }

    // ─── Start and stop ─────────────────────────────────────────────────────

    /**
     * The turns a previous run left running, read from disk. Read BEFORE anything that opens a channel (the replay of held
     * messages does): the file is rewritten by the first one. Until `recover` has ended them they are kept in the file.
     */
    public async readLeftovers(): Promise<RunningTurn[]> {
        const read = this.readState();

        // A write queued from here on lands after the read, so it cannot drop the turns the read is about to find.
        this.writing = settledAfter(this.writing, read);

        this.unrecovered = await read;

        return this.unrecovered;
    }

    /**
     * Ends, as `interrupted`, every turn a previous run left behind, except the ones that have a channel since (a held
     * message the replay took up again). Call once after the core is up, with what `readLeftovers` returned.
     */
    public async recover(leftovers?: RunningTurn[]): Promise<void> {
        const left = leftovers ?? await this.readLeftovers();

        for (const turn of left) {
            if (this.channels.has(turn.turnId)) {
                continue;
            }

            const channel = new TurnChannel(this.channelHost, turn.sessionId, turn.turnId, turn.threadId, true);

            this.channels.set(turn.turnId, channel);
            channel.end("interrupted");
        }

        this.unrecovered = [];
    }

    /** Stops every timer. Output not yet sent is lost, as the process is going away; the next start ends those turns as interrupted. */
    public stop(): void {
        clearTimeout(this.stateTimer);
        this.stateTimer = undefined;
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

    /**
     * Reads and uploads the files the reply refers to, queues their events and only then the end of the turn: the
     * channel takes nothing after it. The turn stays open meanwhile (its keepalive keeps the backend's reaper off).
     * Whatever goes wrong, the turn still ends.
     */
    private async attachMediaThenEnd(
        channel: TurnChannel,
        info: HostSessionInfo,
        text: string,
        reason: "cancelled" | "failed" | "finished",
        error?: string,
        summary?: TurnSummary,
    ): Promise<void> {
        const { media } = this.options;

        try {
            if (media !== undefined) {
                const events = await collectMedia(
                    {
                        ...media,
                        deviceId: this.options.deviceId,
                        ...this.options.fetch && { fetch: this.options.fetch },
                        ...this.options.log && { log: this.options.log },
                        now: () => this.now(),
                    },
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
            channel.end(reason, error, summary);
        }
    }

    /** A session that will not be posted: the turns still waiting on its thread end instead of holding output for ever. */
    private releaseChannels(sessionId: string): void {
        for (const channel of this.channels.values()) {
            if (channel.sessionId === sessionId && channel.threadId === undefined) {
                channel.release();
            }
        }
    }

    /**
     * Tells the backend a local session is over, once its last turn has been delivered: the backend refuses turn
     * posts into an ended session, so closing first would lose the final reply.
     */
    private closeWhenDrained(sessionId: string): void {
        if (!this.closing.has(sessionId) || this.stopped) {
            return;
        }

        for (const channel of this.channels.values()) {
            if (channel.sessionId === sessionId) {
                return;
            }
        }

        this.closing.delete(sessionId);

        // A session that never reached the backend has nothing to deliver its last report to. Checked here, once the close has
        // drained: a session whose open was still in flight only turns unbound into local when its link closes.
        if (this.sessions.get(sessionId)?.threadId === null) {
            this.pendingState.delete(sessionId);
        }

        this.sessions.get(sessionId)?.announceClose();
    }

    private bindThread(sessionId: string, threadId: string): void {
        for (const channel of this.channels.values()) {
            if (channel.sessionId === sessionId) {
                channel.bindThread(threadId);
            }
        }

        // A state report that waited for the thread goes out now.
        if (this.pendingState.has(sessionId)) {
            this.scheduleState(STATE_DEBOUNCE_MS);
        }

        this.persist();
    }

    /**
     * One timer for both delays: a sooner report moves it earlier, so a retry's long backoff never holds back a fresh
     * report, and a later one never pushes a pending flush out. Nothing is scheduled once the poster is stopped.
     */
    private scheduleState(ms: number): void {
        const dueAt = this.now() + ms;

        if (this.stopped || (this.stateTimer !== undefined && this.stateDueAt !== undefined && this.stateDueAt <= dueAt)) {
            return;
        }

        clearTimeout(this.stateTimer);
        this.stateDueAt = dueAt;
        this.stateTimer = setTimeout(async () => {
            this.stateTimer = undefined;
            this.stateDueAt = undefined;
            await this.runStateFlush();
        }, ms);
    }

    /**
     * Runs one pass when the timer comes due. There is no pass lock: each session's post is guarded by `stateInFlight`, so one
     * session's stalled request never holds back another session's report.
     */
    private async runStateFlush(): Promise<void> {
        await this.flushState();
    }

    /**
     * One signed `session_state` post per session with a pending report. The payload is built here, at send time, so a
     * retry carries a fresh `issuedAt` (an old one fails the backend's freshness check after an outage). A session with
     * no thread yet keeps its report; a local-only session drops it.
     */
    private async flushState(): Promise<void> {
        if (this.stopped) {
            return;
        }

        const deviceId = this.options.deviceId();
        // A snapshot: a send below writes its entry back, and this pass must not reach that entry again.
        const snapshot = new Map(this.pendingState);
        const sends: Promise<void>[] = [];
        let nextDueAt: number | undefined;

        for (const sessionId of snapshot.keys()) {
            const pending = this.pendingState.get(sessionId);

            if (pending === undefined || this.stopped || this.stateInFlight.has(sessionId)) {
                continue;
            }

            const link = this.sessions.get(sessionId);

            // Not posted now: a session not yet bound to its thread, or one held while unpaired. The report waits, and pairing
            // or the thread's binding flushes it.
            if (deviceId === undefined || link?.threadId === undefined || link.threadId === null) {
                continue;
            }

            // A session whose report failed waits out its own backoff, even when another session's report wakes this pass.
            const retryAt = this.stateRetryAt.get(sessionId);

            if (retryAt !== undefined && retryAt > this.now()) {
                nextDueAt = Math.min(nextDueAt ?? retryAt, retryAt);

                continue;
            }

            // Two seconds between one session's posts, whichever pass runs: a pass another session's timer brings sooner waits for it.
            // The window counts forward only, so a clock that moved back does not hold the report until it catches up.
            const sentAt = this.stateSentAt.get(sessionId);
            const eligibleAt = (sentAt ?? 0) + STATE_DEBOUNCE_MS;

            if (sentAt !== undefined && sentAt <= this.now() && eligibleAt > this.now()) {
                nextDueAt = Math.min(nextDueAt ?? eligibleAt, eligibleAt);

                continue;
            }

            this.pendingState.delete(sessionId);
            // Sessions are independent: one slow post does not hold up another session's report. Each is signed when it is sent.
            sends.push(this.sendState(sessionId, pending, deviceId));
        }

        if (nextDueAt !== undefined) {
            this.scheduleState(nextDueAt - this.now());
        }

        await Promise.all(sends);
    }

    /** Posts one session's report. A failed post keeps what is newer than this send, and waits out its own backoff. */
    private async sendState(sessionId: string, pending: PendingState, deviceId: string): Promise<void> {
        this.stateInFlight.add(sessionId);
        this.stateSentAt.set(sessionId, this.now());

        try {
            const now = this.now();
            const { at, ...fields } = pending;
            const payload = JSON.stringify({ deviceId, events: [{ ...fields, at, kind: "session_state" }], issuedAt: now, kind: "turn", sessionId, v: 1 });
            let result: PostResult;

            try {
                result = await this.request(payload);
            } catch {
                result = { kind: "retry" };
            }

            if (result.kind === "retry") {
                const waiting = this.pendingState.get(sessionId);
                const attempts = (this.stateAttempts.get(sessionId) ?? 0) + 1;

                if (waiting === undefined && attempts >= MAX_STATE_ATTEMPTS) {
                    // Nothing newer replaces it, and it has failed this many times: dropped, not written back.
                    this.pendingState.delete(sessionId);
                    this.stateAttempts.delete(sessionId);
                    this.stateRetryAt.delete(sessionId);
                } else {
                    this.pendingState.set(sessionId, newerPending(pending, waiting));
                    this.stateAttempts.set(sessionId, attempts);

                    // A fresh report that arrived meanwhile is not held behind this failure: the finally block sends it at its
                    // debounce. Only a failed report with nothing newer waiting backs off.
                    if (waiting === undefined) {
                        this.stateRetryAt.set(sessionId, this.now() + STATE_RETRY_MS);
                        this.scheduleState(STATE_RETRY_MS);
                    }
                }
            } else {
                this.stateRetryAt.delete(sessionId);
                this.stateAttempts.delete(sessionId);
            }
        } finally {
            this.stateInFlight.delete(sessionId);

            // A report that arrived while this post was on its way is sent by the next flush of this session, unless it is backing off.
            if (this.pendingState.has(sessionId) && !this.stateRetryAt.has(sessionId)) {
                this.scheduleState(STATE_DEBOUNCE_MS);
            }
        }
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
            // The signed body goes to the configured endpoint only: a redirect would resend it elsewhere.
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        let body: unknown = null;

        try {
            body = await response.json();
        } catch {
            // Not JSON (a proxy's error page): the status below decides.
        }

        if (response.status === 401) {
            return this.unauthorizedResult();
        }

        this.unauthorized = undefined;

        const fields = isRecord(body) ? body : {};

        if (response.status === 409 && typeof fields.next === "number") {
            return { kind: "gap", next: fields.next };
        }

        if (response.ok && typeof fields.next === "number") {
            return {
                ended: fields.ended === true,
                kind: "ok",
                next: fields.next,
                ...typeof fields.existing === "boolean" && { existing: fields.existing },
                ...typeof fields.threadId === "string" && { threadId: fields.threadId },
            };
        }

        // 403, 400 and 413 are the backend saying it will never take this post (not our turn, a field past its limits,
        // a body past its cap); sending the same batch again would loop for ever. Every other failure is worth another try.
        return REFUSED_STATUSES.has(response.status) ? { kind: "refused" } : { kind: "retry" };
    }

    /** A 401: another try, until the streak is long enough to be a device the backend removed. */
    private unauthorizedResult(): PostResult {
        const now = this.now();
        // Retries come at most ~50 s apart (a request timeout plus the longest backoff), so a longer gap (the computer
        // slept, the network was down, a close gave up) ends the streak: only 401s that keep arriving count.
        const streak
            = this.unauthorized === undefined || now - this.unauthorized.last > REVOKED_AFTER_MS
                ? { count: 1, last: now, reported: false, since: now }
                : { ...this.unauthorized, count: this.unauthorized.count + 1, last: now };

        this.unauthorized = streak;

        if (streak.count < REVOKED_AFTER_ATTEMPTS || now - streak.since < REVOKED_AFTER_MS) {
            return { kind: "retry" };
        }

        if (!streak.reported) {
            streak.reported = true;
            this.options.log?.(
                "[acp-host] the backend no longer accepts this computer (it was removed, or its clock is far off); agent output is no longer posted",
            );
        }

        return { kind: "refused" };
    }

    // ─── The turns that are running, on disk ────────────────────────────────

    private async readState(): Promise<RunningTurn[]> {
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
        const turns: RunningTurn[] = [];

        for (const channel of this.channels.values()) {
            if (channel.threadId !== undefined) {
                turns.push({ sessionId: channel.sessionId, threadId: channel.threadId, turnId: channel.turnId });
            }
        }

        // A turn the last run left is still to be ended: a crash before then must not lose it.
        for (const left of this.unrecovered) {
            if (!this.channels.has(left.turnId)) {
                turns.push(left);
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
