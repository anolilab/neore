/**
 * The poster against a stand-in backend that claims events by `(turnId, seq)` as the real ingest does: batching
 * at 250 ms, a retry that carries the same batch, a 409 that is answered by resending, the keepalive, and a turn
 * a restart cut off ending as `interrupted` at the position the backend names.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostEvent } from "./ingest";
import { HostPoster, KEEPALIVE_MS, POST_INTERVAL_MS } from "./ingest";

interface Post {
    close?: boolean;
    deviceId: string;
    events: HostEvent[];
    firstSeq?: number;
    issuedAt: number;
    sessionId: string;
    threadId?: string;
    turnId?: string;
}

/** What the real ingest does with a turn post, in the same words (`backend/lunora/acp/ingest.ts`). */
class FakeBackend {
    public readonly chunks = new Map<string, HostEvent[]>();

    /** Each body's size in UTF-8 bytes, as the backend's cap counts it. */
    public readonly bodyBytes: number[] = [];

    public readonly posts: { at: number; post: Post; signature: string }[] = [];

    public ended = new Set<string>();

    /** The `redirect` mode of every request, as `fetch` was called with it. */
    public readonly redirects: (RequestRedirect | undefined)[] = [];

    public failNext: ("network" | number)[] = [];

    public respond: ((post: Post) => Response | undefined) | undefined;

    public readonly fetch = async (_url: URL | string, init?: RequestInit): Promise<Response> => {
        const { payload, signature } = JSON.parse(String(init?.body)) as { payload: string; signature: string };
        const post = JSON.parse(payload) as Post;

        this.posts.push({ at: clock, post, signature });
        this.redirects.push(init?.redirect);
        this.bodyBytes.push(Buffer.byteLength(String(init?.body)));

        const failure = this.failNext.shift();

        if (failure === "network") {
            throw new Error("socket hang up");
        }

        if (typeof failure === "number") {
            return Response.json({ error: "x" }, { status: failure });
        }

        const custom = this.respond?.(post);

        if (custom !== undefined) {
            return custom;
        }

        if (post.threadId === undefined) {
            return Response.json({ ended: false, next: 0, threadId: "thread-1" });
        }

        const key = post.turnId ?? "";
        const stored = this.chunks.get(key) ?? [];

        if (this.ended.has(key)) {
            return Response.json({ ended: true, next: stored.length });
        }

        const first = post.firstSeq ?? 0;

        if (first > stored.length) {
            return Response.json({ error: "gap", next: stored.length }, { status: 409 });
        }

        stored.push(...post.events.slice(stored.length - first));
        this.chunks.set(key, stored);

        if (post.events.some((event) => event.kind === "turn_end")) {
            this.ended.add(key);
        }

        return Response.json({ ended: false, next: stored.length });
    };

    public texts(turnId: string): string {
        return (this.chunks.get(turnId) ?? []).map((event) => ("text" in event && event.kind === "text" ? event.text : "")).join("");
    }
}

let scratch: string;
let backend: FakeBackend;
let paired: string | undefined;
let clock: number;
let logs: string[];

const hosts: HostPoster[] = [];

const cancelled: string[][] = [];

const poster = (fetchImpl: typeof fetch = backend.fetch as typeof fetch) => {
    const host = new HostPoster({
        cancelTurn: (sessionId, turnId) => {
            cancelled.push([sessionId, turnId]);
        },
        deviceId: () => paired,
        endpoint: new URL("https://backend.test/hosts/ingest"),
        fetch: fetchImpl,
        log: (message) => {
            logs.push(message);
        },
        now: () => clock,
        random: () => 0.5,
        sign: (payload) => `sig:${String(payload.length)}`,
        stateFile: path.join(scratch, "acp-host-turns.json"),
    });

    hosts.push(host);

    return host;
};

const SIGNED = /^sig:/u;

const INFO = { agentKey: "claude", agentLabel: "Claude Code", folderId: "f1", folderLabel: "neore" };

/** What the running-turns file holds. */
const runningTurns = async (): Promise<unknown> => JSON.parse(await readFile(path.join(scratch, "acp-host-turns.json"), "utf8"));

/** Lets the posts, timers and file writes a step started run to the end. */
const settle = async (ms = 0): Promise<void> => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
};

/** Like `settle`, but the clock moves in steps the retries can see, so a streak has a length in time. */
const settleInSteps = async (ms: number, step = 5000): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
        // eslint-disable-next-line no-await-in-loop -- each step must run before the next moves the clock
        await settle(step);
    }
};

