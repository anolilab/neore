/**
 * The agents running on this computer. It asks the core for a spawn plan (which refuses what the user has not
 * set up), starts the process, and keeps the sessions the local window shows.
 *
 * Only the main process holds this: the window gets snapshots and sends commands through the local channels.
 */
import { rm } from "node:fs/promises";

import { JsonRpcConnection } from "./jsonrpc";
import type { PermissionGate } from "./permission";
import { declineGate } from "./permission";
import type { AgentProcess, Spawner } from "./process";
import { acpSupported } from "./process";
import { initialize } from "./protocol";
import type { SendResult } from "./session";
import { AgentSession } from "./session";
import type { AcpView, ProbeResult, SessionSnapshot, SessionSummary, SpawnPlan } from "./types";

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
    gate?: PermissionGate;
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

    private readonly sessions = new Map<string, AgentSession>();

    public constructor(private readonly options: ManagerOptions) {}

    /**
     * Starts the agent, runs the handshake and stops it. Opens no session, so it creates nothing in the agent's
     * own history and needs no folder.
     */
    public async probe(agentKey: string): Promise<ProbeResult> {
        requireSupported();

        const plan = this.options.plan(agentKey, null);
        const child = this.spawn(plan);
        const connection = new JsonRpcConnection(child.stdout, child.stdin, {
            notification: () => {},
            request: async () => {
                throw new Error("no requests during a probe");
            },
        });

        try {
            const handshake = await initialize(connection, this.options.appVersion, this.options.startupTimeoutMs);

            return { agentName: handshake.agentName, agentVersion: handshake.agentVersion, protocolVersion: handshake.protocolVersion };
        } catch (error) {
            const stderr = child.stderrTail().trim();

            // eslint-disable-next-line preserve-caught-error -- the cause is the agent's own error, which can quote its environment
            throw new Error(child.scrub(`${(error as Error).message}${stderr === "" ? "" : `: ${stderr}`}`));
        } finally {
            connection.close(new Error("probe finished"));
            await child.stop();

            if (plan.scratch) {
                await removeQuietly(plan.cwd);
            }
        }
    }

    public async startSession(agentKey: string, agentLabel: string, folder: string): Promise<string> {
        requireSupported();

        if (this.summaries().filter((session) => session.status !== "ended").length >= MAX_SESSIONS) {
            throw new Error(`at most ${String(MAX_SESSIONS)} agents at once; close one first`);
        }

        // The core decides: it refuses an unregistered agent and (with consent) a folder the user has not approved.
        const plan = this.options.plan(agentKey, folder);
        const child = this.spawn(plan);
        const session = new AgentSession({
            agentKey,
            agentLabel,
            appVersion: this.options.appVersion,
            cancelGraceMs: this.options.cancelGraceMs,
            folder: plan.cwd,
            gate: this.options.gate ?? declineGate,
            onChange: () => this.changed(),
            process: child,
            startupTimeoutMs: this.options.startupTimeoutMs,
        });

        this.sessions.set(session.id, session);
        await session.start();

        return session.id;
    }

    public send(sessionId: string, prompt: string): SendResult {
        return this.require(sessionId).send(prompt);
    }

    public cancel(sessionId: string): void {
        this.require(sessionId).cancel();
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
        this.changed();
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

    private changed(): void {
        this.changeTimer ??= setTimeout(() => {
            this.changeTimer = undefined;
            this.options.onChange();
        }, CHANGE_INTERVAL_MS);
    }

    private spawn(plan: SpawnPlan): AgentProcess {
        const child = this.options.spawn(plan);

        this.processes.add(child);
        this.forgetWhenExited(child);

        return child;
    }

    private async forgetWhenExited(child: AgentProcess): Promise<void> {
        await child.exited;
        this.processes.delete(child);
    }
}
