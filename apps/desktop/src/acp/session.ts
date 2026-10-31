/**
 * One agent process, one ACP session, and the turns in it.
 *
 * A turn is a `session/prompt` request. **Its response is the only end of a turn.** Updates (text, tool
 * calls) are applied to whichever turn they belong to and never change whether the session is busy, so a
 * status that looks final cannot start the next prompt early, and a late update after the response cannot
 * flip an idle session back to busy.
 *
 * A prompt sent while a turn runs is queued (bounded), never dropped and never sent in parallel. A cancel
 * drops the queue, tells the agent, ends every open tool call as cancelled on our side (ACP has no such
 * status) and, if the agent still has not answered after a grace period, ends the process.
 */
import { randomUUID } from "node:crypto";

import type { CapabilityReport } from "@neore/ai/capabilities";
import { capabilityOf, isAvailable } from "@neore/ai/capabilities";

import { reportFromHandshake } from "./capabilities";
import { TurnChanges } from "./changes";
import { childEventOf, childParentOf, completionText, contentText, isRecord, text, toolIdOf } from "./child-updates";
import type { ChildEvent } from "./children";
import { ChildLedger } from "./children";
import type { HostSessionInfo, SessionObserver } from "./ingest";
import { JsonRpcConnection } from "./jsonrpc";
import type { PermissionGate, PermissionOutcome } from "./permission";
import { describePermission, offeredOptions } from "./permission";
import type { AgentProcess } from "./process";
import type { Handshake } from "./protocol";
import { initialize, METHOD, newSession, promptParams } from "./protocol";
import { INVALID_PARAMS, METHOD_NOT_FOUND, RpcError } from "./rpc-error";
import { Turn } from "./turn";
import type { SessionSnapshot, SessionStatus, SessionSummary, StopReason, ToolState, ToolStatus } from "./types";

/** Prompts waiting behind a running turn. A full queue refuses the next one; it never drops one silently. */
const MAX_QUEUED_PROMPTS = 8;
const MAX_PROMPT_LENGTH = 100_000;
/** After a cancel, how long the agent has to answer its prompt before the process is ended. */
const DEFAULT_CANCEL_GRACE_MS = 5000;

/** After the agent's output closes, how long to wait for its exit status so the error can say why. */
const EXIT_WAIT_MS = 500;

/** A call this host ended itself; whatever the agent sends later does not change it. */
const isFinal = (tool: ToolState): boolean => tool.status === "cancelled" || tool.status === "declined";

const TOOL_STATUSES = new Set<ToolStatus>(["completed", "failed", "in_progress", "pending"]);
const STOP_REASONS = new Set<StopReason>(["cancelled", "end_turn", "max_tokens", "max_turn_requests", "refusal"]);

/** How the backend is told a request ended: an allow option, a reject option, or neither. */
const resolutionOf = (params: Record<string, unknown>, outcome: PermissionOutcome): "allowed" | "cancelled" | "declined" => {
    if (outcome.outcome === "cancelled") {
        return "cancelled";
    }

    const option = offeredOptions(params).find((candidate) => candidate.optionId === outcome.optionId);

    return option?.kind.startsWith("allow") === true ? "allowed" : "declined";
};

export type SendResult = { position: number; status: "queued" } | { status: "started" };

/** A prompt waiting behind a running turn. `turnId` is set when the backend queued it (`acp_send`). */
interface QueuedPrompt {
    prompt: string;
    turnId?: string;
}

export interface SessionOptions {
    agentKey: string;
    agentLabel: string;
    appVersion: string;
    cancelGraceMs?: number;
    /** Says what this agent reports it can do. Defaults to the handshake's own (`capabilities.ts`); tests stand in for an agent that reports more. */
    capabilityReport?: (handshake: Handshake) => CapabilityReport;
    folder: string;
    gate: PermissionGate;
    /** What the backend shows for this session (labels only). With `observer`, opening the session makes its thread. */
    hostInfo?: HostSessionInfo;
    /** Where the session says what it measured (child buffering). */
    log?: (message: string) => void;
    /** Told what the session and its turns do, so they can be saved on the backend (`ingest.ts`). */
    observer?: SessionObserver;
    /** Called when anything the window shows changed. Coalescing is the caller's. */
    onChange: () => void;
    process: AgentProcess;
    /** The id this session goes by on the backend, when the backend started it (`acp_start`); otherwise one is minted. */
    sessionId?: string;
    startupTimeoutMs?: number;
    /** The thread the backend made for a session it started. */
    threadId?: string;
}