const open = async (host: HostPoster, sessionId = "s1") => {
    host.sessionOpened(sessionId, INFO);
    await settle();
};

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    scratch = await mkdtemp(path.join(tmpdir(), "neore-acp-ingest-"));
    backend = new FakeBackend();
    cancelled.length = 0;
    paired = "dev1";
    clock = 1_000_000;
    logs = [];
});

afterEach(async () => {
    const running = [...hosts];

    hosts.length = 0;

    for (const host of running) {
        host.stop();
    }

    await Promise.all(running.map(async (host) => await host.persisted()));

    vi.useRealTimers();
    await rm(scratch, { force: true, recursive: true });
});

describe("opening a session", () => {
    it("posts session_open signed for the device, and keeps a turn waiting for the thread it names", async () => {
        const host = poster();

        await open(host);

        const [first] = backend.posts;

        expect(first?.post).toMatchObject({ deviceId: "dev1", events: [{ ...INFO, kind: "session_open" }], kind: "turn", sessionId: "s1", v: 1 });
        expect(first?.post.threadId).toBeUndefined();
        expect(first?.signature).toMatch(SIGNED);
    });

    it("carries the agent's own session id and what it advertised, cut to what the backend takes", async () => {
        const host = poster();
        const capabilities = { groups: { sessions: { load: { degradation: "none", supported: true } } }, reportedAt: 5, version: 1 } as const;

        host.sessionOpened("s1", { ...INFO, capabilities, nativeSessionId: "n".repeat(300) });
        await settle();

        expect(backend.posts[0]?.post.events[0]).toMatchObject({ capabilities, kind: "session_open", nativeSessionId: "n".repeat(256) });
    });

    it("leaves out an id the agent did not give", async () => {
        const host = poster();

        host.sessionOpened("s1", { ...INFO, nativeSessionId: "" });
        await settle();

        expect(backend.posts[0]?.post.events[0]).not.toHaveProperty("nativeSessionId");
    });

    it("posts nothing while the computer is not paired", async () => {
        paired = undefined;

        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "hello");
        await settle(1000);

        expect(backend.posts).toEqual([]);
    });
});

describe("pairing after a session opened", () => {
    it("opens the sessions that stayed local, so their next turn is posted", async () => {
        paired = undefined;

        const host = poster();

        await open(host);
        paired = "dev1";
        host.paired();
        await settle();
        host.turnStarted("s1", "t1", "hello");
        await settle(1000);

        expect(backend.chunks.get("t1")?.[0]).toMatchObject({ kind: "turn_start" });
    });

    it("posts no turn into a session the backend answers as ended", async () => {
        backend.respond = (post) => (post.threadId === undefined ? Response.json({ ended: true, next: 0, threadId: "thread-1" }) : undefined);

        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "hello");
        await settle(1000);

        expect(backend.chunks.get("t1")).toBeUndefined();
    });
});

describe("a session that never gets a thread", () => {
    it("ends a turn that started during session_open when the backend refuses the open", async () => {
        backend.respond = (post) => (post.threadId === undefined ? Response.json({ error: "no" }, { status: 403 }) : undefined);

        const host = poster();

        host.sessionOpened("s1", INFO);
        host.turnStarted("s1", "t1", "hello");
        await settle(1000);

        expect(host.busy).toBe(false);
    });

    it("stops retrying session_open once the local session has ended", async () => {
        backend.failNext = ["network"];

        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "hello");
        host.sessionEnded("s1");
        await settle(60_000);

        // One open, then a close: the failed open may have reached the backend before the answer was lost.
        expect(backend.posts.filter(({ post }) => post.close !== true)).toHaveLength(1);
        expect(backend.posts.filter(({ post }) => post.close === true)).toHaveLength(1);
        expect(host.busy).toBe(false);
    });
});

