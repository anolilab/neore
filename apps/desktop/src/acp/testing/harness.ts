/* eslint-disable import/no-namespace -- zod/consistent-import requires the namespace form, which this rule forbids */
/** Test helpers: a real scripted agent process, and an in-memory agent that replays a recorded transcript. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";
import * as z from "zod";

import type { AgentProcess } from "../process";
import type { SpawnPlan } from "../types";

const FAKE_AGENT = fileURLToPath(new URL("fake-agent.mjs", import.meta.url));

export interface AgentLogEntry {
    cancel?: unknown;
    prompt?: string;
    received?: { id?: number; method?: string; params?: unknown };
    sessionNew?: unknown;
    violation?: string;
}

export class Scratch {
    public readonly dir = mkdtempSync(path.join(tmpdir(), "neore-acp-test-"));

    public readonly logFile = path.join(this.dir, "agent.log");

    public readonly work = path.join(this.dir, "work");

    public constructor() {
        mkdirSync(this.work);
    }

    /** A plan that runs the scripted agent; `env` is the variables the user "set" (the secrets), on top of `PATH` and the log. */
    public plan(env: Record<string, string> = {}, folder: string | null = this.work): SpawnPlan {
        return {
            args: [FAKE_AGENT],
            command: process.execPath,
            cwd: folder ?? this.dir,
            env: { FAKE_AGENT_LOG: this.logFile, PATH: process.env.PATH ?? "", ...env },
            scratch: false,
            secretNames: Object.keys(env),
        };
    }

    public log(): AgentLogEntry[] {
        try {
            return readFileSync(this.logFile, "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as AgentLogEntry);
        } catch {
            return [];
        }
    }

    public violations(): string[] {
        return this.log().flatMap((entry) => entry.violation === undefined ? [] : [entry.violation]);
    }

    public methods(): string[] {
        return this.log().flatMap((entry) => entry.received?.method === undefined ? [] : [entry.received.method]);
    }

    public dispose(): void {
        rmSync(this.dir, { force: true, recursive: true });
    }
}

export const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        // Only ESRCH says the process is gone; EPERM says it is there and cannot be signalled.
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
};

/** Waits until the pid is gone. A zombie still answers signal 0, so this polls until it is reaped. */
export const expectGone = async (pid: number): Promise<void> => {
    await expect.poll(() => alive(pid), { interval: 50, timeout: 8000 }).toBe(false);
};

// ─── Recorded transcripts ──────────────────────────────────────────────────

/** One line of a transcript: what the host must write (`out`), or what the agent writes next (`in`). */
export type TranscriptStep = { in: Record<string, unknown> } | { out: Record<string, unknown> };

export const readTranscript = (name: string): TranscriptStep[] => {
    const file = fileURLToPath(new URL(`../fixtures/${name}.jsonl`, import.meta.url));

    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.startsWith("#"))
        .map((line) => JSON.parse(line) as TranscriptStep);
};

export interface MemoryAgent {
    end: () => void;
    /** The process the host talks to. */
    process: AgentProcess;
    /** Writes one agent frame. */
    say: (frame: Record<string, unknown>) => void;
    /** Frames the host wrote, parsed, in order. */
    written: Record<string, unknown>[];
}

export const memoryAgent = (): MemoryAgent => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: Record<string, unknown>[] = [];
    let exit: (value: { code: number | null; signal: string | null }) => void = () => {};
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` is not in this package's TypeScript lib
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        exit = resolve;
    });

    stdin.setEncoding("utf8");
    let buffer = "";

    stdin.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");

        while (newline !== -1) {
            written.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
        }
    });

    return {
        end: () => {
            stdout.end();
            exit({ code: 0, signal: null });
        },
        process: {
            exited,
            killNow: () => exit({ code: null, signal: "SIGKILL" }),
            pid: undefined,
            scrub: (text) => text,
            secretLength: 0,
            stderrTail: () => "",
            stdin,
            stdout,
            stop: async () => {
                exit({ code: null, signal: "SIGTERM" });
            },
        },
        say: (frame) => {
            stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
        },
        written,
    };
};

/**
 * Plays transcripts against a host, in as many calls as the test needs. Every `in` step is written when
 * reached; every `out` step must be the next frame the host wrote. Ids match by placeholder across calls:
 * `"$1"` is whatever id the host used for that request.
 */
export const transcriptPlayer = (agent: MemoryAgent) => {
    const ids = new Map<string, unknown>();
    let seen = 0;

    return {
        play: async (steps: TranscriptStep[]): Promise<void> => {
            for (const step of steps) {
                if ("in" in step) {
                    const frame = { ...step.in };

                    if (typeof frame.id === "string" && frame.id.startsWith("$")) {
                        frame.id = ids.get(frame.id);
                    }

                    agent.say(frame);
                    continue;
                }

                // Each step waits for the host's next frame, so they cannot run together.
                // eslint-disable-next-line no-await-in-loop
                await expect.poll(() => agent.written.length, { interval: 5, timeout: 4000 }).toBeGreaterThan(seen);

                const actual = agent.written[seen];
                const expected: Record<string, unknown> = { jsonrpc: "2.0", ...step.out };

                seen += 1;

                if (typeof expected.id === "string" && expected.id.startsWith("$")) {
                    ids.set(expected.id, actual.id);
                    expected.id = actual.id;
                }

                expect(actual).toEqual(expected);
            }
        },
    };
};

// ─── The SDK's published schema ────────────────────────────────────────────

const requireFromHere = createRequire(import.meta.url);
const schema = requireFromHere("@agentclientprotocol/sdk/schema/v1/schema.json") as { $defs: Record<string, unknown> };

/** A validator for one definition of the ACP v1 JSON schema, e.g. `PromptRequest`. */
export const acpSchema = (definition: string) => z.fromJSONSchema({ $defs: schema.$defs, $ref: `#/$defs/${definition}` } as never);