export class AgentSession {
    private readonly sessionId: string;

    private agentSessionId = "";

    private readonly connection: JsonRpcConnection;

    private cancelTimer: ReturnType<typeof setTimeout> | undefined;

    private cancelRequested = false;

    private current: Turn | undefined;

    private endReason: string | undefined;

    private status: SessionStatus = "starting";

    /** The process stop that `end` started; `close` and a failed start wait for it. */
    private stopping: Promise<void> = Promise.resolve();

    private readonly queue: QueuedPrompt[] = [];

    /** What each turn's tool calls wrote (`changes.ts`); kept only for a session whose turns are saved. */
    private readonly changes = new WeakMap<Turn, TurnChanges>();

    /** How much of each turn's text has been handed to the observer, in characters of the scrubbed text. */
    private readonly sent = new WeakMap<Turn, { text: number; thought: number }>();

    /** Requests the host was told about and has not yet heard the end of, by id. */
    private readonly pendingPermissions = new Map<string, Turn>();

    private readonly toolOwner = new Map<string, Turn>();

    private readonly tools = new Map<string, ToolState>();

    private readonly turns: Turn[] = [];

    private agent: Handshake | undefined;

    /** What the agent reported at the handshake. Unset until it has. */
    private report: CapabilityReport | undefined;

    /** The agent's own children, by the tool call that spawned each (§4.7). */
    private readonly children: ChildLedger;

    public constructor(private readonly options: SessionOptions) {
        this.sessionId = options.sessionId ?? randomUUID();
        this.children = new ChildLedger({
            emit: (spawnId, event) => this.emitChild(spawnId, event),
            log: options.log,
            scrub: options.process.scrub,
            secretLength: options.process.secretLength,
        });
        this.connection = new JsonRpcConnection(options.process.stdout, options.process.stdin, {
            notification: (method, params) => this.onNotification(method, params),
            request: (method, params) => this.onRequest(method, params),
        });
        this.watchExit();
    }

    public get id(): string {
        return this.sessionId;
    }

    /** What the agent reported at the handshake; unset until it has. */
    public get handshake(): Handshake | undefined {
        return this.agent;
    }

    /** Handshakes and opens the session; ends the process when either fails. */
    public async start(): Promise<void> {
        try {
            this.agent = await initialize(this.connection, this.options.appVersion, this.options.startupTimeoutMs);
            this.report = this.options.capabilityReport?.(this.agent) ?? reportFromHandshake(this.agent.capabilities, Date.now());
            this.agentSessionId = await newSession(this.connection, this.options.folder, this.options.startupTimeoutMs);

            // The agent can exit while the last answer is on its way; that session is over, not ready.
            if (this.status === "ended") {
                throw new Error(this.endReason ?? "the agent ended during startup");
            }
        } catch (error) {
            await this.exitStatus();

            const stderr = this.options.process.stderrTail().trim();
            // An agent that exited has already said why (`end` ran from its exit); do not say it twice.
            const message = this.endReason ?? `${(error as Error).message}${stderr === "" ? "" : `: ${stderr}`}`;

            this.end(message);
            await this.stopping;

            // eslint-disable-next-line preserve-caught-error -- the cause is the agent's own error, which can quote its environment
            throw new Error(this.endReason ?? message);
        }

        this.status = "idle";
        this.options.onChange();

        const { hostInfo } = this.options;

        if (hostInfo !== undefined) {
            // What the agent advertised and its own id for the session ride along: the backend keeps both on the session row.
            const opened = {
                ...hostInfo,
                nativeSessionId: this.agentSessionId,
                ...this.report !== undefined && { capabilities: this.report },
            };

            this.observe((observer) => observer.sessionOpened(this.id, opened, this.options.threadId));
        }
    }

