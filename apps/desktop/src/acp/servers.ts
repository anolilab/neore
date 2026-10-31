/**
 * The coding agents on the servers this computer speaks for (plans/ssh-environments.md §7, S7).
 *
 * Each server is a device of its own on the backend, so it gets a runtime of its own: a session manager whose agents
 * are started on the server (`remote-process.ts`), a poster that signs the turn output with THAT server's secret in
 * the Rust core (a post is signed only for the device it names), and the early-send hold. All of it is the code the
 * computer's own agents use; only where the process runs, whose secret signs and which folder is meant differ.
 *
 * What a server's agent does not get: the computer's own files. Its folder is a path on the server, so the changes of
 * a turn (read from disk) and the images a reply refers to (read from the approved folder) are not collected for it.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import { EarlySends } from "./early-sends";
import { HostPoster } from "./ingest";
import { AcpManager } from "./manager";
import type { PermissionGate } from "./permission";
import type { RemoteAgents } from "./remote-process";
import type { AcpView, SpawnPlan } from "./types";

/** What the runtime needs to know of a server, read from the core when asked (the person edits it in the local window). */
export interface ServerRecord {
    acpAgents: AcpView["agents"];
    acpConsents: AcpView["consents"];
    deviceId: string;
    name: string;
}

export interface ServerAgentsOptions {
    appVersion: string;
    backendOrigin: () => URL;
    /** The server's agents, as the core lists them; the plan is the core's `acpHostSpawnPlan`. */
    core: { acpHostSpawnPlan: (deviceId: string, agentKey: string, folder: string) => string; signTurn: (payload: string) => string };
    fetch?: typeof fetch;
    /** A command's receipt can leave the log (`commands.ts`). */
    finished: (callId: string) => void;
    gate: PermissionGate;
    log?: (message: string) => void;
    onChange: () => void;
    remote: RemoteAgents;
    /** The paired servers. */
    servers: () => ServerRecord[];
    /** Where the posters keep the turns that are running. */
    userData: string;
}

/** The file one server's poster keeps its running turns in; undefined for any other file name. */
const STATE_FILE = /^acp-host-turns-(.{1,64})\.json$/;

export interface ServerRuntime {
    acp: AcpManager;
    early: EarlySends;
    poster: HostPoster;
}

export class ServerAgents {
    private readonly runtimes = new Map<string, ServerRuntime>();

    public constructor(private readonly options: ServerAgentsOptions) {}

    /** The runtime of a paired server; throws for any other device, so no command can conjure one. */
    public get(deviceId: string): ServerRuntime {
        const existing = this.runtimes.get(deviceId);

        if (existing !== undefined) {
            return existing;
        }

        if (this.options.servers().every((server) => server.deviceId !== deviceId)) {
            throw new Error("that server is not paired with this computer");
        }

        const runtime = this.create(deviceId);

        this.runtimes.set(deviceId, runtime);

        return runtime;
    }

    /** Whether `deviceId` is one of this computer's servers. */
    public isServer(deviceId: string): boolean {
        return this.options.servers().some((server) => server.deviceId === deviceId);
    }

    /** Ends the sessions the person's approvals for a server no longer cover. */
    public async closeUnapproved(deviceId: string, view: Pick<AcpView, "agents" | "consents">): Promise<void> {
        await this.runtimes.get(deviceId)?.acp.closeUnapproved(view);
    }

    /** What a previous run left running on any server ends as `interrupted`, whether or not anything is started this time. */
    public async recover(): Promise<void> {
        let names: string[];

        try {
            names = await readdir(this.options.userData);
        } catch {
            return;
        }

        const ids = names.flatMap((name) => {
            const deviceId = STATE_FILE.exec(name)?.[1];

            return deviceId !== undefined && this.isServer(deviceId) ? [deviceId] : [];
        });

        await Promise.all(ids.map(async (deviceId) => {
            const { poster } = this.get(deviceId);

            try {
                await poster.recover(await poster.readLeftovers());
            } catch (error) {
                this.options.log?.(`[acp-host] a server's unfinished turns could not be ended: ${(error as Error).message}`);
            }
        }));
    }

    /** Synchronous: the app is quitting, and an agent left on a server would outlive it until the connection drops. */
    public killAll(): void {
        for (const runtime of this.runtimes.values()) {
            runtime.acp.killAll();
        }
    }

    public stop(): void {
        for (const runtime of this.runtimes.values()) {
            runtime.poster.stop();
        }
    }

    private record(deviceId: string): ServerRecord {
        const server = this.options.servers().find((candidate) => candidate.deviceId === deviceId);

        if (server === undefined) {
            throw new Error("that server is not paired with this computer");
        }

        return server;
    }

    private create(deviceId: string): ServerRuntime {
        const { options } = this;
        const poster: HostPoster = new HostPoster({
            cancelTurn: (sessionId, turnId) => {
                this.runtimes.get(deviceId)?.acp.cancelTurn(sessionId, turnId);
                this.runtimes.get(deviceId)?.early.cancel(sessionId, turnId);
            },
            deviceId: () => deviceId,
            endpoint: new URL("hosts/ingest", options.backendOrigin()),
            fetch: options.fetch,
            log: options.log,
            // No `media`: the folder is on the server, and the files a reply names are read from this computer's disk.
            sign: (payload) => options.core.signTurn(payload),
            stateFile: path.join(options.userData, `acp-host-turns-${deviceId}.json`),
        });
        const acp = new AcpManager({
            appVersion: options.appVersion,
            folderIsRemote: true,
            gate: options.gate,
            hostInfo: (agentKey, folder) => {
                const consent = this.record(deviceId).acpConsents.find((candidate) => candidate.agentKey === agentKey && candidate.folderPath === folder);

                return consent === undefined ? undefined : { folderId: consent.folderId, folderLabel: consent.folderLabel };
            },
            log: options.log,
            observer: poster,
            onChange: options.onChange,
            plan: (agentKey, folder) => {
                if (folder === null) {
                    throw new Error("a coding agent on a server starts in a folder");
                }

                return JSON.parse(options.core.acpHostSpawnPlan(deviceId, agentKey, folder)) as SpawnPlan;
            },
            spawn: options.remote.spawner(deviceId),
        });
        const early = new EarlySends({
            finished: options.finished,
            log: options.log,
            observer: poster,
            send: (sessionId, text, turnId) => {
                acp.send(sessionId, text, turnId);
            },
            statusOf: (sessionId) => acp.statusOf(sessionId),
        });

        return { acp, early, poster };
    }
}