describe("a session and turns the backend started", () => {
    it("knows the thread already, so a prompt it received is posted at once, before the open is answered", async () => {
        const host = poster();

        backend.respond = (post) => (post.threadId === undefined ? Response.json({ error: "slow" }, { status: 503 }) : undefined);
        host.sessionOpened("s1", INFO, "thread-1");
        host.turnReceived("s1", "t1", "fix it");
        await settle(POST_INTERVAL_MS);

        const turn = backend.posts.find(({ post }) => post.turnId === "t1");

        expect(turn?.post).toMatchObject({ events: [{ kind: "turn_start", text: "fix it" }], firstSeq: 0, threadId: "thread-1", turnId: "t1" });
    });

    it("posts the prompt once when the turn then starts: received and started are one turn, not two", async () => {
        const host = poster();

        await open(host);
        host.turnReceived("s1", "t1", "fix it");
        host.turnStarted("s1", "t1", "fix it");
        host.text("s1", "t1", "done");
        await settle(POST_INTERVAL_MS);

        expect(backend.chunks.get("t1")).toEqual([
            { kind: "turn_start", text: "fix it" },
            { kind: "text", text: "done" },
        ]);
    });

    it("ends a prompt that was queued and then withdrawn, so its stream does not wait for the reaper", async () => {
        const host = poster();

        await open(host);
        host.turnReceived("s1", "t1", "later");
        host.turnEnded("s1", "t1", "cancelled");
        await settle(POST_INTERVAL_MS);

        expect(backend.chunks.get("t1")).toEqual([
            { kind: "turn_start", text: "later" },
            { kind: "turn_end", reason: "cancelled" },
        ]);
    });
});

describe("a message held for a session that is not open yet", () => {
    it("posts its turn with the thread the command named, before any session link exists, and then runs under that one turn", async () => {
        const host = poster();

        host.turnHeld("s1", "t1", "fix it", "thread-7");
        await settle(POST_INTERVAL_MS);

        expect(backend.posts.find(({ post }) => post.turnId === "t1")?.post).toMatchObject({
            events: [{ kind: "turn_start", text: "fix it" }],
            firstSeq: 0,
            threadId: "thread-7",
        });

        // The session opens and the held message runs: the same turn goes on, with no second `turn_start`.
        await open(host);
        host.turnReceived("s1", "t1", "fix it");
        host.turnStarted("s1", "t1", "fix it");
        host.text("s1", "t1", "done");
        await settle(POST_INTERVAL_MS);

        expect(backend.chunks.get("t1")).toEqual([
            { kind: "turn_start", text: "fix it" },
            { kind: "text", text: "done" },
        ]);
    });

    it("keeps posting while it waits, so the backend's reaper does not time it out", async () => {
        const host = poster();

        host.turnHeld("s1", "t1", "fix it", "thread-7");
        await settle(POST_INTERVAL_MS);

        const before = backend.posts.length;

        await settle(KEEPALIVE_MS + 1000);
        expect(backend.posts.length).toBeGreaterThan(before);
    });

    it("ends with an error when it is never sent", async () => {
        const host = poster();

        host.turnHeld("s1", "t1", "fix it", "thread-7");
        host.turnEnded("s1", "t1", "failed", "the agent did not start");
        await settle(POST_INTERVAL_MS);

        expect(backend.chunks.get("t1")).toEqual([
            { kind: "turn_start", text: "fix it" },
            { error: "the agent did not start", kind: "turn_end", reason: "failed" },
        ]);
    });

    it("is not posted for a computer that is not paired", async () => {
        paired = undefined;

        const host = poster();

        host.turnHeld("s1", "t1", "fix it", "thread-7");
        await settle(1000);
        expect(backend.posts).toEqual([]);
    });

    it("ends a held message that expired while the app was down, at the seq the backend names", async () => {
        backend.chunks.set("t1", [{ kind: "turn_start", text: "fix it" }]);

        const host = poster();

        host.endLapsedTurn("s1", "t1", "thread-7", { error: "the agent did not open its session in time", reason: "failed" });
        await settle(POST_INTERVAL_MS * 2);

        expect(backend.chunks.get("t1")?.at(-1)).toEqual({ error: "the agent did not open its session in time", kind: "turn_end", reason: "failed" });
    });
});

describe("an agent's own children", () => {
    it("are posted under the call that spawned them, long text in pieces, and the completion cut to what one post takes", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "delegate");
        host.child("s1", "t1", "task1", { kind: "text", text: "a".repeat(40_000) });
        host.child("s1", "t1", "task1", { id: "c1", kind: "tool", status: "completed", title: "Read", toolKind: "read" });
        host.child("s1", "t1", "task1", { kind: "end", status: "completed", text: "x".repeat(100_000) });
        await settle(POST_INTERVAL_MS * 4);

        const events = backend.chunks.get("t1") ?? [];
        const children = events.filter((event) => event.kind.startsWith("child_"));

        expect(children.map((event) => event.kind)).toEqual(["child_text", "child_text", "child_text", "child_tool", "child_end"]);
        expect(children.every((event) => "spawnId" in event && event.spawnId === "task1")).toBe(true);
        expect(children.filter((event) => event.kind === "child_text").map((event) => (event as { text: string }).text.length)).toEqual([16_000, 16_000, 8000]);
        expect((children.at(-1) as { text: string }).text).toHaveLength(30_000);
    });

    it("are not posted for a turn that is not running", async () => {
        const host = poster();

        await open(host);
        host.child("s1", "nothing", "task1", { kind: "text", text: "late" });
        await settle(POST_INTERVAL_MS * 2);
        expect(backend.chunks.has("nothing")).toBe(false);
    });
});