    /** `turnId` is the id the backend gave the turn (`acp_send`): the turn keeps it, and the backend hears it was received. */
    public send(prompt: string, turnId?: string): SendResult {
        if (this.status === "ended") {
            throw new Error("this session has ended");
        }

        if (this.status === "starting") {
            throw new Error("this session is still starting");
        }

        if (prompt.trim() === "" || prompt.length > MAX_PROMPT_LENGTH) {
            throw new Error("a prompt is 1 to 100000 characters");
        }

        if (this.status === "busy" && this.queue.length >= MAX_QUEUED_PROMPTS) {
            throw new Error(`${String(MAX_QUEUED_PROMPTS)} prompts are already waiting; wait for the agent or stop it`);
        }

        if (turnId !== undefined) {
            this.observe((observer) => observer.turnReceived?.(this.id, turnId, prompt));
        }

        if (this.status === "busy") {
            this.queue.push({ prompt, turnId });
            this.options.onChange();

            return { position: this.queue.length, status: "queued" };
        }

        this.run(prompt, turnId);

        return { status: "started" };
    }

    /** Stops the turn with this id if it is the one running: a stop the backend asked for names the turn it means. */
    public cancelTurn(turnId: string): boolean {
        if (this.current?.id === turnId) {
            // The backend names one turn. What waits behind it was sent after it and has its own id and stream, so it stays queued.
            this.cancel({ keepQueue: true });

            return true;
        }

        // A turn still waiting behind the running one is withdrawn, and its stream told it ended.
        const waiting = this.queue.findIndex((entry) => entry.turnId === turnId);

        if (waiting === -1) {
            return false;
        }

        this.queue.splice(waiting, 1);
        this.observe((observer) => observer.turnEnded(this.id, turnId, "cancelled"));
        this.options.onChange();

        return true;
    }

    /** Stops the running turn. Prompts still waiting are dropped, so a stop releases nothing later. */
    public cancel(options: { keepQueue?: boolean } = {}): void {
        if (this.status !== "busy" || this.current === undefined) {
            this.dropQueue();
            this.options.onChange();

            return;
        }

        if (options.keepQueue !== true) {
            this.dropQueue();
        }

        this.cancelRequested = true;
        this.connection.notify(METHOD.cancel, { sessionId: this.agentSessionId });
        // The spec requires pending permission requests to be answered `cancelled`.
        this.options.gate.cancelSession(this.id);

        for (const tool of this.tools.values()) {
            if (!(tool.status === "pending" || tool.status === "in_progress")) {
                continue;
            }

            tool.status = "cancelled";
            this.observeTool(tool);
        }

        this.children.endAll("cancelled");

        this.cancelTimer ??= setTimeout(() => {
            if (this.status !== "busy") {
                return;
            }

            this.end("the agent did not stop after you cancelled, so it was ended");
        }, this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
        this.options.onChange();
    }

    /** Ends the session and its process. */
    public async close(): Promise<void> {
        this.end("closed");
        await this.stopping;
    }

    public summary(): SessionSummary {
        return {
            agentKey: this.options.agentKey,
            agentLabel: this.options.agentLabel,
            endReason: this.endReason,
            folder: this.options.folder,
            id: this.sessionId,
            queued: this.queue.length,
            status: this.status,
        };
    }

    public snapshot(): SessionSnapshot {
        return {
            agentKey: this.options.agentKey,
            agentLabel: this.options.agentLabel,
            endReason: this.endReason,
            folder: this.options.folder,
            id: this.sessionId,
            queued: this.queue.map((entry) => entry.prompt),
            status: this.status,
            turns: this.turns.map((turn) => turn.toState()),
        };
    }

    /** Drops the prompts still waiting. The ones the backend queued are told their turn was cancelled, so no stream waits on them. */
    private dropQueue(reason: StopReason | "failed" = "cancelled", error?: string): void {
        const dropped = [...this.queue];

        this.queue.length = 0;

        for (const entry of dropped) {
            if (entry.turnId === undefined) {
                continue;
            }

            const { turnId } = entry;

            this.observe((observer) => observer.turnEnded(this.id, turnId, reason, error));
        }
    }

    private run(prompt: string, turnId?: string): void {
        const turn = new Turn(prompt, this.options.process.scrub, turnId);

        if (this.options.observer !== undefined) {
            this.changes.set(turn, new TurnChanges(this.options.folder, this.options.process.scrub));
        }

        this.turns.push(turn);
        this.current = turn;
        this.status = "busy";
        this.cancelRequested = false;
        this.observe((observer) => observer.turnStarted(this.id, turn.id, this.options.process.scrub(prompt)));
        this.options.onChange();
        this.prompt(turn);
    }

    /** `session/prompt`: its response is the end of the turn. */
    private async prompt(turn: Turn): Promise<void> {
        try {
            const response = await this.connection.request(METHOD.prompt, promptParams(this.agentSessionId, turn.user));
            const reason = isRecord(response) ? response.stopReason : undefined;

            this.finishTurn(turn, STOP_REASONS.has(reason as StopReason) ? (reason as StopReason) : "end_turn");
        } catch (error) {
            // An ended session has already said why. Otherwise the output closed or the agent answered with an
            // error: this turn failed, and the session with it. Wait for the exit, which knows the reason.
            if (this.status !== "ended") {
                turn.end("failed");
                this.current = undefined;
                this.observeEnd(turn, this.options.process.scrub((error as Error).message));
                await this.exitStatus();
                this.end((error as Error).message);
            }
        }
    }

    private async stopProcess(): Promise<void> {
        try {
            await this.options.process.stop();
        } catch {
            // A group that cannot be signalled is not this session's to fix; it is already over.
        }
    }

    /** Resolves when the process exits, or shortly after the call if it has not. */
    private async exitStatus(): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;

        await Promise.race([
            this.options.process.exited,
            new Promise((resolve) => {
                timer = setTimeout(resolve, EXIT_WAIT_MS);
            }),
        ]);
        clearTimeout(timer);
    }

