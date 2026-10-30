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
import type { PosterOptions } from "./ingest";
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
        return (this.chunks.get(turnId) ?? []).map((event) => "text" in event && event.kind === "text" ? event.text : "").join("");
    }
}

let scratch: string;
let backend: FakeBackend;
let paired: string | undefined;
let clock: number;
let logs: string[];

const hosts: HostPoster[] = [];

const poster = (media?: PosterOptions["media"], fetcher: typeof fetch = backend.fetch as typeof fetch) => {
    const host = new HostPoster({
        deviceId: () => paired,
        endpoint: new URL("https://backend.test/hosts/ingest"),
        fetch: fetcher,
        log: (message) => {
            logs.push(message);
        },
        ...(media && { media }),
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

describe("a turn's files", () => {
    const UPLOAD_ID = "abcdefghijklmnopqrstu";
    const PNG = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), kind: "image", mime: "image/png", name: "chart.png", size: 5, status: "read" };

    /** The backend for a poster that also uploads: ingest posts go to the stand-in, upload requests are accepted. */
    const withUploads = () => {
        const uploads: string[] = [];
        const fetcher = async (url: URL | string, init?: RequestInit): Promise<Response> => {
            if (String(url).includes("/hosts/uploads")) {
                uploads.push(String(init?.method));

                return init?.method === "POST" ? new Response(null, { headers: { Location: `/hosts/uploads/${UPLOAD_ID}` }, status: 201 }) : new Response(null, { status: 204 });
            }

            return await backend.fetch(url, init);
        };

        return { fetcher: fetcher as typeof fetch, uploads };
    };

    const media = (read: (reference: string) => Promise<unknown>): NonNullable<PosterOptions["media"]> => {
        return { endpoint: new URL("https://backend.test/hosts/uploads"), read: async (_agent, _folder, reference) => (await read(reference)) as never, sign: () => "sig" };
    };

    it("posts a file's event before the end of the turn, and the end last", async () => {
        const { fetcher, uploads } = withUploads();
        const read = vi.fn(async () => PNG);
        const host = poster(media(read), fetcher);

        await open(host);
        host.turnStarted("s1", "t1", "draw");
        host.text("s1", "t1", "Here: ![c](out/chart.png)");
        host.turnEnded("s1", "t1", "end_turn");
        await settle(POST_INTERVAL_MS);
        await settle(POST_INTERVAL_MS);

        expect(read).toHaveBeenCalledExactlyOnceWith("out/chart.png");
        expect(uploads).toEqual(["POST", "PATCH"]);

        const kinds = (backend.chunks.get("t1") ?? []).map((event) => event.kind);

        expect(kinds.slice(-2)).toEqual(["media", "turn_end"]);
        expect(backend.chunks.get("t1")?.at(-2)).toEqual({ contentType: "image/png", kind: "media", name: "chart.png", reference: "out/chart.png", size: 5, uploadId: UPLOAD_ID });
    });

    it("sends the files one to a post, each with its own seq", async () => {
        const { fetcher } = withUploads();
        const host = poster(media(async () => PNG), fetcher);

        await open(host);
        host.turnStarted("s1", "t1", "draw");
        host.text("s1", "t1", "![a](a.png) ![b](b.png)");
        host.turnEnded("s1", "t1", "end_turn");

        for (let step = 0; step < 4; step += 1) {
            await settle(POST_INTERVAL_MS);
        }

        const withFiles = backend.posts.filter(({ post }) => post.turnId === "t1" && post.events.some((event) => event.kind === "media"));

        expect(withFiles).toHaveLength(2);
        expect(withFiles.map(({ post }) => post.events.filter((event) => event.kind === "media").length)).toEqual([1, 1]);
        expect(new Set(withFiles.map(({ post }) => post.firstSeq)).size).toBe(2);
        expect((backend.chunks.get("t1") ?? []).filter((event) => event.kind === "media")).toHaveLength(2);
        expect(backend.chunks.get("t1")?.at(-1)).toEqual({ kind: "turn_end", reason: "finished" });
    });

    it("ends a turn with no image reference at once, without reading anything", async () => {
        const { fetcher, uploads } = withUploads();
        const read = vi.fn(async () => PNG);
        const host = poster(media(read), fetcher);

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "See [the file](notes.md)");
        host.turnEnded("s1", "t1", "end_turn");
        await settle(POST_INTERVAL_MS);

        expect(read).not.toHaveBeenCalled();
        expect(uploads).toEqual([]);
        expect(backend.chunks.get("t1")?.at(-1)).toEqual({ kind: "turn_end", reason: "finished" });
    });

    it("posts nothing for a reference the core refuses, and still ends the turn", async () => {
        const { fetcher, uploads } = withUploads();
        const host = poster(media(async () => ({ kind: "", mime: "", name: "", size: 0, status: "refused" })), fetcher);

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "![a](../secret.png)");
        host.turnEnded("s1", "t1", "end_turn");
        await settle(POST_INTERVAL_MS);
        await settle(POST_INTERVAL_MS);

        expect(uploads).toEqual([]);
        expect((backend.chunks.get("t1") ?? []).map((event) => event.kind)).toEqual(["turn_start", "text", "turn_end"]);
    });

    it("reads nothing for a turn that failed", async () => {
        const { fetcher } = withUploads();
        const read = vi.fn(async () => PNG);
        const host = poster(media(read), fetcher);

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "![a](a.png)");
        host.turnEnded("s1", "t1", "failed", "boom");
        await settle(POST_INTERVAL_MS);

        expect(read).not.toHaveBeenCalled();
        expect(backend.chunks.get("t1")?.at(-1)).toMatchObject({ kind: "turn_end", reason: "failed" });
    });

    it("ends the turn even when reading throws", async () => {
        const { fetcher } = withUploads();
        const host = poster(media(async () => { throw new Error("boom"); }), fetcher);

        await open(host);
        host.turnStarted("s1", "t1", "go");
        host.text("s1", "t1", "![a](a.png)");
        host.turnEnded("s1", "t1", "end_turn");
        await settle(POST_INTERVAL_MS);
        await settle(POST_INTERVAL_MS);

        expect(backend.chunks.get("t1")?.at(-1)).toEqual({ kind: "turn_end", reason: "finished" });
    });
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

        // One open, then a close: the failed open may have reached the backend before the answer was lost.
        expect(backend.posts.filter(({ post }) => post.close !== true)).toHaveLength(1);
        expect(backend.posts.filter(({ post }) => post.close === true)).toHaveLength(1);
        expect(host.busy).toBe(false);
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

        const retrying = poster(undefined, flaky as typeof fetch);

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
        backend.respond = (post) => post.turnId === undefined ? undefined : Response.json({ error: "unauthorized" }, { status: 401 });
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
        backend.respond = (post) => post.close === true ? Response.json({ error: "down" }, { status: 503 }) : undefined;
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
        const host = poster(undefined, async (url, init) => {
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

        backend.respond = (post) => post.close === true ? undefined : Response.json({ error: "no" }, { status: 403 });
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
