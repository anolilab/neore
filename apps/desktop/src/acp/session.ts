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

import type { RawOptions } from "./agent-options";
import { configOptionsOf, isOffered, optionsOf, resolveOptions, withCurrentMode, withOptionValue } from "./agent-options";
import { usageOf } from "./agent-state";
import { reportFromHandshake, withOptionCapabilities } from "./capabilities";
import { TurnChanges } from "./changes";
import { childEventOf, childParentOf, completionText, contentText, isRecord, text, toolIdOf } from "./child-updates";
import type { ChildEvent } from "./children";
import { ChildLedger } from "./children";
import type { TerminalExit } from "./host-events";
import type { HostSessionInfo, SessionObserver } from "./ingest";
import { JsonRpcConnection } from "./jsonrpc";
import type { PermissionGate, PermissionOutcome } from "./permission";
import { describePermission, offeredOptions } from "./permission";
import { planOf } from "./plan";
import type { AgentProcess } from "./process";
import type { Handshake } from "./protocol";
import { initialize, loadSession, METHOD, openNewSession, promptParams, setConfigOption, setMode } from "./protocol";
import { INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, RpcError } from "./rpc-error";
import type { TerminalExitStatus, TerminalHost } from "./terminals";
import { createRequestOf, MAX_SESSION_TERMINALS, SessionTerminals } from "./terminals";
import { cutTerminal, outputTail, terminalIdOf, toolTextOf } from "./tool-output";
import { Turn } from "./turn";
import type { SessionSnapshot, SessionStatus, SessionSummary, StopReason, ToolState, ToolStatus } from "./types";

/** Prompts waiting behind a running turn. A full queue refuses the next one; it never drops one silently. */
const MAX_QUEUED_PROMPTS = 8;
const MAX_PROMPT_LENGTH = 100_000;
/** After a cancel, how long the agent has to answer its prompt before the process is ended. */
const DEFAULT_CANCEL_GRACE_MS = 5000;

/**
 * After a cancelled turn, how long the next queued prompt waits. An update carries no turn id, so output an agent
 * flushes after answering the cancelled prompt would otherwise land in the next turn; in this window it stays with
 * the cancelled one.
 */
const DEFAULT_CANCEL_SETTLE_MS = 500;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/** After the agent's output closes, how long to wait for its exit status so the error can say why. */
const EXIT_WAIT_MS = 500;

/** How a terminal ended, as the tool event carries it. */
const exitReport = (exit: TerminalExitStatus): TerminalExit => {
    return { ...exit.exitCode !== null && { code: exit.exitCode }, ...exit.signal !== null && { signal: exit.signal } };
};

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
    cancelSettleMs?: number;
    /** Says what this agent reports it can do. Defaults to the handshake's own (`capabilities.ts`); tests stand in for an agent that reports more. */
    capabilityReport?: (handshake: Handshake) => CapabilityReport;
    folder: string;
    /** The folder is on another machine: this computer's own files say nothing about what the agent changed there, so none are read. */
    folderIsRemote?: boolean;
    gate: PermissionGate;
    /** What the backend shows for this session (labels only). With `observer`, opening the session makes its thread. */
    hostInfo?: HostSessionInfo;
    /** Told, without coalescing, when a turn starts or ends and when the session ends (by any path), for what must not miss one. */
    lifecycle?: { ended: () => void; turnEnded: () => void; turnStarted: () => void };
    /** Where the session says what it measured (child buffering). */
    log?: (message: string) => void;
    /** Told what the session and its turns do, so they can be saved on the backend (`ingest.ts`). */
    observer?: SessionObserver;
    /** Called when anything the window shows changed. Coalescing is the caller's. */
    onChange: () => void;
    process: AgentProcess;

    /**
     * The agent's own id of a saved session to load instead of opening a new one (harness switch S4), when the backend
     * asked for a reattach (`acp_start`). Loaded only if the agent advertised it; otherwise, or when the load fails, a
     * new session opens and the backend is told why (`reattach` on the session it hears opened).
     */
    resumeSessionId?: string;
    /** The id this session goes by on the backend, when the backend started it (`acp_start`); otherwise one is minted. */
    sessionId?: string;
    startupTimeoutMs?: number;
    /** The core's terminals (`terminals.ts`). Offered to the agent only when set and the folder is on this computer. */
    terminals?: TerminalHost;
    /** The thread the backend made for a session it started. */
    threadId?: string;
}