describe("a turn the backend ended first", () => {
    it("stops the agent on this computer, which makes good a cancel that never arrived", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "hello");
        await settle(POST_INTERVAL_MS);
        // Stop, the reaper or a revoke ended it on the backend; the cancel call to this computer was lost.
        backend.ended.add("t1");
        host.text("s1", "t1", "still going");
        await settle(POST_INTERVAL_MS);

        expect(cancelled).toEqual([["s1", "t1"]]);
        expect(host.busy).toBe(false);
    });

    it("leaves a turn alone that this computer ended itself", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "hello");
        host.turnEnded("s1", "t1", "end_turn");
        await settle(POST_INTERVAL_MS);

        expect(cancelled).toEqual([]);
    });
});

describe("a turn that changed files", () => {
    it("ends with its summary on the turn_end event, and the whole post stays under the backend's body cap", async () => {
        const host = poster();
        const summary = { files: [{ added: 2, path: "src/a.ts", removed: 1 }], patch: "--- a/src/a.ts\n+++ b/src/a.ts\n" };

        await open(host);
        host.turnStarted("s1", "t1", "edit it");
        host.turnEnded("s1", "t1", "end_turn", undefined, summary);
        await settle(POST_INTERVAL_MS);

        expect(backend.chunks.get("t1")?.at(-1)).toEqual({ kind: "turn_end", reason: "finished", summary });
        expect(Math.max(...backend.bodyBytes)).toBeLessThan(256 * 1024);
    });

    it("sends a turn with nothing changed exactly as before", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "hi");
        host.turnEnded("s1", "t1", "end_turn");
        await settle(POST_INTERVAL_MS);

        expect(backend.chunks.get("t1")?.at(-1)).toEqual({ kind: "turn_end", reason: "finished" });
    });
});

