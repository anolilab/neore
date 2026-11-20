/**
 * The agents running on this computer. It asks the core for a spawn plan (which refuses what the user has not
 * set up), starts the process, and keeps the sessions the local window shows.
 *
 * Only the main process holds this: the window gets snapshots and sends commands through the local channels.
 */
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { CapabilityReport } from "@neore/ai/capabilities";

import { reportFromHandshake } from "./capabilities";
import type { HookApprovals } from "./hooks/approvals";
import type { HookFs } from "./hooks/fs";
import { nodeHookFs } from "./hooks/fs";
import { HookRunner } from "./hooks/runner";
import type { HooksView } from "./hooks/types";
import type { HostSessionInfo, SessionObserver } from "./ingest";
import { JsonRpcConnection } from "./jsonrpc";
import type { SleepLock } from "./keep-awake";
import type { PermissionGate } from "./permission";
import { declineGate } from "./permission";
import type { PortView, StopResult, StopTarget } from "./ports/ports";
import { PortsService } from "./ports/ports";
import { realPortsSystem } from "./ports/system";
import type { AgentProcess, Spawner } from "./process";
import { acpSupported } from "./process";
import type { Handshake } from "./protocol";
import { initialize } from "./protocol";
import type { SendResult } from "./session";
import { AgentSession } from "./session";
import { AgentSignedOutError } from "./signed-out";
import type { TerminalHost } from "./terminals";
import type { AcpUpdate, AcpView, ProbeResult, SessionSnapshot, SessionStatus, SessionSummary, SpawnPlan } from "./types";

/** The window is told about changes at most this often; streamed text would otherwise re-render per chunk. */
const CHANGE_INTERVAL_MS = 50;
const MAX_SESSIONS = 8;

/** How long a failed handshake waits for the agent process to settle before its stderr is read. */
const SPAWN_SETTLE_MS = 200;

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
    /** `device-core`'s `acpSpawnPlanAsync`, parsed. Throws when the agent or folder is not allowed. */
    plan: (agentKey: string, folder: string | null) => Promise<SpawnPlan> | SpawnPlan;
    /** Held while any of this manager's turns runs, so the computer does not sleep mid-turn (`keep-awake.ts`). */
    sleepLock?: SleepLock;
    spawn: Spawner;
    startupTimeoutMs?: number;
    /** The core's terminals (`terminals.ts`), offered to agents whose folder is on this computer. Without it, none is. */
    terminals?: TerminalHost;
}

/** The agent session a backend start opens from: one to load again (`nativeSessionId`) or one to fork (`forkSessionId`). */
const savedSessionFields = (remote: { forkSessionId?: string; nativeSessionId?: string }): { forkSessionId?: string; resumeSessionId?: string } => {
    return {
        ...(remote.forkSessionId !== undefined && { forkSessionId: remote.forkSessionId }),
        ...(remote.nativeSessionId !== undefined && { resumeSessionId: remote.nativeSessionId }),
    };
};

export class AcpManager {
    private changeTimer: ReturnType<typeof setTimeout> | undefined;

    /** Agents whose account is changing (`holdingAgent`): none of their sessions may start. */
    private readonly held = new Set<string>();

    /**
     * Imports and installs running now, per agent (`usingAgent`): a sign-out waits for them, so no import stays connected
     * to the account it removes and no install changes the program whose account it checks.
     */
    private readonly inUse = new Map<string, Set<Promise<unknown>>>();

    private readonly processes = new Set<AgentProcess>();

    /** Set when the manager is dropped with its server: no start may spawn on it from then on. */
    private retired = false;

    /** Starts that have asked for a plan and not yet registered a session; they hold a place under `MAX_SESSIONS`. */
    private starting = 0;

    /** What each agent's approval and program looked like at the last `closeUnapproved`, by key. */
    private readonly approvalState = new Map<string, string>();

    /** Bumped for an agent whose approval or installed program may have changed: a plan of it made across a bump is made again. */
    private readonly revocations = new Map<string, number>();

    /** Agents with a plan being made now; an agent not seen before counts as changed for them. */
    private readonly planning = new Map<string, number>();

    /** The hook runner of each session that has one; it lives and dies with the session. */
    private readonly runners = new Map<string, HookRunner>();

    /** What each agent reported at its last handshake, by key. Forgotten when the agent's command may have changed. */
    private readonly reports = new Map<string, CapabilityReport>();

    private readonly sessions = new Map<string, AgentSession>();