    private finishTurn(turn: Turn, reason: StopReason): void {
        if (turn.stopReason !== undefined) {
            return;
        }

        turn.end(this.cancelRequested ? "cancelled" : reason);
        this.observeUnanswered(turn);

        // A turn that changed files ends once the reads for them have; the next queued prompt waits for that, so its
        // turn does not start before this one's end is queued.
        const delivered = this.observeEnd(turn);

        // A request the agent made during this turn and left unanswered must not stay answerable: an Allow now
        // would authorize something for a turn that is over. A queued turn asks for its own once it starts.
        this.options.gate.cancelSession(this.id);
        clearTimeout(this.cancelTimer);
        this.cancelTimer = undefined;
        this.current = undefined;
        // A child whose spawn call never reported its end is over with the turn: it must not take output from a later one.
        this.children.endAll(reason === "cancelled" || this.cancelRequested ? "cancelled" : "completed");
        this.children.discardUnclaimed();

        if (delivered === undefined) {
            this.startNext();
        } else {
            this.startNextAfter(delivered);
        }
    }

    /** The session is free: the next queued prompt runs, or the window is told it is idle. */
    private startNext(): void {
        if (this.status === "ended") {
            return;
        }

        this.status = "idle";

        const next = this.queue.shift();

        if (next === undefined) {
            this.options.onChange();
        } else {
            this.run(next.prompt, next.turnId);
        }
    }

    private async startNextAfter(delivered: Promise<void>): Promise<void> {
        await delivered;
        this.startNext();
    }

    private end(reason: string): void {
        if (this.status === "ended") {
            return;
        }

        const wasRunning = this.current;
        const said = this.options.process.scrub(reason);

        this.status = "ended";
        this.endReason = said;
        clearTimeout(this.cancelTimer);
        this.connection.close(new Error(said));
        this.options.gate.cancelSession(this.id);
        // An ended session never leaves its process behind, whatever ended it (an error answer, a closed
        // output, a cancel that went unanswered).
        this.stopping = this.stopProcess();

        for (const tool of this.tools.values()) {
            if (!(tool.status === "pending" || tool.status === "in_progress")) {
                continue;
            }

            tool.status = this.cancelRequested ? "cancelled" : "failed";
            this.observeTool(tool);
        }

        this.children.endAll(this.cancelRequested ? "cancelled" : "failed");
        this.finishChildren();

        wasRunning?.end(this.cancelRequested ? "cancelled" : "failed");

        if (wasRunning !== undefined) {
            this.observeUnanswered(wasRunning);
            this.observeEnd(wasRunning, said);
        }

        // Prompts the backend queued behind it will never run.
        this.dropQueue("failed", said);

        this.current = undefined;
        this.observe((observer) => observer.sessionEnded(this.id));
        this.options.onChange();
    }

