/**
 * The agents running on this computer. It asks the core for a spawn plan (which refuses what the user has not
 * set up), starts the process, and keeps the sessions the local window shows.
 *
 * Only the main process holds this: the window gets snapshots and sends commands through the local channels.
 */
import { rm } from "node:fs/promises";

import type { CapabilityReport } from "@neore/ai/capabilities";

import { reportFromHandshake } from "./capabilities";
import type { HookApprovals } from "./hooks/approvals";
import type { HookFs } from "./hooks/fs";
import { nodeHookFs } from "./hooks/fs";
import { HookRunner } from "./hooks/runner";
import type { HooksView } from "./hooks/types";
import type { HostSessionInfo, SessionObserver } from "./ingest";
import { JsonRpcConnection } from "./jsonrpc";
import type { PermissionGate } from "./permission";
import { declineGate } from "./permission";
import type { AgentProcess, Spawner } from "./process";
import { acpSupported } from "./process";
import type { Handshake } from "./protocol";
import { initialize } from "./protocol";
import type { SendResult } from "./session";
import { AgentSession } from "./session";
import type { AcpView, ProbeResult, SessionSnapshot, SessionStatus, SessionSummary, SpawnPlan } from "./types";

/** The window is told about changes at most this often; streamed text would otherwise re-render per chunk. */
const CHANGE_INTERVAL_MS = 50;
const MAX_SESSIONS = 8;

const requireSupported = (): void => {
    if (!acpSupported) {
        throw new Error("coding agents are not supported on Windows yet");
    }
};

/** A leftover scratch folder is no reason to fail the probe that was already answered. */
const removeQuietly = async (folder: string): Promise<void> => {
    try {
        await rm(folder, { force: true, recursive: true });
    } catch {
        // The OS clears its temp folder eventually.
    }
};

export interface ManagerOptions {
    appVersion: string;
    cancelGraceMs?: number;
    /** The agents run on another machine (a server): their folder is not one of this computer's, so none of its files are read for them. */
    folderIsRemote?: boolean;
    gate?: PermissionGate;
    /** File-event hooks (`hooks/runner.ts`). Without it, a folder's `.neore/hooks.json` is not looked at. */
    hooks?: { approvals: HookApprovals; fs?: HookFs };
    /** The label of the folder the user approved for this agent (never its path), for the backend's thread. Undefined: keep the session on this computer. */
    hostInfo?: (agentKey: string, folder: string) => Pick<HostSessionInfo, "folderId" | "folderLabel"> | undefined;
    /** Where sessions say what they measured (child buffering). */
    log?: (message: string) => void;
    /** Saves what the sessions do on the backend (`ingest.ts`). Without it, sessions stay on this computer. */
    observer?: SessionObserver;
    /** Told that the window should read the sessions again. */
    onChange: () => void;
    /** `device-core`'s `acpSpawnPlan`, parsed. Throws when the agent or folder is not allowed. */
    plan: (agentKey: string, folder: string | null) => SpawnPlan;
    spawn: Spawner;
    startupTimeoutMs?: number;
}

export class AcpManager {
    private changeTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly processes = new Set<AgentProcess>();

    /** The hook runner of each session that has one; it lives and dies with the session. */
    private readonly runners = new Map<string, HookRunner>();

    /** What each agent reported at its last handshake, by key. Forgotten when the agent's command may have changed. */
    private readonly reports = new Map<string, CapabilityReport>();

    private readonly sessions = new Map<string, AgentSession>();

    public constructor(private readonly options: ManagerOptions) {}

    /**
     * Starts the agent, runs the handshake and stops it. Opens no session, so it creates nothing in the agent's
     * own history and needs no folder.
     */
    public async probe(agentKey: string): Promise<ProbeResult> {
        return await this.withAgent(agentKey, null, {}, async ({ handshake }) => {
            return { agentName: handshake.agentName, agentVersion: handshake.agentVersion, protocolVersion: handshake.protocolVersion };
        });
    }