describe("a turn", () => {
    it("merges deltas into one post per 250 ms, with consecutive seqs", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "hello");
        host.text("s1", "t1", "Hel");
        host.text("s1", "t1", "lo ");
        host.thought("s1", "t1", "hm");
        host.text("s1", "t1", "world");
        await settle(POST_INTERVAL_MS);

        const turnPosts = () => backend.posts.filter(({ post }) => post.turnId === "t1");

        expect(turnPosts()).toHaveLength(1);
        expect(turnPosts()[0]?.post).toMatchObject({ firstSeq: 0, threadId: "thread-1", turnId: "t1" });
        expect(turnPosts()[0]?.post.events.map((event) => event.kind)).toEqual(["turn_start", "text", "reasoning", "text"]);

        host.text("s1", "t1", "!");
        host.text("s1", "t1", "!");
        await settle(POST_INTERVAL_MS);

        expect(turnPosts()).toHaveLength(2);
        expect(turnPosts()[1]?.post).toMatchObject({ events: [{ kind: "text", text: "!!" }], firstSeq: 4 });
        expect(backend.texts("t1")).toBe("Hello world!!");
    });

    it("never posts twice inside the interval", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        await settle(POST_INTERVAL_MS);

        const before = backend.posts.length;

        // Ten deltas, 10 ms apart, all inside one interval; each wait must finish before the next delta.
        for (let step = 0; step < 10; step += 1) {
            host.text("s1", "t1", String(step));
            // eslint-disable-next-line no-await-in-loop
            await settle(10);
        }

        expect(backend.posts.slice(before).length).toBeLessThanOrEqual(1);
    });

    it("sends the same batch again after a failure, and everything queued meanwhile after it", async () => {
        const host = poster();

        await open(host);
        backend.failNext = ["network", 503];
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "a");
        await settle(POST_INTERVAL_MS);
        host.text("s1", "t1", "b");
        await settle(60_000);

        const turnPosts = backend.posts.filter(({ post }) => post.turnId === "t1");

        // Two failed tries and the one that landed carry the same first events at the same seqs.
        expect(turnPosts[0]?.post.events).toEqual(turnPosts[1]?.post.events);
        expect(turnPosts[0]?.post.firstSeq).toBe(0);
        expect(turnPosts[2]?.post.firstSeq).toBe(0);
        expect(backend.texts("t1")).toBe("ab");
    });

    it("answers a 409 by resending, and the backend writes only what it lacked", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "one");
        await settle(POST_INTERVAL_MS);

        // The backend forgets nothing, but claims the next post starts past what it holds.
        backend.respond = (post) => {
            backend.respond = undefined;

            return post.turnId === "t1" ? Response.json({ error: "gap", next: 2 }, { status: 409 }) : undefined;
        };
        host.text("s1", "t1", "two");
        await settle(POST_INTERVAL_MS * 2);

        expect(backend.texts("t1")).toBe("onetwo");
        expect(backend.chunks.get("t1")).toHaveLength(3);
    });

    it("ends with turn_end and stops: nothing after it is posted, and the running-turns file is emptied", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "done");
        host.turnEnded("s1", "t1", "end_turn");
        host.text("s1", "t1", "late");
        await settle(POST_INTERVAL_MS);
        await settle(KEEPALIVE_MS * 2);

        expect(backend.ended.has("t1")).toBe(true);
        expect(backend.chunks.get("t1")?.at(-1)).toEqual({ kind: "turn_end", reason: "finished" });
        expect(backend.texts("t1")).toBe("done");
        await host.persisted();
        expect(await runningTurns()).toEqual({ turns: [] });
        expect(host.busy).toBe(false);
    });

    it("stops posting when the backend says the turn ended (the reaper timed it out)", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        await settle(POST_INTERVAL_MS);
        backend.ended.add("t1");
        host.text("s1", "t1", "late");
        await settle(POST_INTERVAL_MS);

        const count = backend.posts.length;

        host.text("s1", "t1", "later");
        await settle(KEEPALIVE_MS * 2);

        expect(backend.posts).toHaveLength(count);
    });

    it("drops a turn the backend refuses instead of retrying for ever", async () => {
        const host = poster();

        await open(host);
        backend.failNext = [403];
        host.turnStarted("s1", "t1", "go");
        await settle(POST_INTERVAL_MS);
        await settle(120_000);

        expect(backend.posts.filter(({ post }) => post.turnId === "t1")).toHaveLength(1);
        expect(host.busy).toBe(false);
    });

    it("waits out the interval before it resends after a 409", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "one");
        await settle(POST_INTERVAL_MS);
        backend.respond = (post) => {
            backend.respond = undefined;

            return post.turnId === "t1" ? Response.json({ error: "gap", next: 2 }, { status: 409 }) : undefined;
        };
        host.text("s1", "t1", "two");
        await settle(POST_INTERVAL_MS);

        const turnPosts = backend.posts.filter(({ post }) => post.turnId === "t1");

        expect(turnPosts).toHaveLength(2);

        await settle(POST_INTERVAL_MS);

        const all = backend.posts.filter(({ post }) => post.turnId === "t1");

        expect(all).toHaveLength(3);
        expect((all[2]?.at ?? 0) - (all[1]?.at ?? 0)).toBeGreaterThanOrEqual(POST_INTERVAL_MS);
        expect(backend.texts("t1")).toBe("onetwo");
    });

    it.each([400, 413])("drops a turn the backend answers %i for, instead of resending it for ever", async (status) => {
        const host = poster();

        await open(host);
        backend.failNext = [status];
        host.turnStarted("s1", "t1", "go");
        await settle(POST_INTERVAL_MS);
        await settle(KEEPALIVE_MS * 4);

        expect(backend.posts.filter(({ post }) => post.turnId === "t1")).toHaveLength(1);
        expect(host.busy).toBe(false);
    });

    it("cuts a permission request to the backend's limits, so a long command does not get the post refused", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.permissionRequested("s1", "t1", {
            command: "x".repeat(50_000),
            folder: "f".repeat(900),
            kind: "permission_request",
            options: Array.from({ length: 30 }, (_, index) => {
                return { kind: "allow_once".padEnd(200, "k"), name: "n".repeat(500), optionId: `${"o".repeat(300)}${String(index)}` };
            }),
            requestId: "r".repeat(300),
            target: "t".repeat(9000),
            tool: "T".repeat(2000),
        });
        host.permissionResolved("s1", "t1", "r".repeat(300), "allowed");
        await settle(POST_INTERVAL_MS);

        const [, request, resolved] = backend.chunks.get("t1") ?? [];

        expect(request).toMatchObject({ kind: "permission_request" });

        const asked = request as Extract<HostEvent, { kind: "permission_request" }>;

        expect(asked.command).toHaveLength(10_000);
        expect(asked.folder).toHaveLength(500);
        expect(asked.target).toHaveLength(2000);
        expect(asked.tool).toHaveLength(500);
        expect(asked.requestId).toHaveLength(128);
        expect(asked.options).toHaveLength(16);
        expect(asked.options.every((option) => option.kind.length <= 64 && option.name.length <= 200 && option.optionId.length <= 128)).toBe(true);
        expect(resolved).toMatchObject({ kind: "permission_resolved", requestId: asked.requestId });
    });

    it("keeps every body under the backend's cap for a prompt and output in a script that takes three bytes a character", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "漢".repeat(90_000));

        for (let step = 0; step < 40; step += 1) {
            host.text("s1", "t1", "字".repeat(16_000));
            host.text("s1", "t1", '"\\'.repeat(4000));
        }

        await settle(POST_INTERVAL_MS);
        await settle(POST_INTERVAL_MS * 80);

        const turnBodies = backend.posts.flatMap(({ post }, index) => (post.turnId === "t1" ? [backend.bodyBytes[index] ?? 0] : []));

        expect(turnBodies.length).toBeGreaterThan(1);
        expect(Math.max(...turnBodies)).toBeLessThan(256 * 1024);
        expect(backend.chunks.get("t1")?.[0]).toMatchObject({ kind: "turn_start" });
        expect(backend.chunks.get("t1")).toHaveLength(81);
    });

    it("posts a keepalive while the turn is silent, so the reaper does not time it out", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        await settle(POST_INTERVAL_MS);

        const before = backend.posts.length;

        await settle(KEEPALIVE_MS);

        const [ping] = backend.posts.slice(before);

        expect(ping?.post).toMatchObject({ events: [], firstSeq: 1, turnId: "t1" });
    });

    it("carries a permission request with the agent's options only, and its resolution", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.permissionRequested("s1", "t1", {
            kind: "permission_request",
            options: [{ kind: "allow_once", name: "Allow", optionId: "o1" }],
            requestId: "r1",
            tool: "Bash",
        });
        host.permissionResolved("s1", "t1", "r1", "allowed");
        await settle(POST_INTERVAL_MS);

        expect(backend.chunks.get("t1")?.map((event) => event.kind)).toEqual(["turn_start", "permission_request", "permission_resolved"]);
    });
});