    /** What no spawn call claimed is dropped, and the session says what buffering cost it. */
    private finishChildren(): void {
        this.children.discardUnclaimed();

        const { dropped, peakBytes } = this.children.stats();

        if (peakBytes > 0 || dropped > 0) {
            this.options.log?.(`[acp-host] child output buffered before its parent: peak ${String(peakBytes)} bytes, ${String(dropped)} dropped`);
        }
    }

    /** A "no": the agent's reject option, or a cancel that did not come from stopping the turn. */
    private wasDeclined(params: Record<string, unknown>, outcome: PermissionOutcome): boolean {
        if (outcome.outcome === "cancelled") {
            return !this.cancelRequested;
        }

        return offeredOptions(params).some((option) => option.optionId === outcome.optionId && option.kind.startsWith("reject"));
    }

    /** The call the user said no to ends as declined here, whether or not the agent reports it afterwards. */
    private markDeclined(params: Record<string, unknown>): void {
        const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
        const id = toolIdOf(toolCall.toolCallId);
        const tool = this.tools.get(id);

        if (tool === undefined || tool.status === "completed" || tool.status === "failed") {
            return;
        }

        tool.status = "declined";
        this.observeTool(tool);
        this.options.onChange();
    }

    // ─── To the observer ───────────────────────────────────────────────────

    /** Persistence never changes what the session does: an observer that throws is ignored. */
    private observe(call: (observer: SessionObserver) => void): void {
        const { observer } = this.options;

        if (observer === undefined) {
            return;
        }

        try {
            call(observer);
        } catch {
            // The session carries on; the poster logs its own failures.
        }
    }

    /**
     * Hands the observer the text added since the last call. Text that would be scrubbed is held back by the
     * longest value's length until the turn ends, since a value split across two chunks is only recognised once
     * both have arrived; nothing the user asked to mask is posted.
     */
    private observeDelta(turn: Turn | undefined, field: "text" | "thought", final: boolean): void {
        if (turn === undefined || this.options.observer === undefined) {
            return;
        }

        const { scrub, secretLength } = this.options.process;
        const sent = this.sent.get(turn) ?? { text: 0, thought: 0 };
        const scrubbed = secretLength === 0 ? turn[field] : scrub(turn[field]);
        const end = final || secretLength === 0 ? scrubbed.length : Math.max(0, scrubbed.length - (secretLength - 1));

        this.sent.set(turn, sent);

        if (end <= sent[field]) {
            return;
        }

        const delta = scrubbed.slice(sent[field], end);

        sent[field] = end;
        this.observe((observer) => field === "text" ? observer.text(this.id, turn.id, delta) : observer.thought(this.id, turn.id, delta));
    }

    private observeTool(tool: ToolState): void {
        const turn = this.toolOwner.get(tool.id);

        if (turn !== undefined) {
            // Ids and kinds are the agent's own text: what is stored goes through the scrubber like the rest.
            const { scrub } = this.options.process;

            this.observe((observer) => observer.tool(this.id, turn.id, { id: scrub(tool.id), kind: scrub(tool.kind), status: tool.status, title: tool.title }));
        }
    }

    /**
     * Cancelling a request releases its waiter a tick later, after the turn is sealed on the host, so the ones
     * still open when a turn ends are closed here, in order, before its end.
     */
    private observeUnanswered(turn: Turn): void {
        for (const [requestId, owner] of this.pendingPermissions) {
            if (owner !== turn) {
                continue;
            }

            this.pendingPermissions.delete(requestId);
            this.observe((observer) => observer.permissionResolved(this.id, turn.id, requestId, "cancelled"));
        }
    }