    /**
     * Starts the agent, runs the handshake, hands `use` the open connection, and stops the agent however that ends. No
     * session is opened unless `use` opens one. `folder` is null for a probe (a scratch folder stands in). Agent output
     * that reaches an error is masked with the values the user set.
     */
    public async withAgent<Result>(
        agentKey: string,
        folder: string | null,
        handlers: { notification?: (method: string, params: unknown) => void },
        use: (agent: { connection: JsonRpcConnection; handshake: Handshake; plan: SpawnPlan; report: CapabilityReport; scrub: (text: string) => string; secretLength: number }) => Promise<Result>,
    ): Promise<Result> {
        requireSupported();

        const plan = this.options.plan(agentKey, folder);
        let child: AgentProcess;

        try {
            child = this.spawn(plan, agentKey);
        } catch (error) {
            // The folder exists before anything starts; a start that fails must not leave it behind.
            if (plan.scratch) {
                await removeQuietly(plan.cwd);
            }

            throw error;
        }

        const connection = new JsonRpcConnection(child.stdout, child.stdin, {
            notification: (method, params) => handlers.notification?.(method, params),
            request: async () => {
                throw new Error("no requests while the agent is not in a session");
            },
        });

        try {
            let handshake: Handshake;

            try {
                handshake = await initialize(connection, this.options.appVersion, this.options.startupTimeoutMs);
            } catch (error) {
                const stderr = child.stderrTail().trim();

                // eslint-disable-next-line preserve-caught-error -- the cause is the agent's own error, which can quote its environment
                throw new Error(`${(error as Error).message}${stderr === "" ? "" : `: ${stderr}`}`);
            }

            const report = reportFromHandshake(handshake.capabilities, Date.now());

            this.reports.set(agentKey, report);

            return await use({ connection, handshake, plan, report, scrub: child.scrub, secretLength: child.secretLength });
        } catch (error) {
            // eslint-disable-next-line preserve-caught-error -- the cause is the agent's own error, which can quote its environment
            throw new Error(child.scrub((error as Error).message));
        } finally {
            connection.close(new Error("finished"));

            try {
                await child.stop();
            } finally {
                if (plan.scratch) {
                    await removeQuietly(plan.cwd);
                }
            }
        }
    }

    /** What each agent reported the last time it was started; an agent not started since this app began has none. */
    public allReports(): Record<string, CapabilityReport> {
        return Object.fromEntries(this.reports);
    }

    /** The agent's command may have changed: what it reported no longer says what it can do. */
    public forgetReport(agentKey: string): void {
        this.reports.delete(agentKey);
        this.changed();
    }

    /** `remote` is set for a session the backend started (`acp_start`): it goes by the id and thread the backend made. */
    public async startSession(agentKey: string, agentLabel: string, folder: string, remote?: { sessionId: string; threadId: string }): Promise<string> {
        requireSupported();

        if (this.summaries().filter((session) => session.status !== "ended").length >= MAX_SESSIONS) {
            throw new Error(`at most ${String(MAX_SESSIONS)} agents at once; close one first`);
        }

        // The core decides: it refuses an unregistered agent and (with consent) a folder the user has not approved.
        const plan = this.options.plan(agentKey, folder);
        const child = this.spawn(plan, agentKey);
        const folderInfo = this.options.hostInfo?.(agentKey, plan.cwd);
        const { hooks } = this.options;
        // The runner needs the session to prompt and the session needs the runner to say when its turns start and end.
        let runner: HookRunner | undefined;
        const session = new AgentSession({
            agentKey,
            agentLabel,
            appVersion: this.options.appVersion,
            cancelGraceMs: this.options.cancelGraceMs,
            folder: plan.cwd,
            folderIsRemote: this.options.folderIsRemote,
            gate: this.options.gate ?? declineGate,
            lifecycle: hooks === undefined ? undefined : { ended: () => runner?.stop(), turnEnded: () => runner?.turnEnded(), turnStarted: () => runner?.turnStarted() },
            log: this.options.log,
            onChange: () => this.changed(),
            process: child,
            startupTimeoutMs: this.options.startupTimeoutMs,
            ...remote !== undefined && remote,
            ...folderInfo !== undefined && this.options.observer !== undefined && { hostInfo: { agentKey, agentLabel, ...folderInfo }, observer: this.options.observer },
        });

        this.sessions.set(session.id, session);

        if (hooks !== undefined) {
            runner = new HookRunner({
                agentKey,
                approvals: hooks.approvals,
                folder: plan.cwd,
                fs: hooks.fs ?? nodeHookFs,
                isIdle: () => session.summary().status === "idle",
                log: this.options.log,
                onChange: () => this.changed(),
                send: (prompt) => {
                    session.send(prompt);
                },
            });
            this.runners.set(session.id, runner);
        }

        // The window may ask for the hooks while the session starts: the runner is looking at the folder from here on,
        // and fires nothing until the session is idle.
        this.watchFolder(runner);

        try {
            await session.start();
        } catch (error) {
            runner?.stop();

            throw error;
        } finally {
            // A start that failed after the handshake still told what the agent can do.
            if (session.handshake !== undefined) {
                this.reports.set(agentKey, reportFromHandshake(session.handshake.capabilities, Date.now()));
            }
        }

        return session.id;
    }

