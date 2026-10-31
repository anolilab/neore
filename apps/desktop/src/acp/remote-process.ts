/**
 * A coding agent on a server as an `AgentProcess` (plans/ssh-environments.md §7, S7). The session stack above it
 * (JSON-RPC, permissions, turns, the ingest) is the one the computer's own agents use; what differs is where the
 * process runs. `neore-host` on the server owns it, and its stdin, stdout and stderr travel over the connection the
 * server's calls use: this computer's Rust core sends the bytes and tells this module what comes back, as engine
 * events keyed by a handle chosen here.
 *
 * Nothing here decides what may start. The core starts an agent only for a pair the person approved for that server and
 * only on a connection that is up, and the host resolves the folder on the server before it spawns anything.
 */
import { constants } from "node:os";
import { PassThrough, Writable } from "node:stream";

import type { AgentProcess, Spawner } from "./process";
import { MIN_SCRUBBED_LENGTH, scrub, STDERR_KEEP_BYTES } from "./process";
import type { SpawnPlan } from "./types";

/** What the main process needs of the core to run an agent on a server. */
export interface RemoteAgentCore {
    hostAgentStart: (deviceId: string, handle: number, agentKey: string, folder: string) => string;
    hostAgentStop: (handle: number) => void;
    hostAgentWrite: (handle: number, bytes: Buffer) => void;
}

/** The engine events for a running agent (`Event::HostAgent` and `Event::HostAgentEnded`). */
export type RemoteAgentEvent
    = | { code: number | null; error: string | null; handle: number; signal: number | null; type: "hostAgentEnded" }
        | { data: string; handle: number; stream: "stderr" | "stdout"; type: "hostAgent" };

/** How long a stop waits for the server to report the agent gone before it stops waiting. */
const STOP_PATIENCE_MS = 10_000;

const signalName = (signal: number | null): string | null => {
    if (signal === null) {
        return null;
    }

    return Object.entries(constants.signals).find(([, value]) => value === signal)?.[0] ?? String(signal);
};

interface Channel {
    end: (event: Extract<RemoteAgentEvent, { type: "hostAgentEnded" }>) => void;
    output: (stream: "stderr" | "stdout", bytes: Buffer) => void;
}

export class RemoteAgents {
    private nextHandle = 1;

    private readonly running = new Map<number, Channel>();

    public constructor(private readonly core: RemoteAgentCore) {}

    /** Hands an engine event to the agent it is for. Returns whether it was one of ours to handle. */
    public dispatch(event: Record<string, unknown> & { type: string }): boolean {
        if (event.type !== "hostAgent" && event.type !== "hostAgentEnded") {
            return false;
        }

        const agent = event as unknown as RemoteAgentEvent;
        const channel = this.running.get(agent.handle);

        if (channel === undefined) {
            return true;
        }

        if (agent.type === "hostAgent") {
            channel.output(agent.stream, Buffer.from(agent.data, "base64"));
        } else {
            this.running.delete(agent.handle);
            channel.end(agent);
        }

        return true;
    }

    /** A spawner for the agents of one server. */
    public spawner(deviceId: string): Spawner {
        return (plan, agentKey) => this.start(deviceId, plan, agentKey);
    }

    private start(deviceId: string, plan: SpawnPlan, agentKey: string): AgentProcess {
        const handle = this.nextHandle;

        this.nextHandle += 1;

        const stdout = new PassThrough();
        let stderr = "";
        let finished = false;
        let finish!: (result: { code: number | null; signal: string | null }) => void;
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- this app's TypeScript library does not have it yet
        const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
            finish = resolve;
        });
        const ended = (result: { code: number | null; signal: string | null }): void => {
            if (finished) {
                return;
            }

            finished = true;
            this.running.delete(handle);
            stdout.end();
            finish(result);
        };
        const remember = (text: string): void => {
            // Scrubbed before it is cut, so a cut cannot leave the tail of a value the scrub would no longer match.
            stderr = scrub(stderr + text, plan).slice(-STDERR_KEEP_BYTES);
        };

        // Registered before the core starts anything: the first output can arrive before the call returns.
        this.running.set(handle, {
            end: (event) => {
                if (event.error !== null) {
                    remember(event.error);
                }

                ended({ code: event.code, signal: signalName(event.signal) });
            },
            output: (stream, bytes) => {
                if (stream === "stdout") {
                    stdout.write(bytes);
                } else {
                    remember(bytes.toString("utf8"));
                }
            },
        });

        try {
            this.core.hostAgentStart(deviceId, handle, agentKey, plan.cwd);
        } catch (error) {
            this.running.delete(handle);

            // eslint-disable-next-line preserve-caught-error -- the cause can quote an environment value
            throw new Error(`could not start ${plan.command}: ${scrub((error as Error).message, plan)}`);
        }

        const stdin = new Writable({
            final: (callback) => {
                if (!finished) {
                    try {
                        // No bytes close the agent's input.
                        this.core.hostAgentWrite(handle, Buffer.alloc(0));
                    } catch {
                        // The agent is gone; its end is reported on its own.
                    }
                }

                callback();
            },
            write: (chunk: Buffer, _encoding, callback) => {
                if (finished) {
                    callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

                    return;
                }

                try {
                    this.core.hostAgentWrite(handle, chunk);
                    callback();
                } catch (error) {
                    callback(error as Error);
                }
            },
        });

        stdin.on("error", () => {});

        const stop = async (): Promise<void> => {
            if (finished) {
                return;
            }

            try {
                this.core.hostAgentStop(handle);
            } catch {
                // The connection is gone; the agent's end is reported with it.
            }

            let timer: ReturnType<typeof setTimeout> | undefined;
            const gave = new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    // The server did not report it in time: stop waiting, so a dead connection cannot hold a close open.
                    ended({ code: null, signal: null });
                    resolve();
                }, STOP_PATIENCE_MS);
            });

            await Promise.race([exited, gave]);
            clearTimeout(timer);
        };

        return {
            exited,
            killNow: () => {
                try {
                    this.core.hostAgentStop(handle);
                } catch {
                    // Quitting: the connection closing ends the agent on the server as well.
                }
            },
            pid: undefined,
            scrub: (text) => scrub(text, plan),
            secretLength: Math.max(0, ...plan.secretNames.map((name) => plan.env[name]?.length ?? 0).filter((length) => length >= MIN_SCRUBBED_LENGTH)),
            stderrTail: () => scrub(stderr, plan),
            stdin,
            stdout,
            stop,
        };
    }
}