    private readonly portsService = new PortsService(realPortsSystem);

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
        use: (agent: {
            connection: JsonRpcConnection;
            handshake: Handshake;
            plan: SpawnPlan;
            report: CapabilityReport;
            scrub: (text: string) => string;
            secretLength: number;
        }) => Promise<Result>,
    ): Promise<Result> {
        requireSupported();

        const plan = await this.planCurrent(agentKey, folder);
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
                // A stdin write to a missing command fails with EPIPE, and its spawn error can arrive a tick later.
                // Wait briefly for the process to settle (`exited` also resolves on a spawn error), so the stderr
                // tail names the cause rather than only the broken pipe.
                await Promise.race([child.exited, delay(SPAWN_SETTLE_MS)]);
                const stderr = child.stderrTail().trim();

                // eslint-disable-next-line preserve-caught-error -- the cause is the agent's own error, which can quote its environment
                throw new Error(`${(error as Error).message}${stderr === "" ? "" : `: ${stderr}`}`);
            }

            const report = reportFromHandshake(handshake.capabilities, Date.now());

            this.reports.set(agentKey, report);

            return await use({ connection, handshake, plan, report, scrub: child.scrub, secretLength: child.secretLength });
        } catch (error) {
            const masked = child.scrub((error as Error).message);

            // The type stays: callers tell "not signed in" from other failures by it. The message is masked like the rest.
            if (error instanceof AgentSignedOutError) {
                throw new AgentSignedOutError(masked);
            }

            // eslint-disable-next-line preserve-caught-error -- the cause is the agent's own error, which can quote its environment
            throw new Error(masked);
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
    public async startSession(
        agentKey: string,
        agentLabel: string,
        folder: string,
        remote?: { forkSessionId?: string; nativeSessionId?: string; sessionId: string; threadId: string },
    ): Promise<string> {
        requireSupported();
        // Before anything is closed: a start refused for a sign-out must not end the thread's session either.
        this.refuseHeld(agentKey);

        // The backend ends a thread's session when it starts the next one in that thread (an agent switch, `/clear`): the
        // one this computer still runs for it is closed, or every switch or clear would leave an agent process behind.
        if (remote !== undefined) {
            const superseded: AgentSession[] = [];

            for (const session of this.sessions.values()) {
                if (session.threadId === remote.threadId && session.summary().status !== "ended") {
                    superseded.push(session);
                }
            }

            await Promise.all(superseded.map(async (session) => await session.close()));
        }

        this.refuseStart(agentKey);

        // The slot is held while the plan is made, so starts that overlap cannot all pass the check in `refuseStart`.
        this.starting += 1;

        let plan: SpawnPlan;

        try {
            plan = await this.planCurrent(agentKey, folder);
        } finally {
            this.starting -= 1;
        }

        // The plan is made off the main thread: a sign-out or the server's removal can have begun meanwhile.
        this.refuseStart(agentKey);

        const child = this.spawn(plan, agentKey);
        const folderInfo = this.options.hostInfo?.(agentKey, plan.cwd);
        const { hooks } = this.options;
        // The runner needs the session to prompt and the session needs the runner to say when its turns start and end.
        let runner: HookRunner | undefined;
        // The fields only a remote, a resumed or a host-run session has.
        const remoteFields = remote === undefined ? {} : { sessionId: remote.sessionId, threadId: remote.threadId };
        const resumeFields = remote === undefined ? {} : savedSessionFields(remote);
        const { observer } = this.options;
        const hostFields = folderInfo === undefined || observer === undefined ? {} : { hostInfo: { agentKey, agentLabel, ...folderInfo }, observer };
        let session: AgentSession;

        try {
            session = new AgentSession({
                agentKey,
                agentLabel,
                appVersion: this.options.appVersion,
                cancelGraceMs: this.options.cancelGraceMs,
                folder: plan.cwd,
                folderIsRemote: this.options.folderIsRemote,
                gate: this.options.gate ?? declineGate,
                lifecycle:
                    hooks === undefined
                        ? undefined
                        : { ended: () => runner?.stop(), turnEnded: () => runner?.turnEnded(), turnStarted: () => runner?.turnStarted() },
                log: this.options.log,
                onChange: () => this.sessionChanged(),
                process: child,
                startupTimeoutMs: this.options.startupTimeoutMs,
                terminals: this.options.terminals,
                ...remoteFields,
                ...resumeFields,
                ...hostFields,
            });
        } catch (error) {
            // Nothing holds the agent yet: no session was registered, so nothing else would stop it. It is stopped here, and the
            // refusal is reported as it was.
            child.killNow();

            throw error;
        }

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
    public cancelTurn(sessionId: string, turnId: string, options: { keepQueue?: boolean } = {}): boolean {
        return this.sessions.get(sessionId)?.cancelTurn(turnId, options) ?? false;
    }

    /** A change asked for from the web or the phone (`AgentSession.setRemoteOption`). */
    public async setRemoteOption(sessionId: string, optionId: string | undefined, valueId: string): Promise<void> {
        await this.require(sessionId).setRemoteOption(optionId, valueId);
    }

    /** Changes an option the session's agent offers (`AgentSession.setOption`). Throws the reason it was not changed. */
    public async setOption(sessionId: string, optionId: string | undefined, valueId: string): Promise<void> {
        await this.require(sessionId).setOption(optionId, valueId);
    }

    public async close(sessionId: string): Promise<void> {
        await this.require(sessionId).close();
    }

    /**
     * Runs `use` while no session of `agentKey` may start, for a change to the agent's account (a sign-out): a session
     * started meanwhile would run on an account that is going away. A second hold of the same agent is refused.
     */
    public async holdingAgent<Result>(agentKey: string, use: () => Promise<Result>): Promise<Result> {
        if (this.held.has(agentKey)) {
            throw new Error("that agent is already being signed out");
        }

        this.held.add(agentKey);

        try {
            await Promise.allSettled(this.inUse.get(agentKey) ?? []);

            return await use();
        } finally {
            this.held.delete(agentKey);
        }
    }

    /**
     * Runs an import of the agent's saved sessions or an install of its program. Refused while the agent's account is
     * being signed out, and a sign-out that begins meanwhile waits for it.
     */
    public async usingAgent<Result>(agentKey: string, use: () => Promise<Result>): Promise<Result> {
        this.refuseHeld(agentKey);

        const run = use();
        const running = this.inUse.get(agentKey) ?? new Set<Promise<unknown>>();

        running.add(run);
        this.inUse.set(agentKey, running);

        try {
            return await run;
        } finally {
            running.delete(run);

            if (running.size === 0) {
                this.inUse.delete(agentKey);
            }
        }
    }

    /**
     * Throws when `update` would change which account an agent being signed out reaches: its command, or a variable it
     * gets (one for all agents, while any is signed out). A folder approval changes no account and is never refused.
     */
    public refuseUpdateWhileSigningOut(update: AcpUpdate): void {
        if (update.op === "grant" || update.op === "revoke") {
            return;
        }

        if (update.op === "saveAgent" || update.op === "removeAgent") {
            this.refuseHeld(update.key);

            return;
        }

        // The window's update is checked only for shape: a `null` key is "all agents" to the core, so anything not a key is too.
        if (typeof update.agentKey === "string") {
            this.refuseHeld(update.agentKey);
        } else if (this.held.size > 0) {
            throw new Error("an agent is being signed out; change the variables for all agents once that ends");
        }
    }

    /** Ends every open session of one agent: its account is about to change (a sign-out). */
    public async closeAgent(agentKey: string): Promise<void> {
        const closing: Promise<void>[] = [];

        for (const session of this.sessions.values()) {
            const summary = session.summary();

            if (summary.agentKey === agentKey && summary.status !== "ended") {
                closing.push(session.close());
            }
        }

        await Promise.all(closing);
    }

    /**
     * Ends the sessions the user's approvals no longer cover: an agent that was removed, or a folder whose
     * approval is gone (revoked, or dropped because the agent's command or `PATH` changed).
     */
    public async closeUnapproved(view: Pick<AcpView, "agents" | "consents">): Promise<void> {
        this.noteApprovalChanges(view);

        const covered = (agentKey: string, folder: string): boolean => {
            const hasAgent = view.agents.some((agent) => agent.key === agentKey);

            return hasAgent && view.consents.some((consent) => consent.agentKey === agentKey && consent.folderPath === folder);
        };

        const closing: Promise<void>[] = [];

        for (const session of this.sessions.values()) {
            const { agentKey, folder, status } = session.summary();

            if (status !== "ended" && !covered(agentKey, folder)) {
                closing.push(session.close());
            }
        }

        await Promise.all(closing);
    }

    /** The ports the session's agent processes listen on (`ports/ports.ts`). Empty for a session with no local process. */
    public async ports(sessionId: string): Promise<PortView[]> {
        const session = this.require(sessionId);
        const { agentPid } = session;
        const ports = await this.portsService.list(agentPid);

        // A pid is reused only after its process ended, which ends the session: an agent that ended while its ports were
        // read may have handed its pid to another process, so its answer is dropped.
        return session.agentPid === agentPid ? ports : [];
    }

    /** Ends one listening server of the session and its own descendants; never the agent (`ports/ports.ts`). */
    public async stopPort(sessionId: string, target: StopTarget): Promise<StopResult> {
        return await this.portsService.stop(this.require(sessionId).agentPid, target);
    }

    /**
     * The variables of `agentKey` (or of every agent) changed. The view carries their names only, so a replaced
     * value cannot be seen in it: a plan made before the edit holds the old values (a removed credential among
     * them) and is made again.
     */
    public environmentChanged(agentKey?: string): void {
        const keys = agentKey === undefined ? new Set([...this.approvalState.keys(), ...this.planning.keys()]) : [agentKey];

        for (const key of keys) {
            this.revocations.set(key, (this.revocations.get(key) ?? 0) + 1);
        }
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

        // The turns die with their agents, so this manager no longer keeps the computer awake.
        this.options.sleepLock?.report(this, false);
    }

    /** Refuses every new start from now on: a start still waiting on a closing session must not spawn once the runtime is dropped. */
    public refuse(): void {
        this.retired = true;
    }

    /** Lets starts through again, for a removal that failed and kept the runtime. */
    public reopen(): void {
        this.retired = false;
    }

    /** Refuses new starts and ends everything still running: the runtime is being dropped. */
    public retire(): void {
        this.refuse();
        this.killAll();
    }

    private refuseHeld(agentKey: string): void {
        if (this.held.has(agentKey)) {
            throw new Error("that agent is being signed out; start it again once that ends");
        }
    }

    /** Throws when no session of `agentKey` may start now: its account is changing, or too many agents run. */
    private refuseStart(agentKey: string): void {
        // Again: a sign-out can have begun while the superseded sessions were closing.
        this.refuseHeld(agentKey);

        if (this.retired) {
            throw new Error("that server is being removed");
        }

        if (this.summaries().filter((session) => session.status !== "ended").length + this.starting >= MAX_SESSIONS) {
            throw new Error(`at most ${String(MAX_SESSIONS)} agents at once; close one first`);
        }
    }

    /**
     * The core's plan, made again when approvals were revoked while it was being made (an install replaced the
     * agent): the plan that was in flight may belong to files or a folder consent that no longer exist, and the
     * session it would become is not yet there for `closeUnapproved` to close. Nothing awaits between the last
     * check and the spawn that follows.
     */
    private async planCurrent(agentKey: string, folder: string | null): Promise<SpawnPlan> {
        this.planning.set(agentKey, (this.planning.get(agentKey) ?? 0) + 1);

        try {
            return await this.planUntilCurrent(agentKey, folder);
        } finally {
            const left = (this.planning.get(agentKey) ?? 1) - 1;

            if (left > 0) {
                this.planning.set(agentKey, left);
            } else {
                this.planning.delete(agentKey);
            }
        }
    }

    private async planUntilCurrent(agentKey: string, folder: string | null): Promise<SpawnPlan> {
        for (let attempt = 0; ; attempt += 1) {
            const before = this.revocations.get(agentKey) ?? 0;
            // eslint-disable-next-line no-await-in-loop -- each plan depends on the approvals as they are now
            const plan = await this.options.plan(agentKey, folder);

            if (before === (this.revocations.get(agentKey) ?? 0)) {
                return plan;
            }

            // The plan is dropped, and with it the scratch folder a probe plan made for itself.
            if (plan.scratch) {
                // eslint-disable-next-line no-await-in-loop -- the folder goes before the next plan makes another
                await removeQuietly(plan.cwd);
            }

            if (attempt >= 3) {
                throw new Error("The agent's approvals changed while it started. Try again.");
            }
        }
    }

    /**
     * Bumps the counter of every agent whose approval, program or install differs from the last view (or that
     * was not seen before, or is gone). Edits of other agents, and of this one's name or variables, bump nothing.
     */
    private noteApprovalChanges(view: Pick<AcpView, "agents" | "consents">): void {
        const next = new Map<string, string>();

        for (const agent of view.agents) {
            const folders = view.consents
                .filter((consent) => consent.agentKey === agent.key)
                .map((consent) => consent.folderPath);

            folders.sort((left, right) => left.localeCompare(right));

            next.set(agent.key, JSON.stringify([agent.command, agent.args, agent.install?.version ?? null, agent.install?.sha256 ?? null, agent.install?.treeSha256 ?? null, folders]));
        }

        const keys = new Set([...this.approvalState.keys(), ...this.planning.keys(), ...next.keys()]);

        for (const key of keys) {
            const prior = this.approvalState.get(key);

            if (prior !== next.get(key) || (prior === undefined && (this.planning.get(key) ?? 0) > 0)) {
                this.revocations.set(key, (this.revocations.get(key) ?? 0) + 1);
            }
        }

        this.approvalState.clear();

        for (const [key, state] of next) {
            this.approvalState.set(key, state);
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

    /**
     * A session's status changed. The sleep lock is set now, not on the coalesced timer: a turn that starts must hold the
     * computer awake before it can be put to sleep, and the release must not wait either.
     */
    private sessionChanged(): void {
        this.changed();
        this.options.sleepLock?.report(this, this.summaries().some((summary) => summary.status === "busy"));
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
