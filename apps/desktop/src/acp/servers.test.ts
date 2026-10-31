/**
 * A server's coding agents end to end on this side of the connection: the real session manager, poster and remote-process
 * adapter, with a stand-in for the server that runs the scripted agent locally and delivers its bytes the way the core
 * delivers a real host's. What is checked is the plan's S7 line: a turn on a server streams into the thread through this
 * computer's ingest, signed as that server, and quitting stops the agent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { declineGate } from "./permission";
import type { AgentProcess } from "./process";
import { spawnAgent } from "./process";
import { RemoteAgents } from "./remote-process";
import type { ServerRecord } from "./servers";
import { ServerAgents } from "./servers";
import { Scratch } from "./testing/harness";

interface Post {
    deviceId: string;
    events: { kind: string; summary?: unknown }[];
    firstSeq?: number;
    sessionId: string;
    threadId?: string;
    turnId?: string;
}

let scratch: Scratch;
let started: { agentKey: string; deviceId: string; folder: string; handle: number }[];
let stopped: number[];
let posts: { post: Post; signature: string; url: string }[];
let signed: string[];
let children: Map<number, AgentProcess>;
let records: ServerRecord[] | undefined;

const SERVER = "srv-1";

const record = (): ServerRecord => {
    return {
        acpAgents: [{ args: [], command: "/opt/agent", envNames: [], install: null, key: "fake", label: "Fake" }],
        acpConsents: [{ agentKey: "fake", folderId: "f1", folderLabel: "work", folderPath: scratch.work }],
        deviceId: SERVER,
        name: "build-box",
    };
};

/** The stand-in backend: opens a thread for a session, then claims each turn's events in order. */
const backend = async (url: URL | string, init?: RequestInit): Promise<Response> => {
    const { payload, signature } = JSON.parse(String(init?.body)) as { payload: string; signature: string };
    const post = JSON.parse(payload) as Post;

    posts.push({ post, signature, url: String(url) });

    if (post.threadId === undefined) {
        return Response.json({ ended: false, next: 0, threadId: "thread-1" });
    }

    return Response.json({ ended: false, next: (post.firstSeq ?? 0) + post.events.length });
};

const setup = (): { remote: RemoteAgents; servers: ServerAgents } => {
    let remote!: RemoteAgents;
    const core = {
        hostAgentStart: (deviceId: string, handle: number, agentKey: string, folder: string): string => {
            started.push({ agentKey, deviceId, folder, handle });

            // The "server": the scripted agent, with its bytes handed back the way the core hands them.
            const child = spawnAgent(scratch.plan({}, folder), agentKey);

            children.set(handle, child);
            child.stdout.on("data", (chunk: Buffer) => remote.dispatch({ data: chunk.toString("base64"), handle, stream: "stdout", type: "hostAgent" }));
            const reportEnd = async (): Promise<void> => {
                const { code } = await child.exited;

                remote.dispatch({ code, error: null, handle, signal: null, type: "hostAgentEnded" });
            };

            reportEnd();

            return "{}";
        },
        hostAgentStop: (handle: number): void => {
            stopped.push(handle);
            children.get(handle)?.killNow();
        },
        hostAgentWrite: (handle: number, bytes: Buffer): void => {
            const child = children.get(handle);

            if (bytes.length === 0) {
                child?.stdin.end();
            } else {
                child?.stdin.write(bytes);
            }
        },
    };

    remote = new RemoteAgents(core);

    const servers = new ServerAgents({
        appVersion: "9.9.9",
        backendOrigin: () => new URL("https://backend.example/"),
        core: {
            acpHostSpawnPlan: (deviceId, agentKey, folder) => {
                if (deviceId !== SERVER || agentKey !== "fake" || folder !== scratch.work) {
                    throw new Error("not approved");
                }

                return JSON.stringify(scratch.plan({}, folder));
            },
            signTurn: (payload) => {
                signed.push(payload);

                return `signed-as:${(JSON.parse(payload) as { deviceId: string }).deviceId}`;
            },
        },
        fetch: backend as typeof fetch,
        finished: () => {},
        gate: declineGate,
        onChange: () => {},
        remote,
        servers: () => records ?? [record()],
        userData: scratch.dir,
    });

    return { remote, servers };
};

beforeEach(() => {
    scratch = new Scratch();
    started = [];
    stopped = [];
    posts = [];
    signed = [];
    children = new Map();
    records = undefined;
});

afterEach(() => {
    for (const child of children.values()) {
        child.killNow();
    }

    scratch.dispose();
});