    /** Tells the observer the turn ended. Undefined when that is done; otherwise a promise that never rejects and settles once it is. */
    private observeEnd(turn: Turn, error?: string): Promise<void> | undefined {
        this.observeDelta(turn, "text", true);
        this.observeDelta(turn, "thought", true);

        const reason = turn.stopReason ?? "failed";
        const said = reason === "failed" ? error : undefined;
        const changes = this.changes.get(turn);

        // The turn stays in `turns` for the transcript; what its calls wrote is not kept with it.
        this.changes.delete(turn);

        if (changes?.active !== true) {
            this.observe((observer) => observer.turnEnded(this.id, turn.id, reason, said));

            return undefined;
        }

        // Reads for the files the turn named may still be running; the turn ends once they have.
        return this.observeEndWithChanges(turn, changes, reason, said);
    }

    private async observeEndWithChanges(turn: Turn, changes: TurnChanges, reason: StopReason | "failed", error: string | undefined): Promise<void> {
        let summary: Awaited<ReturnType<TurnChanges["summary"]>>;

        try {
            summary = await changes.summary();
        } catch {
            // What the turn changed is a courtesy; the turn's end is not.
            summary = undefined;
        }

        this.observe((observer) =>
            summary === undefined ? observer.turnEnded(this.id, turn.id, reason, error) : observer.turnEnded(this.id, turn.id, reason, error, summary),
        );
    }

    /** What the backend is told of a request: the tool, target and command as the user sees them, and the options the agent offered, never an "always" one. */
    private observePermission(turn: Turn, requestId: string, request: Parameters<typeof describePermission>[0]): void {
        const described = describePermission(request);

        this.observe((observer) =>
            observer.permissionRequested(this.id, turn.id, {
                complete: described.detailsComplete,
                kind: "permission_request",
                options: described.options
                    .filter((option) => !option.kind.includes("always"))
                    .map((option) => {
                        return { ...option, kind: this.options.process.scrub(option.kind), optionId: this.options.process.scrub(option.optionId) };
                    }),
                requestId,
                tool: described.tool,
                // The label the user chose for the folder, never its path.
                ...this.options.hostInfo !== undefined && { folder: this.options.hostInfo.folderLabel },
                ...described.command !== undefined && { command: described.command },
                ...described.target !== undefined && { target: described.target },
            }),
        );
    }

    // ─── From the agent ────────────────────────────────────────────────────

    private onNotification(method: string, params: unknown): void {
        if (method !== METHOD.sessionUpdate || !isRecord(params) || params.sessionId !== this.agentSessionId || !isRecord(params.update)) {
            return;
        }

        const { update } = params;
        const turn = this.current ?? this.turns.at(-1);
        const parent = childParentOf(update);

        // What a child says is not the agent's reply: kept out of the turn's text and tools whether or not it is shown.
        if (parent !== undefined) {
            this.onChildUpdate(parent, update);

            return;
        }

        switch (update.sessionUpdate) {
            case "agent_message_chunk": {
                turn?.append("text", contentText(update.content));
                this.observeDelta(turn, "text", false);
                break;
            }
            case "agent_thought_chunk": {
                turn?.append("thought", contentText(update.content));
                this.observeDelta(turn, "thought", false);
                break;
            }
            case "tool_call":
            case "tool_call_update": {
                this.upsertTool(turn, update);
                break;
            }
            default: {
                return;
            }
        }

        this.options.onChange();
    }

    /** A child's update. With no report of children, they stay inside the agent and nothing is shown. */
    private onChildUpdate(spawnId: string, update: Record<string, unknown>): void {
        if (!isAvailable(capabilityOf(this.report, "subagents.ownChildren"))) {
            return;
        }

        const event = childEventOf(update, this.options.process.scrub);

        if (event !== undefined) {
            this.children.receive(spawnId, event);
        }
    }

    private emitChild(spawnId: string, event: ChildEvent): void {
        const turn = this.toolOwner.get(spawnId);

        if (turn !== undefined) {
            this.observe((observer) => observer.child?.(this.id, turn.id, spawnId, event));
        }
    }