describe("the signed post", () => {
    it("never follows a redirect, so the signed body goes to the configured endpoint only", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.turnEnded("s1", "t1", "end_turn");
        await settle(POST_INTERVAL_MS);

        expect(backend.redirects.length).toBeGreaterThanOrEqual(2);
        expect(backend.redirects.every((mode) => mode === "error")).toBe(true);
    });

    it("keeps the batch and tries it again when fetch rejects a redirect", async () => {
        const original = backend.fetch;
        let rejected = 0;

        const flaky = async (url: URL | string, init?: RequestInit): Promise<Response> => {
            if (rejected === 0 && String(init?.body).includes(String.raw`\"turnId\"`)) {
                rejected += 1;
                throw new TypeError("fetch failed: unexpected redirect");
            }

            return await original(url, init);
        };

        const retrying = poster(flaky as typeof fetch);

        await open(retrying);
        retrying.turnStarted("s1", "t2", "go");
        await settle(60_000);

        expect(rejected).toBe(1);
        expect(backend.chunks.get("t2")?.[0]).toMatchObject({ kind: "turn_start" });
    });
});

describe("a turn that begins while the earlier one is still ending", () => {
    it("keeps the batch and sends it again unchanged on a 409 that names no next", async () => {
        const host = poster();

        await open(host);
        backend.failNext = [409, 409];
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "hello");
        await settleInSteps(60_000);

        const turnPosts = backend.posts.filter(({ post }) => post.turnId === "t1");

        expect(turnPosts.length).toBeGreaterThanOrEqual(3);
        expect(turnPosts[1]?.post.events).toEqual(turnPosts[0]?.post.events);
        expect(turnPosts[2]?.post.firstSeq).toBe(0);
        expect(backend.texts("t1")).toBe("hello");
        expect(logs).toEqual([]);
    });
});