export class AgentSession {
    private readonly sessionId: string;

    private agentSessionId = "";

    private readonly connection: JsonRpcConnection;

    private cancelTimer: ReturnType<typeof setTimeout> | undefined;

    /** Until when a new prompt waits after a cancelled turn, so output the agent flushes late is not credited to it. */
    private settleUntil = 0;

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

    /** What each call printed, raw (`tool-output.ts`); masked and cut only when it is posted, and never shown in the window. */
    private readonly toolOutput = new Map<string, string>();

    /** The terminal each call's content refers to, by call id (`terminals.ts`). */
    private readonly toolTerminal = new Map<string, string>();

    /** This session's terminals; unset when it offers none (its folder is not on this computer). */
    private readonly terminals: SessionTerminals | undefined;

    private readonly turns: Turn[] = [];

    private agent: Handshake | undefined;

    /** What the agent reported at the handshake. Unset until it has. */
    private report: CapabilityReport | undefined;

    /** What the agent offers (its model, reasoning effort, mode ...), as it last said; unset until the session is open. */
    private offered: RawOptions = {};

    /**
     * Bumped whenever the agent sends its own list of options (`configOptions`) or of modes, so an answer older than that list does
     * not replace it. The two are counted apart: a mode update says nothing about a model answer, and must not refuse it.
     */
    private configVersion = 0;

    private modeVersion = 0;

    /** Counts the option changes asked for, so a late answer to an earlier one does not replace a later one. */
    private optionRequests = 0;

    /** Whether the startup updates are the saved session's (while it loads) or a fresh session's (once it is opened). */
    private startupPhase: "loading" | "opening" = "opening";

    /** The newest usage report sent before the session answered, reported once it has opened. */
    private startupUsage: Record<string, unknown> | undefined;

    /** What happened to the saved session the backend asked to load; unset when it asked for none. */
    private reattach: HostSessionInfo["reattach"];

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
        // The capability is offered only where the core could start a terminal here (a sandbox, and the folder shared with this
        // computer's tools). Otherwise the agent runs its commands itself rather than being asked to approve a command that cannot
        // start. Windows is out too: a terminal's working folder is a POSIX path here.
        this.terminals
            = options.terminals === undefined
                || options.folderIsRemote === true
                || process.platform === "win32"
                || !options.terminals.available(options.folder)
                ? undefined
                : new SessionTerminals(options.terminals, (terminalId) => this.onTerminalEnded(terminalId));
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
            this.agent = await initialize(this.connection, this.options.appVersion, this.options.startupTimeoutMs, { terminal: this.terminals !== undefined });
            this.report = this.options.capabilityReport?.(this.agent) ?? reportFromHandshake(this.agent.capabilities, Date.now());
            this.agentSessionId = await this.openAgentSession();

            // A usage report the agent sent before its session answered reaches the meter now. Its session id is checked like any
            // other update's, so a report from a failed load is not carried into this session.
            const early = this.startupUsage;

            this.startupUsage = undefined;

            if (early !== undefined) {
                this.onNotification(METHOD.sessionUpdate, early);
            }