    /** What this computer knows of the session; `undefined` when it has none by that id (not started yet, or forgotten). */
    public statusOf(sessionId: string): SessionStatus | undefined {
        return this.sessions.get(sessionId)?.summary().status;
    }

    public send(sessionId: string, prompt: string, turnId?: string): SendResult {
        return this.require(sessionId).send(prompt, turnId);
    }

    public cancel(sessionId: string): void {
        this.require(sessionId).cancel();
    }

    /** Stops the turn the backend named, if that session still runs it. A turn that already ended is not an error. */
    public cancelTurn(sessionId: string, turnId: string): boolean {
        return this.sessions.get(sessionId)?.cancelTurn(turnId) ?? false;
    }

    public async close(sessionId: string): Promise<void> {
        await this.require(sessionId).close();
    }

    /**
     * Ends the sessions the user's approvals no longer cover: an agent that was removed, or a folder whose
     * approval is gone (revoked, or dropped because the agent's command or `PATH` changed).
     */
    public async closeUnapproved(view: Pick<AcpView, "agents" | "consents">): Promise<void> {
        const covered = (agentKey: string, folder: string): boolean =>
            view.agents.some((agent) => agent.key === agentKey)
            && view.consents.some((consent) => consent.agentKey === agentKey && consent.folderPath === folder);

        const closing: Promise<void>[] = [];

        for (const session of this.sessions.values()) {
            const { agentKey, folder, status } = session.summary();

            if (status !== "ended" && !covered(agentKey, folder)) {
                closing.push(session.close());
            }
        }

        await Promise.all(closing);
    }

    /** Forgets an ended session. */
    public remove(sessionId: string): void {
        if (this.sessions.get(sessionId)?.snapshot().status !== "ended") {
            return;
        }

        this.sessions.delete(sessionId);
        this.runners.delete(sessionId);
        this.changed();
    }

    /** What the folder's hooks file says, every hook in full, and whether the person approved exactly this file. */
    public async hooks(sessionId: string): Promise<HooksView> {
        return await this.requireRunner(sessionId).view();
    }

    /** Approves the hooks file whose hash the person was shown. Refused if the file is no longer that one. */
    public async approveHooks(sessionId: string, hash: string): Promise<void> {
        await this.requireRunner(sessionId).approve(hash);
    }

    public async revokeHooks(sessionId: string): Promise<void> {
        await this.requireRunner(sessionId).revoke();
    }

    /** Sends a manual hook's prompt to the open session; never starts one. */
    public async runHook(sessionId: string, hookId: string, hash: string): Promise<void> {
        await this.requireRunner(sessionId).runManual(hookId, hash);
    }

    public snapshot(sessionId: string): SessionSnapshot {
        return this.require(sessionId).snapshot();
    }

    public summaries(): SessionSummary[] {
        return Array.from(this.sessions.values(), (session) => session.summary());
    }

    public list(): SessionSnapshot[] {
        return Array.from(this.sessions.values(), (session) => session.snapshot());
    }

    /**
     * Kills every agent's process group at once and does not wait: the app is quitting. Synchronous on purpose,
     * `will-quit` cannot await.
     */
    public killAll(): void {
        for (const child of this.processes) {
            try {
                child.killNow();
            } catch {
                // One group that cannot be signalled must not spare the others.
            }
        }
    }

    private require(sessionId: string): AgentSession {
        const session = this.sessions.get(sessionId);

        if (session === undefined) {
            throw new Error("that session no longer exists");
        }

        return session;
    }

    /** Starts the hooks watcher once the session is open. A folder that cannot be watched costs the hooks, not the session. */
    private async watchFolder(runner: HookRunner | undefined): Promise<void> {
        try {
            await runner?.start();
        } catch (error) {
            this.options.log?.(`[acp-hooks] could not watch the folder: ${(error as Error).message}`);
        }
    }

    private requireRunner(sessionId: string): HookRunner {
        this.require(sessionId);

        const runner = this.runners.get(sessionId);

        if (runner === undefined) {
            throw new Error("hooks are not available for this session");
        }

        return runner;
    }

    private changed(): void {
        this.changeTimer ??= setTimeout(() => {
            this.changeTimer = undefined;
            this.options.onChange();
        }, CHANGE_INTERVAL_MS);
    }

    private spawn(plan: SpawnPlan, agentKey: string): AgentProcess {
        const child = this.options.spawn(plan, agentKey);

        this.processes.add(child);
        this.forgetWhenExited(child);

        return child;
    }

    private async forgetWhenExited(child: AgentProcess): Promise<void> {
        await child.exited;
        this.processes.delete(child);
    }
}
