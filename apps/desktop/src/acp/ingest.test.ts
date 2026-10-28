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

    public failNext: ("network" | number)[] = [];

    public respond: ((post: Post) => Response | undefined) | undefined;

    public readonly fetch = async (_url: URL | string, init?: RequestInit): Promise<Response> => {
        const { payload, signature } = JSON.parse(String(init?.body)) as { payload: string; signature: string };
        const post = JSON.parse(payload) as Post;

        this.posts.push({ at: clock, post, signature });
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
        return (this.chunks.get(turnId) ?? []).map((event) => "text" in event && event.kind === "text" ? event.text : "").join("");
    }
}

let scratch: string;
let backend: FakeBackend;
let paired: string | undefined;
let clock: number;

const hosts: HostPoster[] = [];

const poster = () => {
    const host = new HostPoster({
        deviceId: () => paired,
        endpoint: new URL("https://backend.test/hosts/ingest"),
        fetch: backend.fetch as typeof fetch,
        log: () => {},
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

const open = async (host: HostPoster, sessionId = "s1") => {
    host.sessionOpened(sessionId, INFO);
    await settle();
};

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    scratch = await mkdtemp(path.join(tmpdir(), "neore-acp-ingest-"));
    backend = new FakeBackend();
    paired = "dev1";
    clock = 1_000_000;
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
        backend.respond = (post) => post.threadId === undefined ? Response.json({ ended: true, next: 0, threadId: "thread-1" }) : undefined;

        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "hello");
        await settle(1000);

        expect(backend.chunks.get("t1")).toBeUndefined();
    });
});

describe("a session that never gets a thread", () => {
    it("ends a turn that started during session_open when the backend refuses the open", async () => {
        backend.respond = (post) => post.threadId === undefined ? Response.json({ error: "no" }, { status: 403 }) : undefined;

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

        expect(backend.posts).toHaveLength(1);
        expect(host.busy).toBe(false);
    });
});

describe("a session and turns the backend started", () => {
    it("knows the thread already, so a prompt it received is posted at once, before the open is answered", async () => {
        const host = poster();

        backend.respond = (post) => post.threadId === undefined ? Response.json({ error: "slow" }, { status: 503 }) : undefined;
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
            host.text("s1", "t1", "\"\\".repeat(4000));
        }

        await settle(POST_INTERVAL_MS);
        await settle(POST_INTERVAL_MS * 80);

        const turnBodies = backend.posts.flatMap(({ post }, index) => post.turnId === "t1" ? [backend.bodyBytes[index] ?? 0] : []);

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

describe("a restart", () => {
    it("ends a turn the previous run left behind as interrupted, at the seq the backend names", async () => {
        await writeFile(path.join(scratch, "acp-host-turns.json"), JSON.stringify({ turns: [{ sessionId: "old", threadId: "thread-9", turnId: "t-old" }] }));
        backend.chunks.set("t-old", [{ kind: "turn_start", text: "x" }, { kind: "text", text: "half" }]);

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

    it("records a running turn on disk once its thread is known", async () => {
        const host = poster();

        await open(host);
        host.turnStarted("s1", "t1", "go");
        await settle(POST_INTERVAL_MS);
        await host.persisted();

        expect(await runningTurns()).toEqual({ turns: [{ sessionId: "s1", threadId: "thread-1", turnId: "t1" }] });
    });
});
