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

import { JsonRpcConnection } from "./jsonrpc";
import type { PermissionGate, PermissionOutcome } from "./permission";
import { offeredOptions } from "./permission";
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => typeof value === "string" ? value : "";

/** The text of a content block; anything that is not text shows as its type, in brackets. */
const contentText = (content: unknown): string => {
    if (!isRecord(content)) {
        return "";
    }

    return content.type === "text" ? text(content.text) : `[${text(content.type) || "content"}]`;
};

export type SendResult = { position: number; status: "queued" } | { status: "started" };

export interface SessionOptions {
    agentKey: string;
    agentLabel: string;
    appVersion: string;
    cancelGraceMs?: number;
    folder: string;
    gate: PermissionGate;
    /** Called when anything the window shows changed. Coalescing is the caller's. */
    onChange: () => void;
    process: AgentProcess;
    startupTimeoutMs?: number;
}

export class AgentSession {
    private readonly sessionId = randomUUID();

    private agentSessionId = "";

    private readonly connection: JsonRpcConnection;

    private cancelTimer: ReturnType<typeof setTimeout> | undefined;

    private cancelRequested = false;

    private current: Turn | undefined;

    private endReason: string | undefined;

    private status: SessionStatus = "starting";

    /** The process stop that `end` started; `close` and a failed start wait for it. */
    private stopping: Promise<void> = Promise.resolve();

    private readonly queue: string[] = [];

    private readonly tools = new Map<string, ToolState>();

    private readonly turns: Turn[] = [];

    private agent: Handshake | undefined;

    public constructor(private readonly options: SessionOptions) {
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
    }

    public send(prompt: string): SendResult {
        if (this.status === "ended") {
            throw new Error("this session has ended");
        }

        if (this.status === "starting") {
            throw new Error("this session is still starting");
        }

        if (prompt.trim() === "" || prompt.length > MAX_PROMPT_LENGTH) {
            throw new Error("a prompt is 1 to 100000 characters");
        }

        if (this.status === "busy") {
            if (this.queue.length >= MAX_QUEUED_PROMPTS) {
                throw new Error(`${String(MAX_QUEUED_PROMPTS)} prompts are already waiting; wait for the agent or stop it`);
            }

            this.queue.push(prompt);
            this.options.onChange();

            return { position: this.queue.length, status: "queued" };
        }

        this.run(prompt);

        return { status: "started" };
    }

    /** Stops the running turn. Prompts still waiting are dropped, so a stop releases nothing later. */
    public cancel(): void {
        if (this.status !== "busy" || this.current === undefined) {
            this.queue.length = 0;
            this.options.onChange();

            return;
        }

        this.queue.length = 0;
        this.cancelRequested = true;
        this.connection.notify(METHOD.cancel, { sessionId: this.agentSessionId });
        // The spec requires pending permission requests to be answered `cancelled`.
        this.options.gate.cancelSession(this.id);

        for (const tool of this.tools.values()) {
            if (tool.status === "pending" || tool.status === "in_progress") {
                tool.status = "cancelled";
            }
        }

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
            queued: [...this.queue],
            status: this.status,
            turns: this.turns.map((turn) => turn.toState()),
        };
    }

    private run(prompt: string): void {
        const turn = new Turn(prompt, this.options.process.scrub);

        this.turns.push(turn);
        this.current = turn;
        this.status = "busy";
        this.cancelRequested = false;
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
        // A request the agent made during this turn and left unanswered must not stay answerable: an Allow now
        // would authorize something for a turn that is over. A queued turn asks for its own once it starts.
        this.options.gate.cancelSession(this.id);
        clearTimeout(this.cancelTimer);
        this.cancelTimer = undefined;
        this.current = undefined;

        if (this.status === "ended") {
            return;
        }

        this.status = "idle";

        const next = this.queue.shift();

        if (next === undefined) {
            this.options.onChange();
        } else {
            this.run(next);
        }
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
            if (tool.status === "pending" || tool.status === "in_progress") {
                tool.status = this.cancelRequested ? "cancelled" : "failed";
            }
        }

        wasRunning?.end(this.cancelRequested ? "cancelled" : "failed");

        this.current = undefined;
        this.options.onChange();
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
        const id = text(toolCall.toolCallId);
        const tool = this.tools.get(id);

        if (tool === undefined || tool.status === "completed" || tool.status === "failed") {
            return;
        }

        tool.status = "declined";
        this.options.onChange();
    }

    // ─── From the agent ────────────────────────────────────────────────────

    private onNotification(method: string, params: unknown): void {
        if (method !== METHOD.sessionUpdate || !isRecord(params) || params.sessionId !== this.agentSessionId || !isRecord(params.update)) {
            return;
        }

        const { update } = params;
        const turn = this.current ?? this.turns.at(-1);

        switch (update.sessionUpdate) {
            case "agent_message_chunk": {
                turn?.append("text", contentText(update.content));
                break;
            }
            case "agent_thought_chunk": {
                turn?.append("thought", contentText(update.content));
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

    private upsertTool(turn: Turn | undefined, update: Record<string, unknown>): void {
        const id = text(update.toolCallId);

        if (id === "") {
            return;
        }

        let tool = this.tools.get(id);

        if (tool === undefined) {
            // An update for a call we never saw starts one; it belongs to the turn it arrived in.
            if (turn === undefined) {
                return;
            }

            tool = { id, kind: "other", status: "pending", title: this.options.process.scrub(id) };
            this.tools.set(id, tool);
            turn.tools.push(tool);
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
    }

    private async onRequest(method: string, params: unknown): Promise<unknown> {
        if (method !== METHOD.requestPermission) {
            // fs/*, terminal/* and anything else: this host offers none of it.
            throw new RpcError(METHOD_NOT_FOUND, "method not found");
        }

        if (!isRecord(params) || params.sessionId !== this.agentSessionId || !Array.isArray(params.options)) {
            throw new RpcError(INVALID_PARAMS, "invalid permission request");
        }

        if (this.cancelRequested || this.status === "ended") {
            return { outcome: { outcome: "cancelled" } };
        }

        const outcome = await this.options.gate.ask({
            agentLabel: this.options.agentLabel,
            folder: this.options.folder,
            params,
            scrub: this.options.process.scrub,
            sessionId: this.id,
        });

        if (this.wasDeclined(params, outcome)) {
            this.markDeclined(params);
        }

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