    private upsertTool(turn: Turn | undefined, update: Record<string, unknown>): void {
        const id = toolIdOf(update.toolCallId);

        if (id === "") {
            return;
        }

        let tool = this.tools.get(id);
        let created = false;

        if (tool === undefined) {
            // An update for a call we never saw starts one; it belongs to the turn it arrived in.
            if (turn === undefined) {
                return;
            }

            tool = { id, kind: "other", status: "pending", title: this.options.process.scrub(id) };
            this.tools.set(id, tool);
            this.toolOwner.set(id, turn);
            turn.tools.push(tool);
            created = true;
        }

        if (typeof update.title === "string" && update.title !== "") {
            tool.title = this.options.process.scrub(update.title);
        }

        if (typeof update.kind === "string") {
            tool.kind = update.kind;
        }

        // A call we ended as cancelled or declined stays that way: a late `in_progress` must not bring it back.
        if (!isFinal(tool) && TOOL_STATUSES.has(update.status as ToolStatus)) {
            tool.status = update.status as ToolStatus;
        }

        this.observeTool(tool);

        const owner = this.toolOwner.get(id);

        if (owner !== undefined) {
            this.changes.get(owner)?.note({ id, kind: tool.kind, status: tool.status }, update);
        }

        // The card is on the wire now: whatever a child said about this call before it appeared follows it.
        if (created) {
            this.children.spawn(id);
        }

        // A spawn call that finished ends its child's card, and its result is what a child that streamed nothing said.
        if (tool.status === "completed" || tool.status === "failed") {
            this.children.settle(id, tool.status, completionText(update.content));
        }
    }

    private async onRequest(method: string, params: unknown): Promise<unknown> {
        if (method !== METHOD.requestPermission) {
            // fs/*, terminal/* and anything else: this host offers none of it.
            throw new RpcError(METHOD_NOT_FOUND, "method not found");
        }

        if (!isRecord(params) || params.sessionId !== this.agentSessionId || !Array.isArray(params.options)) {
            throw new RpcError(INVALID_PARAMS, "invalid permission request");
        }

        // Only while a turn the user started is running: a request between turns has nothing to authorize.
        if (this.cancelRequested || this.status !== "busy" || this.current === undefined) {
            return { outcome: { outcome: "cancelled" } };
        }

        const requestId = randomUUID();
        const request = {
            agentLabel: this.options.agentLabel,
            folder: this.options.folder,
            params,
            // The id the backend and the phone know this request by, so a remote answer can find it here.
            requestId,
            scrub: this.options.process.scrub,
            sessionId: this.id,
        };
        const turn = this.current;

        // A request that names the file to be written is the last moment its earlier text can be read.
        if (isRecord(params.toolCall)) {
            this.changes.get(turn)?.note({ id: toolIdOf(params.toolCall.toolCallId), kind: text(params.toolCall.kind), status: "pending" }, params.toolCall);
        }

        this.observePermission(turn, requestId, request);
        this.pendingPermissions.set(requestId, turn);

        const outcome = await this.options.gate.ask(request);

        // The turn ended while it waited and the host was told so already.
        if (!this.pendingPermissions.delete(requestId)) {
            return { outcome: { outcome: "cancelled" } };
        }

        // The request reaches the core's queue a moment after it is sent, so a turn's end can slip between the two:
        // an answer for a turn that is no longer the running one authorizes nothing.
        if (this.current !== turn || this.cancelRequested || this.status !== "busy") {
            // The host still hears how the request ended.
            this.observe((observer) => observer.permissionResolved(this.id, turn.id, requestId, "cancelled"));

            return { outcome: { outcome: "cancelled" } };
        }

        if (this.wasDeclined(params, outcome)) {
            this.markDeclined(params);
        }

        this.observe((observer) => observer.permissionResolved(this.id, turn.id, requestId, resolutionOf(params, outcome)));

        return { outcome };
    }

    /** The process exiting ends the session, whatever else was going on. */
    private async watchExit(): Promise<void> {
        const { code, signal } = await this.options.process.exited;
        const how = signal === null ? `with code ${String(code)}` : `on ${signal}`;
        const stderr = this.options.process.stderrTail().trim();

        this.end(`the agent exited ${how}${stderr === "" ? "" : `: ${stderr}`}`);
    }
}