            // What the agent offered is known now, so the report says whether it has models, reasoning effort and modes.
            if (this.report !== undefined) {
                this.report = withOptionCapabilities(this.report, resolveOptions(this.offered));
            }

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
                ...this.reattach !== undefined && { reattach: this.reattach },
            };

            this.observe((observer) => observer.sessionOpened(this.id, opened, this.options.threadId));
        }

        this.reportOptions();
    }

    /**
     * A change asked for from the web or the phone. A mode can grant standing permissions, so it is changed on the computer only:
     * the legacy mode state (no option id) and an option the agent reports as a mode are refused here, whatever the backend checked.
     */
    public async setRemoteOption(optionId: string | undefined, valueId: string): Promise<void> {
        const category = optionId === undefined ? "mode" : this.offered.configOptions?.find((option) => option.id === optionId)?.category;

        if (category?.toLowerCase() === "mode") {
            throw new Error("a mode is changed on the computer, not from here");
        }

        await this.setOption(optionId, valueId);
    }

    /**
     * Changes one of the agent's options for the backend's `acp_set_config`: `optionId` names a list option, and without it
     * `valueId` is a mode of the legacy state. Only a value the agent itself offered is sent. Refuses with a fixed phrase,
     * never with the agent's own words (they can quote its environment); the agent's answer is the confirmation.
     */
    public async setOption(optionId: string | undefined, valueId: string): Promise<void> {
        if (this.status === "ended" || this.status === "starting") {
            throw new Error("this session is not open");
        }

        if (!isOffered(this.offered, optionId, valueId)) {
            throw new Error("the agent does not offer that choice");
        }

        let answer: unknown;
        const versionAtRequest = this.versionOf(optionId);

        this.optionRequests += 1;
        const request = this.optionRequests;

        // The timeout does not cancel the agent's request: an answer that arrives after it is applied here and reported, so what the
        // person sees follows what the agent did.
        const onLate = (late: unknown): void => {
            // An answer older than a list the agent has sent since, or than a later change asked for, is not applied: that is what is
            // true now.
            if (this.status === "ended" || this.versionOf(optionId) !== versionAtRequest || request !== this.optionRequests) {
                return;
            }

            this.applyOptionAnswer(optionId, valueId, late);
            this.reportOptions();
        };

        try {
            answer = optionId === undefined ? await setMode(this.connection, this.agentSessionId, valueId, undefined, onLate) : await setConfigOption(this.connection, this.agentSessionId, optionId, valueId, undefined, onLate);
        } catch (error) {
            // The agent's own words can quote its environment: only a fixed phrase leaves, and the cause stays out of it.
            const timedOut = (error as Error).message === "the agent did not answer";

            // eslint-disable-next-line preserve-caught-error -- the cause is the agent's own error
            throw new Error(timedOut ? "the agent did not answer" : "the agent did not accept the change");
        }

        // The agent sent its own list while this was outstanding, and that list is newer than the answer: it stands. It must show the
        // value asked for, or the change was not made.
        if (this.versionOf(optionId) !== versionAtRequest) {
            this.reportOptions();

            if (!this.showsValue(optionId, valueId)) {
                throw new Error("the agent did not apply the change");
            }

            return;
        }

        // The agent's list is what is true now; if it still shows another value, the change was not made.
        if (!this.applyOptionAnswer(optionId, valueId, answer)) {
            this.reportOptions();

            throw new Error("the agent did not apply the change");
        }

        this.reportOptions();
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

        // Right after a cancelled turn the agent may still flush that turn's output: a prompt waits out the pause.
        if (this.status === "busy" || Date.now() < this.settleUntil) {
            this.queue.push({ prompt, turnId });
            this.options.onChange();

            if (this.status !== "busy") {
                this.status = "busy";
                this.startNextAfter(sleep(this.settleUntil - Date.now()));
            }

            return { position: this.queue.length, status: "queued" };
        }

        this.run(prompt, turnId);

        return { status: "started" };
    }

    /**
     * Stops the turn with this id if it is the one running: a stop the backend asked for names the turn it means.
     * What waits behind it is dropped, as a person's Stop does (those are prompts typed in the desktop window), unless
     * the backend signed `keepQueue` (a worker's stop: the prompts behind it are other runs' messages).
     */
    public cancelTurn(turnId: string, options: { keepQueue?: boolean } = {}): boolean {
        if (this.current?.id === turnId) {
            // A stop already under way keeps its choice: the backend's end of the same turn arrives as a second cancel.
            if (!this.cancelRequested) {
                this.cancel(options);
            }

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

    /** Stops the running turn. Prompts still waiting are dropped, so a stop releases nothing later, unless `keepQueue` keeps them to run after it. */
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
        // What the turn started in a terminal stops with it, and nothing an earlier turn started.
        const cancelledTurn = this.current?.id;

        if (cancelledTurn !== undefined) {
            this.terminals?.killTurn(cancelledTurn);
        }

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

    /** The version of the list a change to `optionId` is answered against: the modes for the legacy mode state, else the options. */
    private versionOf(optionId: string | undefined): number {
        return optionId === undefined ? this.modeVersion : this.configVersion;
    }

    /** Applies the agent's answer to a change to what the session offers. False when the answer still shows another value. */
    private applyOptionAnswer(optionId: string | undefined, valueId: string, answer: unknown): boolean {
        if (optionId === undefined) {
            this.offered = withCurrentMode(this.offered, valueId, this.options.process.scrub);

            return true;
        }

        // The answer lists every option with its new value; one that is not a list means only this value moved. A list that holds
        // no usable option is not that: it confirms nothing, and what is offered stays as it was.
        const sent = isRecord(answer) ? answer.configOptions : undefined;
        const listed = configOptionsOf(sent, this.options.process.scrub);

        if (sent !== undefined && listed === undefined) {
            return false;
        }

        this.offered = listed === undefined ? withOptionValue(this.offered, optionId, valueId) : { ...this.offered, configOptions: listed };

        return listed === undefined || listed.find((option) => option.id === optionId)?.currentValue === valueId;
    }

    /** Whether what the session offers now shows the value asked for. */
    private showsValue(optionId: string | undefined, valueId: string): boolean {
        if (optionId === undefined) {
            return this.offered.modes?.current === valueId;
        }

        return this.offered.configOptions?.find((option) => option.id === optionId)?.currentValue === valueId;
    }

    /** The agent's session: the saved one when asked for and loadable, else a new one (`reattach` says which, and why not). */
    private async openAgentSession(): Promise<string> {
        const { folder, resumeSessionId, startupTimeoutMs } = this.options;

        if (resumeSessionId === undefined) {
            return await this.openFresh(folder, startupTimeoutMs);
        }

        // No `session/load` frame goes to an agent that did not say it loads them.
        this.startupPhase = "loading";

        if (isAvailable(capabilityOf(this.report, "sessions.load"))) {
            try {
                // What the agent sent while it loaded is older than its answer: the answer's fields win.
                this.offered = { ...this.offered, ...optionsOf(await loadSession(this.connection, resumeSessionId, folder), this.options.process.scrub) };
                this.reattach = { loaded: true };

                return resumeSessionId;
            } catch {
                // The agent's own error can quote its environment: the backend is told that it failed (a code), not its text.
                this.reattach = { loaded: false, reason: "load_failed" };
                this.offered = {};
            }
        } else {
            this.reattach = { loaded: false, reason: "load_unsupported" };
        }

        this.startupPhase = "opening";

        return await this.openFresh(folder, startupTimeoutMs);
    }

    private async openFresh(folder: string, timeoutMs?: number): Promise<string> {
        const { response, sessionId } = await openNewSession(this.connection, folder, timeoutMs);

        this.offered = { ...this.offered, ...optionsOf(response, this.options.process.scrub) };

        return sessionId;
    }

    private takeStartupOptions(update: Record<string, unknown>): void {
        const { scrub } = this.options.process;

        if (update.sessionUpdate === "config_option_update") {
            const configOptions = configOptionsOf(update.configOptions, scrub);

            if (configOptions !== undefined) {
                this.offered = { ...this.offered, configOptions };
            }
        } else if (update.sessionUpdate === "current_mode_update") {
            this.offered = withCurrentMode(this.offered, update.currentModeId, scrub);
        }
    }

    /** Tells the backend what the agent offers now (it keeps the newest of each field and sends them in one post). */
    private reportOptions(): void {
        const options = resolveOptions(this.offered);

        if (Object.keys(options).length > 0) {
            this.observe((observer) => observer.sessionState?.(this.id, options));
        }
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

        if (this.options.observer !== undefined && this.options.folderIsRemote !== true) {
            this.changes.set(turn, new TurnChanges(this.options.folder, this.options.process.scrub));
        }

        this.turns.push(turn);
        this.current = turn;
        this.status = "busy";
        this.cancelRequested = false;
        this.options.lifecycle?.turnStarted();
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

        const cancelled = this.cancelRequested || reason === "cancelled";

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
        this.options.lifecycle?.turnEnded();
        this.forgetToolOutput(turn);
        // A child whose spawn call never reported its end is over with the turn: it must not take output from a later one.
        this.children.endAll(reason === "cancelled" || this.cancelRequested ? "cancelled" : "completed");
        this.children.discardUnclaimed();

        const settleMs = this.options.cancelSettleMs ?? DEFAULT_CANCEL_SETTLE_MS;

        // Also covers a prompt that arrives after this one ended, when the queue was still empty (`send`).
        this.settleUntil = cancelled ? Date.now() + settleMs : 0;

        const settled = cancelled && this.queue.length > 0 ? sleep(settleMs) : undefined;

        if (delivered === undefined && settled === undefined) {
            this.startNext();
        } else {
            this.startNextAfter(delivered, settled);
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

    private async startNextAfter(...waits: (Promise<void> | undefined)[]): Promise<void> {
        await Promise.all(waits);
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

        // The rows above read the terminals' results, so those go only now: no terminal outlives its session, and no printed
        // output stays in memory with the session object the manager keeps until it is removed.
        this.terminals?.releaseAll();
        this.toolOutput.clear();
        this.toolTerminal.clear();

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
        this.options.lifecycle?.turnEnded();
        this.options.lifecycle?.ended();
        this.observe((observer) => observer.sessionEnded(this.id));
        this.options.onChange();
    }

    /**
     * Drops what a turn's calls printed: once the turn's end is queued its channel takes nothing more, so a later report
     * of those calls is never posted, and keeping up to 64K characters per call for the whole session would only cost memory.
     */
    private forgetToolOutput(turn: Turn): void {
        for (const [toolId, owner] of this.toolOwner) {
            if (owner !== turn) {
                continue;
            }

            this.toolOutput.delete(toolId);
            this.toolTerminal.delete(toolId);
        }
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

            const terminalId = this.toolTerminal.get(tool.id);
            // A call that ran in a terminal shows what the terminal printed and how it ended, once it has.
            const ended = terminalId === undefined ? undefined : this.terminals?.result(terminalId);
            // A terminal that printed nothing (or was released before its output was read) keeps what the call's own content showed.
            const fromTerminal = ended === undefined || ended.output === "" ? undefined : cutTerminal(ended, this.options.process.secretLength);
            const printed = fromTerminal ?? this.toolOutput.get(tool.id);
            const output = printed === undefined ? undefined : outputTail(printed, scrub);
            const exit = ended === undefined ? undefined : exitReport(ended.exit);

            this.observe((observer) =>
                observer.tool(this.id, turn.id, {
                    id: scrub(tool.id),
                    kind: scrub(tool.kind),
                    status: tool.status,
                    title: tool.title,
                    ...output !== undefined && { output },
                    ...exit !== undefined && { exit },
                }),
            );
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
                // A command run on this computer is allowed only in its window: the web offers a decline alone.
                complete: described.detailsComplete && request.localOnly !== true,
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

    /** The plan rides the turn to the backend, which shows it live in the thread; the window does not show it. */
    private observePlan(turn: Turn | undefined, update: Parameters<typeof planOf>[0]): void {
        const entries = planOf(update, this.options.process.scrub);

        if (turn !== undefined && entries !== undefined) {
            this.observe((observer) => observer.plan?.(this.id, turn.id, entries));
        }
    }

    /**
     * An update that arrives while the session opens, before its id is known. While the saved session loads, only its updates
     * count; once a fresh session is opened, the saved id's late updates are the failed load's. The options are taken at once; the
     * newest usage report is kept for `start` to report.
     */
    private takeStartupUpdate(params: Record<string, unknown>): void {
        const { resumeSessionId } = this.options;
        const counts = resumeSessionId === undefined || (this.startupPhase === "loading" ? params.sessionId === resumeSessionId : params.sessionId !== resumeSessionId);

        if (!counts || !isRecord(params.update)) {
            return;
        }

        if (params.update.sessionUpdate === "usage_update") {
            this.startupUsage = params;
        } else {
            this.takeStartupOptions(params.update);
        }
    }

    private onNotification(method: string, params: unknown): void {
        // While the session opens its id is not known yet, and an agent may send its options before it answers.
        if (this.agentSessionId === "" && this.status === "starting" && method === METHOD.sessionUpdate && isRecord(params) && isRecord(params.update)) {
            this.takeStartupUpdate(params);

            return;
        }

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
            case "config_option_update": {
                const configOptions = configOptionsOf(update.configOptions, this.options.process.scrub);

                if (configOptions !== undefined) {
                    this.offered = { ...this.offered, configOptions };
                    this.configVersion += 1;
                    this.reportOptions();
                }

                return;
            }
            case "current_mode_update": {
                this.offered = withCurrentMode(this.offered, update.currentModeId, this.options.process.scrub);
                this.modeVersion += 1;
                this.reportOptions();

                return;
            }
            case "plan": {
                this.observePlan(turn, update);

                return;
            }
            case "tool_call":
            case "tool_call_update": {
                this.upsertTool(turn, update);
                break;
            }
            case "usage_update": {
                // Not the window's business: the usage goes to the backend, which shows it in the thread's context meter.
                const usage = usageOf(update, this.options.process.scrub);

                if (usage !== undefined) {
                    this.observe((observer) => observer.sessionState?.(this.id, { usage }));
                }

                return;
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

    /**
     * The terminal a call shows is the one its content names. A whole content without a terminal block stops showing the terminal it
     * showed before, so that terminal's output (or its exit) does not replace the call's current text. A terminal still running is
     * released by its own owner, not through this association.
     */
    private showTerminalOf(id: string, content: unknown): void {
        const terminalId = terminalIdOf(content);

        if (terminalId !== undefined) {
            this.toolTerminal.set(id, terminalId);
        } else if (content !== undefined) {
            this.toolTerminal.delete(id);
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

        // The content is the call's whole content each time: an update that carries it replaces what was printed, one
        // without it leaves it.
        const printed = toolTextOf(update.content, this.options.process.secretLength);

        // An empty text counts only where it clears output the call showed before.
        if (printed !== undefined && (printed !== "" || (this.toolOutput.get(id) ?? "") !== "")) {
            this.toolOutput.set(id, printed);
        }

        this.showTerminalOf(id, update.content);

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
        if (method.startsWith("terminal/") && this.terminals !== undefined) {
            if (!isRecord(params) || params.sessionId !== this.agentSessionId) {
                throw new RpcError(INVALID_PARAMS, "invalid terminal request");
            }

            return await this.onTerminalRequest(this.terminals, method, params);
        }

        if (method !== METHOD.requestPermission) {
            // fs/*, terminal/* where none is offered, and anything else: this host offers none of it.
            throw new RpcError(METHOD_NOT_FOUND, "method not found");
        }

        if (!isRecord(params) || params.sessionId !== this.agentSessionId || !Array.isArray(params.options)) {
            throw new RpcError(INVALID_PARAMS, "invalid permission request");
        }

        return { outcome: await this.decide(params) };
    }

    /**
     * Asks the person about one request and says how it ended, to the backend too. `localOnly`: answered in this
     * computer's window alone, never in a batch and never allowed from another device (a terminal).
     */
    private async decide(params: Record<string, unknown>, localOnly = false): Promise<PermissionOutcome> {
        // Only while a turn the user started is running: a request between turns has nothing to authorize.
        if (this.cancelRequested || this.status !== "busy" || this.current === undefined) {
            return { outcome: "cancelled" };
        }

        const requestId = randomUUID();
        const request = {
            agentLabel: this.options.agentLabel,
            folder: this.options.folder,
            localOnly,
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
            return { outcome: "cancelled" };
        }

        // The request reaches the core's queue a moment after it is sent, so a turn's end can slip between the two:
        // an answer for a turn that is no longer the running one authorizes nothing.
        if (this.current !== turn || this.cancelRequested || this.status !== "busy") {
            // The host still hears how the request ended.
            this.observe((observer) => observer.permissionResolved(this.id, turn.id, requestId, "cancelled"));

            return { outcome: "cancelled" };
        }

        if (this.wasDeclined(params, outcome)) {
            this.markDeclined(params);
        }

        this.observe((observer) => observer.permissionResolved(this.id, turn.id, requestId, resolutionOf(params, outcome)));

        return outcome;
    }

    /** `terminal/*` (`terminals.ts`): a create is asked about first, once; the rest act on a terminal this session made. */
    private async onTerminalRequest(terminals: SessionTerminals, method: string, params: Record<string, unknown>): Promise<unknown> {
        switch (method) {
            case METHOD.terminalCreate: {
                return { terminalId: await this.createTerminal(terminals, params) };
            }
            case METHOD.terminalKill: {
                terminals.kill(params.terminalId as string);

                return {};
            }
            case METHOD.terminalOutput: {
                const { exitStatus, output, truncated } = terminals.output(params.terminalId as string);

                return { output, truncated, ...exitStatus !== null && { exitStatus } };
            }
            case METHOD.terminalRelease: {
                terminals.release(params.terminalId as string);

                return {};
            }
            case METHOD.terminalWaitForExit: {
                return await terminals.waitForExit(params.terminalId as string);
            }
            default: {
                throw new RpcError(METHOD_NOT_FOUND, "method not found");
            }
        }
    }

    /** Asks the person whether the command may run (allow once or decline), then has the core start it in the sandbox. */
    private async createTerminal(terminals: SessionTerminals, params: Record<string, unknown>): Promise<string> {
        const { cwd, env, line, outputByteLimit, shown } = createRequestOf(params);

        if (terminals.live >= MAX_SESSION_TERMINALS) {
            throw new RpcError(INVALID_PARAMS, `at most ${String(MAX_SESSION_TERMINALS)} terminals at once; release one first`);
        }

        // The turn that asked: a cancel of it must end this command even if a queued turn has since reset `cancelRequested`.
        const requester = this.current;

        // The host's own options, never the agent's: only "allow once" and "decline" can be chosen.
        const request = {
            options: [
                { kind: "allow_once", name: "Allow once", optionId: "allow" },
                { kind: "reject_once", name: "Decline", optionId: "decline" },
            ],
            sessionId: this.agentSessionId,
            toolCall: {
                kind: "execute",
                rawInput: { command: shown, ...cwd !== undefined && { cwd } },
                title: "Run a command in a terminal",
                toolCallId: `terminal-${randomUUID()}`,
            },
        };
        const outcome = await this.decide(request, true);

        if (outcome.outcome !== "selected" || outcome.optionId !== "allow") {
            throw new RpcError(INVALID_PARAMS, "the command was not allowed");
        }

        try {
            const terminalId = await terminals.create({
                agentKey: this.options.agentKey,
                env,
                folder: this.options.folder,
                line,
                ...cwd !== undefined && { cwd },
                ...outputByteLimit !== undefined && { outputByteLimit },
            }, requester?.id);

            // The asking turn was cancelled while the command was starting, and `killTurn` ran before it existed: it ends here.
            // Once the turn has ended, a queued turn is current, and a reset `cancelRequested` no longer says anything about it.
            if (this.current !== requester || this.cancelRequested) {
                terminals.release(terminalId);

                throw new Error("the turn ended before the command started");
            }

            return terminalId;
        } catch (error) {
            // The core's refusal names no value the agent did not send; it is still masked like the rest.
            throw new RpcError(INTERNAL_ERROR, this.options.process.scrub(error instanceof Error ? error.message : "the terminal could not start"));
        }
    }

    /** A terminal ended: each tool call that shows it is reported again, with its output and how it ended. */
    private onTerminalEnded(terminalId: string): void {
        for (const [toolId, shown] of this.toolTerminal) {
            const tool = shown === terminalId ? this.tools.get(toolId) : undefined;

            if (tool !== undefined) {
                this.observeTool(tool);
            }
        }
    }

    /** The process exiting ends the session, whatever else was going on. */
    private async watchExit(): Promise<void> {
        const { code, signal } = await this.options.process.exited;
        const how = signal === null ? `with code ${String(code)}` : `on ${signal}`;
        const stderr = this.options.process.stderrTail().trim();

        this.end(`the agent exited ${how}${stderr === "" ? "" : `: ${stderr}`}`);
    }
}