describe("a computer the backend no longer knows", () => {
    it("retries a 401 that passes (a clock blip) and keeps the turn", async () => {
        const host = poster();

        await open(host);
        backend.failNext = [401, 401, 401];
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "hello");
        await settle(60_000);

        expect(backend.texts("t1")).toBe("hello");
        expect(logs).toEqual([]);
    });

    it("stops a turn whose posts keep answering 401 for a minute, and says why once", async () => {
        const host = poster();

        await open(host);
        backend.respond = (post) => (post.turnId === undefined ? undefined : Response.json({ error: "unauthorized" }, { status: 401 }));
        host.turnStarted("s1", "t1", "go");
        host.turnStarted("s1", "t2", "again");
        await settleInSteps(180_000);

        const posts = backend.posts.length;

        await settleInSteps(180_000);

        expect(host.busy).toBe(false);
        expect(backend.posts).toHaveLength(posts);
        expect(logs.filter((message) => message.includes("no longer accepts this computer"))).toHaveLength(1);
        await host.persisted();
        expect(await runningTurns()).toEqual({ turns: [] });
    });

    it("starts the count again after a long gap, so one later 401 does not drop the turn", async () => {
        const host = poster();

        await open(host);
        backend.failNext = [401, 401, 401, 401];
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "hello");
        await settleInSteps(15_000);

        expect(backend.posts.filter(({ post }) => post.turnId === "t1")).toHaveLength(4);

        // The computer slept: the clock moved on, the pending retry did not.
        clock += 3_600_000;
        backend.failNext = [401];
        await settleInSteps(60_000);

        expect(backend.texts("t1")).toBe("hello");
        expect(logs).toEqual([]);
    });

    it("does not count 401s across an answer in between", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        await settle(POST_INTERVAL_MS);
        backend.failNext = [401, 401, 401, 401];
        host.text("s1", "t1", "a");
        await settleInSteps(100_000);
        backend.failNext = [401, 401, 401, 401];
        host.text("s1", "t1", "b");
        await settleInSteps(100_000);

        expect(backend.texts("t1")).toBe("ab");
        expect(logs).toEqual([]);
    });
});

describe("a session that ends locally", () => {
    const closes = () => backend.posts.filter(({ post }) => post.close === true);

    it("tells the backend after its last turn was delivered, not before", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "done");
        host.turnEnded("s1", "t1", "end_turn");
        host.sessionEnded("s1");
        await settle(POST_INTERVAL_MS);

        const [close] = closes();
        const endIndex = backend.posts.findIndex(({ post }) => post.events.some((event) => event.kind === "turn_end"));

        expect(closes()).toHaveLength(1);
        expect(close?.post).toMatchObject({ close: true, deviceId: "dev1", events: [], kind: "turn", sessionId: "s1", v: 1 });
        expect(close?.post.threadId).toBeUndefined();
        expect(close?.signature).toMatch(SIGNED);
        expect(backend.posts.indexOf(close as never)).toBeGreaterThan(endIndex);
    });

    it("holds the close while a turn's output is still being retried", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        await settle(POST_INTERVAL_MS);
        backend.failNext = [503, 503];
        host.turnEnded("s1", "t1", "end_turn");
        host.sessionEnded("s1");
        await settle(POST_INTERVAL_MS);

        expect(closes()).toHaveLength(0);

        await settle(60_000);

        expect(backend.ended.has("t1")).toBe(true);
        expect(closes()).toHaveLength(1);
    });

    it("sends the close at once when no turn ever ran", async () => {
        const host = poster();

        await open(host);
        host.sessionEnded("s1");
        await settle();

        expect(closes()).toHaveLength(1);
    });

    it("tries a close that failed again, and gives up after a few tries", async () => {
        const host = poster();

        await open(host);
        backend.respond = (post) => (post.close === true ? Response.json({ error: "down" }, { status: 503 }) : undefined);
        host.sessionEnded("s1");
        await settleInSteps(600_000);

        expect(closes().length).toBeGreaterThan(1);
        expect(closes().length).toBeLessThanOrEqual(7);
    });

    it("closes a session that ended while its session_open was still in flight, once the backend has answered it", async () => {
        let release = () => {};
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- the supported Node range starts before it exists
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const host = poster(async (url, init) => {
            const { payload } = JSON.parse(String(init?.body)) as { payload: string };
            const post = JSON.parse(payload) as Post;

            if (post.close !== true && post.threadId === undefined) {
                await gate;
            }

            return await backend.fetch(String(url), init);
        });

        host.sessionOpened("s1", INFO);
        await settle();
        host.sessionEnded("s1");
        await settle(POST_INTERVAL_MS);

        // The open has not been answered: a close sent now would be answered "unknown" and the open would then create a session.
        expect(closes()).toHaveLength(0);

        release();
        await settle(POST_INTERVAL_MS);

        expect(closes()).toHaveLength(1);
        expect(backend.posts.findIndex(({ post }) => post.close === true)).toBeGreaterThan(0);
    });

    it("sends no close for a session the backend refused to open", async () => {
        const host = poster();

        backend.respond = (post) => (post.close === true ? undefined : Response.json({ error: "no" }, { status: 403 }));
        await open(host);
        host.sessionEnded("s1");
        await settle(60_000);

        expect(closes()).toHaveLength(0);
    });

    it("has nothing to close for a session that stayed local", async () => {
        paired = undefined;

        const host = poster();

        await open(host);
        host.sessionEnded("s1");
        await settle(60_000);

        expect(backend.posts).toEqual([]);
    });
});