describe("coding agents on a server", () => {
    it("runs the turn through the server's host and posts it to the ingest signed as that server", async () => {
        const { servers } = setup();
        const runtime = servers.get(SERVER);
        const sessionId = await runtime.acp.startSession("fake", "Fake on build-box", scratch.work, { sessionId: "session-1", threadId: "thread-1" });

        runtime.acp.send(sessionId, "hello", "turn-1");

        await expect.poll(() => posts.some(({ post }) => post.events.some((event) => event.kind === "turn_end")), { timeout: 8000 }).toBe(true);

        // The agent was started by the host of the server, for the approved pair, not as a process of this computer.
        expect(started).toEqual([{ agentKey: "fake", deviceId: SERVER, folder: scratch.work, handle: 1 }]);
        expect(scratch.violations()).toEqual([]);

        // Every post names the server and carries a signature made for it; the paths are the ingest's.
        expect(posts.length).toBeGreaterThan(1);

        for (const { post, signature, url } of posts) {
            expect(post.deviceId).toBe(SERVER);
            expect(signature).toBe(`signed-as:${SERVER}`);
            expect(url).toBe("https://backend.example/hosts/ingest");
        }

        expect(signed).toHaveLength(posts.length);

        const turnEnd = posts.flatMap(({ post }) => post.events).find((event) => event.kind === "turn_end");

        // The folder is on the server: nothing of this computer's disk is read for what the turn changed.
        expect(turnEnd?.summary).toBeUndefined();
    });

    it("builds a runtime only for a server this computer speaks for, and spawns nothing for any other", async () => {
        const { servers } = setup();

        expect(() => servers.get("someone-else")).toThrow("not paired");
        expect(servers.isServer(SERVER)).toBe(true);
        expect(servers.isServer("someone-else")).toBe(false);
        // A pair the core does not approve is refused before a process is started.
        await expect(servers.get(SERVER).acp.startSession("fake", "Fake", "/not/approved")).rejects.toThrow("not approved");
        expect(started).toEqual([]);
    });

    it("stops the remote agent when the app quits", async () => {
        const { servers } = setup();
        const runtime = servers.get(SERVER);

        await runtime.acp.startSession("fake", "Fake on build-box", scratch.work, { sessionId: "session-2", threadId: "thread-2" });
        servers.killAll();

        expect(stopped).toEqual([1]);
        await expect.poll(() => runtime.acp.summaries()[0]?.status, { timeout: 8000 }).toBe("ended");
    });

    it("ends what a previous run left running on a server, through that server's own poster", async () => {
        const { servers } = setup();
        const { writeFile } = await import("node:fs/promises");
        const path = await import("node:path");

        await writeFile(path.join(scratch.dir, `acp-host-turns-${SERVER}.json`), JSON.stringify({ turns: [{ sessionId: "old", threadId: "thread-9", turnId: "turn-9" }] }));
        await servers.recover(await servers.readLeftovers());

        await expect.poll(() => posts.length, { timeout: 8000 }).toBeGreaterThan(0);

        for (const { post } of posts) {
            expect(post.deviceId).toBe(SERVER);
        }
    });

    it("still ends a turn a restart cut off when a held message for the same server opened its channel first", async () => {
        const { servers } = setup();
        const { writeFile } = await import("node:fs/promises");
        const path = await import("node:path");

        await writeFile(path.join(scratch.dir, `acp-host-turns-${SERVER}.json`), JSON.stringify({ turns: [{ sessionId: "old", threadId: "thread-9", turnId: "turn-9" }] }));

        // Read before the replay, as the app does; the replay then opens a channel, which rewrites the file.
        const read = await servers.readLeftovers();

        servers.get(SERVER).poster.turnHeld("held", "turn-held", "hello", "thread-8");
        await servers.recover(read);

        // The turn the last run left is ended as interrupted, through this server's poster, though a channel opened first.
        await expect
            .poll(() => posts.some(({ post }) => post.turnId === "turn-9" && post.events.some((event) => event.kind === "turn_end" && (event as { reason?: string }).reason === "interrupted")), { timeout: 8000 })
            .toBe(true);

        for (const { post } of posts) {
            expect(post.deviceId).toBe(SERVER);
        }
    });

    it("ends the sessions a changed approval no longer covers, for each server", async () => {
        const { servers } = setup();
        const runtime = servers.get(SERVER);

        await runtime.acp.startSession("fake", "Fake on build-box", scratch.work, { sessionId: "session-3", threadId: "thread-3" });
        expect(runtime.acp.summaries()[0]?.status).not.toBe("ended");

        // The server's record still covers the pair: nothing is closed.
        await servers.reviewApprovals();
        expect(runtime.acp.summaries()[0]?.status).not.toBe("ended");

        // The core dropped the approvals (a variable that changes which program runs): the session ends.
        records = [{ ...record(), acpConsents: [] }];
        await servers.reviewApprovals();
        expect(runtime.acp.summaries()[0]?.status).toBe("ended");
    });
});