describe("a restart", () => {
    it("ends a turn the previous run left behind as interrupted, at the seq the backend names", async () => {
        await writeFile(path.join(scratch, "acp-host-turns.json"), JSON.stringify({ turns: [{ sessionId: "old", threadId: "thread-9", turnId: "t-old" }] }));
        backend.chunks.set("t-old", [
            { kind: "turn_start", text: "x" },
            { kind: "text", text: "half" },
        ]);

        const host = poster();

        await host.recover();
        await settle(POST_INTERVAL_MS * 2);

        const posts = backend.posts.filter(({ post }) => post.turnId === "t-old");

        // A probe far past anything written is answered 409 with where the backend is; the end goes there.
        expect(posts[0]?.post.firstSeq).toBeGreaterThan(1_000_000);
        expect(posts[1]?.post).toMatchObject({ events: [{ kind: "turn_end", reason: "interrupted" }], firstSeq: 2, threadId: "thread-9" });
        expect(backend.chunks.get("t-old")?.at(-1)).toEqual({ kind: "turn_end", reason: "interrupted" });
        await host.persisted();
        expect(await runningTurns()).toEqual({ turns: [] });
    });

    it("keeps a turn left behind while this computer is not paired, and ends it once it is", async () => {
        await writeFile(path.join(scratch, "acp-host-turns.json"), JSON.stringify({ turns: [{ sessionId: "old", threadId: "thread-9", turnId: "t-old" }] }));
        backend.chunks.set("t-old", [{ kind: "turn_start", text: "x" }]);
        paired = undefined;

        const host = poster();

        await host.recover();
        await settle(POST_INTERVAL_MS * 3);
        await host.persisted();

        expect(backend.posts).toHaveLength(0);
        expect(await runningTurns()).toEqual({ turns: [{ sessionId: "old", threadId: "thread-9", turnId: "t-old" }] });

        paired = "dev1";
        await settle(60_000);

        expect(backend.chunks.get("t-old")?.at(-1)).toEqual({ kind: "turn_end", reason: "interrupted" });
    });

    it("still ends a turn the last run left when a replayed message rewrites the file first", async () => {
        await writeFile(path.join(scratch, "acp-host-turns.json"), JSON.stringify({ turns: [{ sessionId: "old", threadId: "thread-9", turnId: "t-old" }] }));
        backend.chunks.set("t-old", [{ kind: "turn_start", text: "x" }]);

        const host = poster();
        const leftovers = await host.readLeftovers();

        // The replay of a held message opens a channel, which rewrites the file of running turns.
        host.turnHeld("s2", "t-held", "go", "thread-2");
        await host.persisted();

        // The file keeps the turn that is still to be ended, beside the new one.
        expect(await runningTurns()).toEqual({
            turns: [
                { sessionId: "s2", threadId: "thread-2", turnId: "t-held" },
                { sessionId: "old", threadId: "thread-9", turnId: "t-old" },
            ],
        });

        await host.recover(leftovers);
        await settle(POST_INTERVAL_MS * 2);

        expect(backend.chunks.get("t-old")?.at(-1)).toEqual({ kind: "turn_end", reason: "interrupted" });
        // The held message's own turn is not ended: it has a channel, and runs when its session opens.
        expect(backend.chunks.get("t-held")?.some((event) => event.kind === "turn_end")).toBe(false);
    });

    it("records a running turn on disk once its thread is known", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        await settle(POST_INTERVAL_MS);
        await host.persisted();

        expect(await runningTurns()).toEqual({ turns: [{ sessionId: "s1", threadId: "thread-1", turnId: "t1" }] });
    });
});
