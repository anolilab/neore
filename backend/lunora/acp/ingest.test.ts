/**
 * Host turn output against the in-memory harness: the ingest route end to end (flood guard, device route,
 * signature, per-device limit, owner comparisons, claim by `(turnId, seq)`), the host states every client
 * reads, the reply write, the reaper and its cancel, Stop, revoke.
 *
 * The harness is one database for every shard, so "another user's thread is refused" is proven here by the
 * explicit owner comparison in `applyHostEvents`, not by shard isolation.
 */
import { CLOUD_INTERACTIVE_CAPABILITIES, LOCAL_BROWSER_CAPABILITIES } from "@neore/ai/capabilities";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

/** The harness runs a procedure object; production resolves a reference by path (`test/registered-api.ts`). */
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/internal", async (importOriginal) => {
    const { registeredApi } = await import("../../test/registered-api");

    return registeredApi(await importOriginal(), registry);
});

const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const { registerModule } = await import("../../test/registered-api");
const { default: schema } = await import("../schema");
const devices = await import("../devices/functions");
const deviceInternals = await import("../devices/internal");
const streaming = await import("../chat/streaming/index");
const library = await import("../chat/streaming/persistent/library");
const steering = await import("../chat/steering");
const { signDevicePayload } = await import("../devices/lib/signing");
const { floodAllowed, hostIngestHttpAction, readCappedBody, resetFloodGuard, resetOwnerCache } = await import("./http");
const { applyHostEvents, reapHostStreams } = await import("./ingest");
const { createHostStream } = await import("../chat/streaming/persistent/host");
const { getHostSession, getThreadCapabilities, listHostSessions } = await import("./functions");
const agentThreads = await import("../agent/threads");
const composite = await import("../chat/composite");
const { measureDb } = await import("../../test/db-cost");
const { HOST_STREAM_IDLE_MS, HOST_TURN_MAX_MS, INGEST_FLOOD_LIMIT_PER_MINUTE } = await import("./lib/constants");

registerModule(registry, "lib_shard_routes", await import("../lib/shard-routes"));
registerModule(registry, "lib_shard_housekeeping", await import("../lib/shard-housekeeping"));
registerModule(registry, "acp_ingest", await import("./ingest"));
registerModule(registry, "agent_sharing", await import("../agent/sharing"));
registerModule(registry, "agent_streams", await import("../agent/streams"));
registerModule(registry, "chat_streaming_persistent_library", await import("../chat/streaming/persistent/library"));

// Documentation addresses (RFC 5737): the guard only keys on the string.
const FLOODER = "192.0.2.1";
const NEIGHBOUR = "192.0.2.2";
const RESTARTED = /restarted/u;
const STOPPED_SENDING = /stopped sending output/u;
const REMOVED = /was removed/u;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/u;
const CANNOT_STEER = /cannot be steered/u;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let ownerId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertUser = async () =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", { createdAt: 0, email: `u${String(Math.random())}@example.com`, emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;

/** An `HttpActionCtx` over the harness: every shard is the one database. */
const httpContext = () => {
    const runners = {
        runAction: async () => {
            throw new Error("no actions here");
        },
        runMutation: async (ref: never, args: never) => await harness.run(async (ctx: any) => await ctx.runMutation(ref, args)),
        runQuery: async (ref: never, args: never) => await harness.run(async (ctx: any) => await ctx.runQuery(ref, args)),
    };

    return { ...runners, auth: { getIdentity: async () => null, userId: null }, forShard: () => runners } as never;
};

interface Paired {
    deviceId: string;
    secret: string;
    userId: string;
}

const pair = async (userId: string): Promise<Paired> => {
    const { deviceId, secret } = (await as(userId).mutation(devices.registerDevice as never, { name: "Laptop", platform: "linux" } as never)) as {
        deviceId: string;
        secret: string;
    };

    return { deviceId, secret, userId };
};

interface Body {
    events: unknown[];
    firstSeq?: number;
    issuedAt?: number;
    sessionId?: string;
    threadId?: string;
    turnId?: string;
}

const signed = async (device: Paired, body: Body, overrides: { secret?: string } = {}) => {
    const payload = JSON.stringify({ deviceId: device.deviceId, issuedAt: Date.now(), kind: "turn", sessionId: "host-s1", v: 1, ...body });

    return { payload, signature: await signDevicePayload(overrides.secret ?? device.secret, "turn", payload) };
};

const request = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request("https://example.test/hosts/ingest", { body: typeof body === "string" ? body : JSON.stringify(body), headers, method: "POST" });

const ingest = async (device: Paired, body: Body, overrides: { secret?: string } = {}) => {
    const response = await hostIngestHttpAction(httpContext(), request(await signed(device, body, overrides)));

    return { json: (await response.json()) as Record<string, any>, status: response.status };
};

const SESSION_OPEN = { agentKey: "claude", agentLabel: "Claude Code", folderId: "f1", folderLabel: "neore", kind: "session_open" };

const openSession = async (device: Paired) => {
    const result = await ingest(device, { events: [SESSION_OPEN] });

    expect(result.status).toBe(200);

    return result.json.threadId as string;
};

const turn = (device: Paired, threadId: string, turnId: string, firstSeq: number, events: unknown[]) => ingest(device, { events, firstSeq, threadId, turnId });

const START = (text = "fix the bug") => {
    return { kind: "turn_start", text };
};
const TEXT = (text: string) => {
    return { kind: "text", text };
};

/** Spends a device's whole ingest budget, so the next post is over it. */
const spendBudget = async (deviceId: string) =>
    await harness.run(async (ctx: any) => {
        const { checkRateLimit } = await import("../lib/rate-limiter");

        // Big bites first, then smaller, until not even one more is admitted.
        for (const count of [1000, 100, 10, 1]) {
            let admitted = true;

            while (admitted) {
                const result = await checkRateLimit(ctx, "hosts/ingest:free", { count, key: deviceId });

                admitted = result.ok;
            }
        }
    });

const rateLimitRows = async () => (await harness.run(async (ctx: any) => await ctx.db.query("rateLimits").collect())) as unknown[];

const streamFor = async (turnId: string) =>
    (await harness.run(async (ctx: any) => await ctx.db.persistentStreams.findFirst({ where: { hostTurnId: turnId } }))) as Record<string, any> | null;

const pageOf = async (read: (ctx: any) => Promise<{ page: unknown[] }>): Promise<Record<string, any>[]> => {
    const result = (await harness.run(read)) as { page: Record<string, any>[] };

    return result.page;
};

const chunksOf = async (streamId: string) =>
    await pageOf(async (ctx) => await ctx.db.persistentChunks.findMany({ orderBy: [{ seq: "asc" }], where: { streamId } }));

const messagesOf = async (threadId: string) => await pageOf(async (ctx) => await ctx.db.messages.findMany({ where: { threadId } }));

const cancelCalls = async () => await pageOf(async (ctx) => await ctx.db.deviceCalls.findMany({ where: { toolName: "acp_cancel" } }));

const assistantRepliesOf = async (threadId: string) => {
    const rows = await messagesOf(threadId);

    return rows.filter((message) => message.message.role === "assistant");
};

/** One field of the stream a turn made. */
const streamField = async (turnId: string, field: string): Promise<unknown> => {
    const stream = await streamFor(turnId);

    return stream?.[field];
};

const rowField = async (id: string, field: string): Promise<unknown> => {
    const found = await row(id);

    return found?.[field];
};

const rateLimitCount = async (): Promise<number> => {
    const rows = await rateLimitRows();

    return rows.length;
};

const chunkTexts = async (streamId: string): Promise<string[]> => {
    const chunks = await chunksOf(streamId);

    return chunks.map((chunk) => chunk.text);
};

const row = async (id: string) => (await harness.run(async (ctx: any) => await ctx.db.get(id))) as Record<string, any> | null;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    resetFloodGuard();
    resetOwnerCache();
    ownerId = await insertUser();
});

afterEach(() => {
    harness.close();
});

describe("session_open", () => {
    it("creates a host thread and its session, once per desktop session id", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const again = await openSession(device);
        const thread = await row(threadId);

        expect(again).toBe(threadId);
        expect(thread).toMatchObject({ runner: "host", status: "active", userId: ownerId });

        const sessions = (await as(ownerId).query(listHostSessions as never, {} as never)) as Record<string, any>[];

        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ agentKey: "claude", folderLabel: "neore", status: "idle", threadId });
    });

    it("reads back to the owner only", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const stranger = await insertUser();

        await expect(as(ownerId).query(getHostSession as never, { threadId } as never)).resolves.toMatchObject({ threadId });
        await expect(as(stranger).query(getHostSession as never, { threadId } as never)).resolves.toBeNull();
    });
});

describe("capability reports", () => {
    const REPORT = {
        groups: {
            permissions: { modes: ["ask"] },
            streaming: { text: { degradation: "none", supported: true } },
            turns: { cancel: { degradation: "none", supported: true }, followUp: { kind: "queue" } },
        },
        reportedAt: 1_700_000_000_000,
        version: 1,
    };
    const CHANGED = { groups: { turns: { followUp: { degradation: "restart", kind: "steer" } } }, reportedAt: 1_700_000_100_000, version: 1 };
    const UNKNOWN = { groups: {}, reportedAt: 0, version: 1 };

    const openWith = async (device: Paired, capabilities: unknown) => {
        const result = await ingest(device, { events: [{ ...SESSION_OPEN, capabilities }] });

        expect(result.status).toBe(200);

        return result.json.threadId as string;
    };

    const reportOf = async (threadId: string, userId = ownerId) => await as(userId).query(getThreadCapabilities as never, { threadId } as never);

    it("stores the report the host sent, and gives it back to the owner", async () => {
        const device = await pair(ownerId);
        const threadId = await openWith(device, REPORT);
        const session = await harness.run(async (ctx: any) => await ctx.db.acpSessions.findFirst({ where: { threadId } }));

        expect(session).toMatchObject({ capabilities: REPORT });
        await expect(reportOf(threadId)).resolves.toEqual(REPORT);
    });

    it("replaces the stored report wholesale when the host reconnects with a changed one", async () => {
        const device = await pair(ownerId);
        const threadId = await openWith(device, REPORT);

        await expect(openWith(device, CHANGED)).resolves.toBe(threadId);
        await expect(reportOf(threadId)).resolves.toEqual(CHANGED);
    });

    it("keeps the stored report when a reconnect carries none", async () => {
        const device = await pair(ownerId);
        const threadId = await openWith(device, REPORT);

        await ingest(device, { events: [SESSION_OPEN] });
        await expect(reportOf(threadId)).resolves.toEqual(REPORT);
    });

    it.each([
        ["a string", "supports everything"],
        ["a wrong version", { ...REPORT, version: 2 }],
        ["an unknown reason", { groups: { turns: { cancel: { reason: "because", supported: false } } }, reportedAt: 1, version: 1 }],
        ["null", null],
    ])("stores %s as all unknown and still opens the session", async (_name, bad) => {
        const device = await pair(ownerId);
        const threadId = await openWith(device, bad);

        await expect(reportOf(threadId)).resolves.toEqual(UNKNOWN);
    });

    it("answers a host thread that never reported with all unknown", async () => {
        const device = await pair(ownerId);

        await expect(reportOf(await openSession(device))).resolves.toEqual(UNKNOWN);
    });

    it("does not roll the stored report back for an older or replayed open", async () => {
        const device = await pair(ownerId);
        const threadId = await openWith(device, CHANGED);

        await openWith(device, REPORT);
        await expect(reportOf(threadId)).resolves.toEqual(CHANGED);

        await openWith(device, CHANGED);
        await expect(reportOf(threadId)).resolves.toEqual(CHANGED);
    });

    it("keeps a valid stored report when a later open's report is invalid, and lets the next valid one replace the fallback", async () => {
        const device = await pair(ownerId);
        const threadId = await openWith(device, REPORT);

        await openWith(device, "garbage");
        await expect(reportOf(threadId)).resolves.toEqual(REPORT);

        const other = await pair(ownerId);
        const fallback = await ingest(other, { events: [{ ...SESSION_OPEN, capabilities: "garbage" }], sessionId: "host-s2" });
        const fallbackThread = fallback.json.threadId as string;

        await expect(reportOf(fallbackThread)).resolves.toEqual(UNKNOWN);
        await ingest(other, { events: [{ ...SESSION_OPEN, capabilities: REPORT }], sessionId: "host-s2" });
        await expect(reportOf(fallbackThread)).resolves.toEqual(REPORT);
    });

    describe("on a cloud or local thread", () => {
        const insertThread = async (fields: Record<string, unknown> = {}) =>
            (await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("threads", {
                        createdBy: ownerId,
                        mode: "text",
                        status: "active",
                        tags: [],
                        title: "t",
                        updatedAt: Date.now(),
                        userId: ownerId,
                        ...fields,
                    }),
            )) as string;

        const grant = async (threadId: string, userId: string, fields: Record<string, unknown> = {}) =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.db.threadAccess.insert({ grantedAt: Date.now(), grantedBy: ownerId, ownerId, permission: "read", threadId, userId, ...fields }),
            );

        it("answers the owner with the cloud declaration", async () => {
            await expect(reportOf(await insertThread())).resolves.toMatchObject({ groups: { turns: { followUp: { kind: "steer" } } }, version: 1 });
        });

        it("answers a stranger with nothing", async () => {
            await expect(reportOf(await insertThread(), await insertUser())).resolves.toBeNull();
        });

        it("answers a live grantee with the cloud declaration, and an expired one with nothing", async () => {
            const threadId = await insertThread();
            const live = await insertUser();
            const expired = await insertUser();

            await grant(threadId, live);
            await grant(threadId, expired, { expiresAt: Date.now() - 1000 });

            await expect(reportOf(threadId, live)).resolves.toMatchObject({ groups: { turns: { followUp: { kind: "steer" } } } });
            await expect(reportOf(threadId, expired)).resolves.toBeNull();
        });

        it("answers a revoked grantee with nothing", async () => {
            const threadId = await insertThread();
            const grantee = await insertUser();
            const grantId = await grant(threadId, grantee);

            await expect(reportOf(threadId, grantee)).resolves.not.toBeNull();
            await harness.run(async (ctx: any) => await ctx.db.threadAccess.delete(grantId));
            await expect(reportOf(threadId, grantee)).resolves.toBeNull();
        });

        it("answers a viewer of a public-only thread with nothing", async () => {
            const threadId = await insertThread({ isPublic: true });

            await expect(reportOf(threadId, await insertUser())).resolves.toBeNull();
        });

        it("answers nobody, the owner included, for a locked thread", async () => {
            const threadId = await insertThread({ lockedAt: Date.now() });
            const grantee = await insertUser();

            await grant(threadId, grantee);
            await expect(reportOf(threadId)).resolves.toBeNull();
            await expect(reportOf(threadId, grantee)).resolves.toBeNull();
        });

        it("answers the owner of a thread on a local-browser endpoint with the local declaration, by endpoint type", async () => {
            const providers = {
                laptop: { enabled: true, models: [{ id: "shared-name" }], type: "local-browser" },
                hosted: { enabled: true, models: [{ id: "shared-name" }], type: "openai-compatible" },
            };

            await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { customAIProviders: providers, userId: ownerId }));

            const local = await insertThread({ model: "custom:laptop/shared-name" });
            const hosted = await insertThread({ model: "custom:hosted/shared-name" });
            const plain = await insertThread({ model: "shared-name" });

            await expect(reportOf(local)).resolves.toEqual(LOCAL_BROWSER_CAPABILITIES);
            await expect(reportOf(hosted)).resolves.toEqual(CLOUD_INTERACTIVE_CAPABILITIES);
            await expect(reportOf(plain)).resolves.toEqual(CLOUD_INTERACTIVE_CAPABILITIES);
        });
    });

    it("returns nothing to a stranger, for a host thread and an id that does not exist", async () => {
        const device = await pair(ownerId);
        const hostThread = await openWith(device, REPORT);
        const stranger = await insertUser();

        await expect(reportOf(hostThread, stranger)).resolves.toBeNull();
        await expect(reportOf("not-an-id", stranger)).resolves.toBeNull();
    });
});

describe("a host turn", () => {
    it("shows the text so far to a second client, with the host states", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await expect(turn(device, threadId, "t1", 0, [START()])).resolves.toMatchObject({ json: { next: 1 }, status: 200 });

        const stream = await streamFor("t1");

        expect(stream).toMatchObject({ hostState: "received", producer: "host", status: "pending", threadId, userId: ownerId });

        await turn(device, threadId, "t1", 1, [TEXT("Looking at "), { kind: "reasoning", text: "hm" }, TEXT("the code")]);

        // Two clients (a reload, a second browser) read the same live queries.
        for (let client = 0; client < 2; client += 1) {
            const active = (await as(ownerId).query(streaming.getActiveStreamForThread as never, { threadId } as never)) as Record<string, any>;
            const body = (await as(ownerId).query(streaming.getStreamBody as never, { streamId: active.streamId } as never)) as Record<string, any>;

            expect(active).toMatchObject({ hostState: "running", streamId: stream?._id });
            expect(body).toMatchObject({ hostState: "running", reasoning: "hm", status: "streaming", text: "Looking at the code" });
        }
    });

    it("reads back every host state through the live queries a second client uses", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const stateOf = async () => {
            const active = (await as(ownerId).query(streaming.getActiveStreamForThread as never, { threadId } as never)) as Record<string, any> | null;

            if (active === null) {
                return { active, body: null };
            }

            const body = (await as(ownerId).query(streaming.getStreamBody as never, { streamId: active.streamId } as never)) as Record<string, any>;

            return { active, body };
        };

        // `accepted`: the backend stored the turn and queued the call (the remote-control slice does this).
        const prompt = (await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("messages", {
                    message: { content: "hi", role: "user" },
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    text: "hi",
                    threadId,
                    tool: false,
                    userId: ownerId,
                }),
        )) as string;

        await harness.run(async (ctx: any) => {
            await createHostStream(ctx, { hostState: "accepted", messageId: prompt, threadId: threadId as never, turnId: "t1", userId: ownerId }, Date.now());
        });

        const accepted = await stateOf();

        expect(accepted.active).toMatchObject({ hostState: "accepted" });
        expect(accepted.body).toMatchObject({ hostState: "accepted", status: "pending" });

        // The first event the agent sends moves it to `running`.
        await turn(device, threadId, "t1", 0, [TEXT("x")]);

        const running = await stateOf();

        expect(running.body).toMatchObject({ hostState: "running", status: "streaming" });

        // The end: no active stream any more, and the row says `ended`.
        await turn(device, threadId, "t1", 1, [{ kind: "turn_end", reason: "finished" }]);

        const ended = await stateOf();

        expect(ended.active).toBeNull();
        expect(await streamField("t1", "hostState")).toBe("ended");

        // A local prompt is `received` as soon as its turn_start lands.
        await turn(device, threadId, "t2", 0, [START("again")]);

        const received = await stateOf();

        expect(received.body).toMatchObject({ hostState: "received", status: "pending" });
    });

    it("returns a host thread through the procedures the sidebar and the thread page use", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await expect(as(ownerId).query(agentThreads.getThread as never, { threadId } as never)).resolves.toMatchObject({ runner: "host" });

        const list = (await as(ownerId).query(composite.getThreadListData as never, {} as never)) as { threads?: Record<string, any>[] };

        expect(JSON.stringify(list)).toContain(threadId);
    });

    it("writes the stream row only when something it shows changed, not on every text post", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("a")]);

        const { cost } = await measureDb(async () => await turn(device, threadId, "t1", 2, [TEXT("b")]));

        // The read by turn id, and no patch: `getActiveStreamForThread` is live over this table.
        expect(cost.byTable.persistentStreams ?? 0, JSON.stringify(cost.byTable)).toBe(1);
    });

    it("drops a redelivered post and fills a gap from the 409", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("a")]);
        await turn(device, threadId, "t1", 2, [TEXT("b")]);

        const stream = await streamFor("t1");

        // The same post again, and an overlapping one: nothing is written twice.
        await expect(turn(device, threadId, "t1", 2, [TEXT("b")])).resolves.toMatchObject({ json: { next: 3 }, status: 200 });
        await expect(turn(device, threadId, "t1", 1, [TEXT("a"), TEXT("b"), TEXT("c")])).resolves.toMatchObject({ json: { next: 4 }, status: 200 });
        expect(await chunkTexts(stream?._id)).toEqual(["", "a", "b", "c"]);

        // A post that skips a seq answers 409 with where to resume, and writes nothing.
        const gap = await turn(device, threadId, "t1", 9, [TEXT("z")]);

        expect(gap).toMatchObject({ json: { next: 4 }, status: 409 });
        expect(await chunksOf(stream?._id)).toHaveLength(4);
        await expect(turn(device, threadId, "t1", 4, [TEXT("d")])).resolves.toMatchObject({ json: { next: 5 }, status: 200 });
    });

    it("saves the reply on turn_end, ends the stream and frees the session", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [
            START("hello"),
            TEXT("Done."),
            { kind: "reasoning", text: "thought" },
            { kind: "turn_end", reason: "finished" },
        ]);

        const stream = await streamFor("t1");
        const rows = await messagesOf(threadId);
        const reply = rows.find((message) => message.message.role === "assistant");

        expect(stream).toMatchObject({ hostEndReason: "finished", hostState: "ended", status: "done" });
        expect(rows.find((message) => message.message.role === "user")?.text).toBe("hello");
        expect(reply).toMatchObject({ provider: "acp-host", reasoning: "thought", status: "success" });
        expect(reply?.message.content).toEqual([{ text: "Done.", type: "text" }]);
        expect(await row(threadId)).toMatchObject({ status: "active" });
        await expect(as(ownerId).query(streaming.getActiveStreamForThread as never, { threadId } as never)).resolves.toBeNull();

        // A redelivery of the whole post, and anything after the end, changes nothing.
        await expect(turn(device, threadId, "t1", 0, [START("hello"), TEXT("Done.")])).resolves.toMatchObject({ json: { ended: true }, status: 200 });
        expect(await messagesOf(threadId)).toHaveLength(2);
    });

    it("ends an interrupted turn as a failed reply that says why", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("half"), { kind: "turn_end", reason: "interrupted" }]);

        const stream = await streamFor("t1");
        const [reply] = await assistantRepliesOf(threadId);

        expect(stream).toMatchObject({ hostEndReason: "interrupted", hostState: "ended", status: "error" });
        expect(reply).toMatchObject({ status: "failed" });
        expect(reply?.error).toMatch(RESTARTED);
    });

    it("saves a regenerate beside the earlier reply, as a sibling", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START("question"), TEXT("first answer"), { kind: "turn_end", reason: "finished" }]);

        const first = await streamFor("t1");
        const promptId = first?.messageId as string;

        // The backend queues a regenerate for the same prompt (the remote-control slice does this through /hosts/send).
        await harness.run(async (ctx: any) => {
            await createHostStream(
                ctx,
                { hostState: "accepted", messageId: promptId, regenerate: true, threadId: threadId as never, turnId: "t2", userId: ownerId },
                Date.now(),
            );
        });
        await turn(device, threadId, "t2", 0, [TEXT("second answer"), { kind: "turn_end", reason: "finished" }]);

        const replies = await assistantRepliesOf(threadId);
        const [older, newer] = replies.toSorted((a, b) => a._creationTime - b._creationTime);

        expect(replies).toHaveLength(2);
        expect(older?.order).toBe(newer?.order);
        expect(newer?.parentMessageId).toBe(promptId);
        expect(await rowField(threadId, "activeLeafMessageId")).toBe(newer?._id);
        expect(newer?.message.content).toEqual([{ text: "second answer", type: "text" }]);
    });

    it("tracks the permission requests the agent is waiting on", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const askForTool = { kind: "permission_request", options: [{ kind: "allow_once", name: "Allow", optionId: "o1" }], requestId: "r1", tool: "Bash" };

        await turn(device, threadId, "t1", 0, [START(), askForTool]);
        expect(await streamField("t1", "hostPendingPermissions")).toEqual(["r1"]);

        await turn(device, threadId, "t1", 2, [{ kind: "permission_resolved", outcome: "allowed", requestId: "r1" }]);
        expect(await streamField("t1", "hostPendingPermissions")).toBeUndefined();
    });
});

describe("ingest refusals", () => {
    const authFailures = async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const stranger = await insertUser();
        const other = await pair(stranger);

        return { device, other, strangerId: stranger, threadId };
    };

    it("answers 401 to an unknown device, a revoked one, a bad signature and a stale post, and moves no limit", async () => {
        const { device, other, strangerId, threadId } = await authFailures();
        const events = [START()];

        // The revoke is a client call with a limit of its own; do it first so only the posts are measured.
        await as(strangerId).mutation(devices.revokeDevice as never, { deviceId: other.deviceId } as never);
        resetOwnerCache();

        const rowsBefore = await rateLimitCount();

        const unknown = { ...device, deviceId: "no-such-device" };

        await expect(turn(unknown, threadId, "t1", 0, events)).resolves.toMatchObject({ status: 401 });

        const forged = await ingest(device, { events, firstSeq: 0, threadId, turnId: "t1" }, { secret: "f".repeat(64) });

        expect(forged.status).toBe(401);

        const stale = await ingest(device, { events, firstSeq: 0, issuedAt: Date.now() - 60 * 60_000, threadId, turnId: "t1" });

        expect(stale.status).toBe(401);

        await expect(turn(other, threadId, "t1", 0, events)).resolves.toMatchObject({ status: 401 });

        expect(await streamFor("t1")).toBeNull();
        expect(await rateLimitCount()).toBe(rowsBefore);
    });

    it("answers 401 to a body that is not a signed post, 413 past the cap", async () => {
        await expect(hostIngestHttpAction(httpContext(), request("not json"))).resolves.toHaveProperty("status", 401);
        await expect(hostIngestHttpAction(httpContext(), request({ payload: "{}", signature: "x" }))).resolves.toHaveProperty("status", 401);
        await expect(hostIngestHttpAction(httpContext(), request("x".repeat(300 * 1024)))).resolves.toHaveProperty("status", 413);
    });

    it("answers 401 to a signature that is not 64 hex characters, before any device is looked up", async () => {
        const device = await pair(ownerId);
        const { payload } = await signed(device, { events: [START()] });
        let lookups = 0;
        const context = httpContext() as unknown as { runQuery: (ref: never, args: never) => Promise<unknown> };
        const counted = {
            ...context,
            runQuery: async (ref: never, args: never) => {
                lookups += 1;

                return await context.runQuery(ref, args);
            },
        } as never;

        for (const signature of ["a".repeat(65), "a".repeat(5000), "g".repeat(64), ""]) {
            const response = await hostIngestHttpAction(counted, request({ payload, signature }));

            expect(response.status).toBe(401);
        }

        expect(lookups).toBe(0);
    });

    it("answers 400 to a session, turn or thread id past 128 characters", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const long = "x".repeat(129);

        await expect(ingest(device, { events: [SESSION_OPEN], sessionId: long })).resolves.toMatchObject({ status: 400 });
        await expect(turn(device, threadId, long, 0, [START()])).resolves.toMatchObject({ status: 400 });
        await expect(turn(device, long, "t1", 0, [START()])).resolves.toMatchObject({ status: 400 });
    });

    it("counts the body, not the Content-Length the sender claims", async () => {
        const big = request("y".repeat(300 * 1024), { "content-length": "10" });

        await expect(readCappedBody(big, 256 * 1024)).resolves.toBeNull();
        await expect(readCappedBody(request("small"), 256 * 1024)).resolves.toBe("small");
    });

    it("stops an address that floods before any database is touched", () => {
        const now = Date.now();

        for (let count = 0; count < INGEST_FLOOD_LIMIT_PER_MINUTE; count += 1) {
            expect(floodAllowed(FLOODER, now)).toBe(true);
        }

        expect(floodAllowed(FLOODER, now)).toBe(false);
        expect(floodAllowed(NEIGHBOUR, now)).toBe(true);
        expect(floodAllowed(FLOODER, now + 61_000)).toBe(true);
    });

    it("refuses a post into another user's thread, and into a thread that is not a host thread", async () => {
        const { device, other, threadId } = await authFailures();
        const strangerThread = await openSession(other);
        const cloudThread = (await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "cloud", userId: ownerId }),
        )) as string;

        // The owner's device names the stranger's thread (its own session id), the stranger's device names the owner's.
        await expect(turn(device, strangerThread, "t1", 0, [START("hijack")])).resolves.toMatchObject({ status: 403 });
        await expect(turn(other, threadId, "t2", 0, [START("hijack")])).resolves.toMatchObject({ status: 403 });
        await expect(turn(device, cloudThread, "t3", 0, [START("hijack")])).resolves.toMatchObject({ status: 403 });

        expect(await streamFor("t1")).toBeNull();
        expect(await streamFor("t2")).toBeNull();
        expect(await streamFor("t3")).toBeNull();
        expect(await messagesOf(strangerThread)).toHaveLength(0);
        expect(await messagesOf(threadId)).toHaveLength(0);
    });

    it("answers 429 once the verified device spends its budget", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await spendBudget(device.deviceId);
        await expect(turn(device, threadId, "t1", 0, [START()])).resolves.toMatchObject({ status: 429 });
        expect(await streamFor("t1")).toBeNull();
    });

    it("refuses a turn that does not begin with the user's prompt", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await expect(turn(device, threadId, "t1", 0, [TEXT("no prompt")])).resolves.toMatchObject({ status: 403 });
        await expect(turn(device, threadId, "t1", 3, [START()])).resolves.toMatchObject({ status: 403 });
    });
});

describe("the reaper", () => {
    const expire = async (turnId: string, at: number) =>
        await harness.run(async (ctx: any) => {
            const stream = await ctx.db.persistentStreams.findFirst({ where: { hostTurnId: turnId } });

            await ctx.db.patch(stream._id, { expiresAt: at });
        });

    const reap = async () => await harness.run(async (ctx: any) => await ctx.runMutation(reapHostStreams, {}));

    it("times out a silent stream, sends the host a signed cancel, and drops what arrives later", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("working")]);
        await expire("t1", Date.now() - 1000);
        await reap();

        const stream = await streamFor("t1");
        const [call] = await cancelCalls();

        expect(stream).toMatchObject({ hostEndReason: "timeout", hostState: "ended", status: "timeout" });
        expect(await row(threadId)).toMatchObject({ status: "active" });

        // What the host wrote stays in the thread, as a failed reply that says why it stopped.
        const [reply, ...others] = await assistantRepliesOf(threadId);

        expect(others).toHaveLength(0);
        expect(reply).toMatchObject({ finishReason: "error", status: "failed" });
        expect(reply?.message.content).toEqual([{ text: "working", type: "text" }]);
        expect(reply?.error).toMatch(STOPPED_SENDING);
        expect(call).toMatchObject({ deviceId: device.deviceId, status: "pending", toolName: "acp_cancel" });
        expect(JSON.parse(call?.envelope)).toMatchObject({ input: { sessionId: "host-s1", turnId: "t1" }, kind: "call", tool: "acp_cancel" });
        expect(call?.signature).toMatch(HEX_SIGNATURE);

        const late = await turn(device, threadId, "t1", 2, [TEXT("late")]);

        expect(late).toMatchObject({ json: { ended: true }, status: 200 });
        expect(await chunksOf(stream?._id)).toHaveLength(2);
    });

    it("saves a failed reply even when the silent turn wrote nothing", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START()]);
        await expire("t1", Date.now() - 1000);
        await reap();

        const [reply] = await assistantRepliesOf(threadId);

        expect(reply).toMatchObject({ finishReason: "error", status: "failed" });
        expect(reply?.error).toMatch(STOPPED_SENDING);
    });

    it("a restart that follows the reaper moves the end reason to interrupted without a second reply", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("half")]);
        await expire("t1", Date.now() - 1000);
        await reap();

        const before = await messagesOf(threadId);

        // The desktop's next start ends the turn it left behind, with a probe far past the end.
        const late = await turn(device, threadId, "t1", 1_000_000_000, [{ kind: "turn_end", reason: "interrupted" }]);

        expect(late).toMatchObject({ json: { ended: true }, status: 200 });
        expect(await streamFor("t1")).toMatchObject({ hostEndReason: "interrupted", hostState: "ended", status: "timeout" });
        expect(await messagesOf(threadId)).toHaveLength(before.length);
    });

    it("keeps every chunk of a turn longer than one page when it saves the reply", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const texts = Array.from({ length: 450 }, (_, index) => TEXT(String(index % 10)));

        await turn(device, threadId, "t1", 0, [START(), ...texts, { kind: "turn_end", reason: "finished" }]);

        const [reply] = await assistantRepliesOf(threadId);

        expect(reply?.message.content).toEqual([{ text: texts.map((event) => event.text).join(""), type: "text" }]);
    });

    it("keeps a stopped turn's end reason when the host's end arrives afterwards", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("x")]);
        await harness.run(async (ctx: any) => await ctx.runMutation(library.stopActiveForThread, { threadId }));
        await turn(device, threadId, "t1", 2, [{ kind: "turn_end", reason: "interrupted" }]);

        expect(await streamField("t1", "hostEndReason")).toBe("stopped");
    });

    it("leaves a stream that is waiting on a permission answer alone, and moves its window on", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [
            START(),
            { kind: "permission_request", options: [{ kind: "allow_once", name: "Allow", optionId: "o1" }], requestId: "r1", tool: "Bash" },
        ]);
        await expire("t1", Date.now() - 1000);
        await reap();

        const stream = await streamFor("t1");

        expect(stream?.status).toBe("streaming");
        expect(stream?.expiresAt).toBeGreaterThan(Date.now());
        expect(await cancelCalls()).toHaveLength(0);

        // Not for ever: a turn older than the cap is timed out whatever it waits on.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch(stream?._id, { expiresAt: Date.now() - 1000 });
        });
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + HOST_TURN_MAX_MS + 1000);

        try {
            await reap();
        } finally {
            vi.useRealTimers();
        }

        expect(await streamField("t1", "status")).toBe("timeout");
    });

    it("moves the window on only once half of it is gone, so the stream row is not written per post", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("a")]);

        const first = await streamFor("t1");

        await turn(device, threadId, "t1", 2, [TEXT("b")]);
        expect(await streamField("t1", "expiresAt")).toBe(first?.expiresAt);

        await expire("t1", Date.now() + HOST_STREAM_IDLE_MS / 4);
        await turn(device, threadId, "t1", 3, [TEXT("c")]);
        expect(await streamField("t1", "expiresAt")).toBeGreaterThan(Date.now() + HOST_STREAM_IDLE_MS / 2);
    });
});

describe("stopping and revoking", () => {
    it("Stop keeps the text written so far, ends the stream and queues a cancel for the host", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("partial")]);
        await harness.run(async (ctx: any) => await ctx.runMutation(library.stopActiveForThread, { threadId }));

        const stream = await streamFor("t1");
        const [reply] = await assistantRepliesOf(threadId);
        const calls = await cancelCalls();

        expect(stream).toMatchObject({ hostEndReason: "stopped", hostState: "ended", status: "done" });
        expect(reply?.message.content).toEqual([{ text: "partial", type: "text" }]);
        expect(calls).toHaveLength(1);
        // The host's own end arrives afterwards and changes nothing.
        await expect(turn(device, threadId, "t1", 2, [{ kind: "turn_end", reason: "cancelled" }])).resolves.toMatchObject({ json: { ended: true } });
        expect(await messagesOf(threadId)).toHaveLength(2);
    });

    it("a revoke ends the device's sessions and open host streams in the same call", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("busy")]);
        await as(ownerId).mutation(devices.revokeDevice as never, { deviceId: device.deviceId } as never);

        expect(await streamFor("t1")).toMatchObject({ hostEndReason: "revoked", hostState: "ended", status: "error" });

        const [reply] = await assistantRepliesOf(threadId);

        expect(reply).toMatchObject({ finishReason: "error", status: "failed" });
        expect(reply?.message.content).toEqual([{ text: "busy", type: "text" }]);
        expect(reply?.error).toMatch(REMOVED);
        await expect(as(ownerId).query(getHostSession as never, { threadId } as never)).resolves.toMatchObject({ status: "ended" });
        expect(await row(threadId)).toMatchObject({ status: "active" });
    });

    it("a coding agent's turn takes no steer", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("busy")]);

        const stream = await streamFor("t1");

        await expect(as(ownerId).mutation(steering.steerRun as never, { streamId: stream?._id, text: "also this", threadId } as never)).rejects.toThrow(
            CANNOT_STEER,
        );
    });
});

describe("device routes", () => {
    const routeOf = async (deviceId: string) =>
        (await harness.run(async (ctx: any) => await ctx.db.shardRoutes.findFirst({ where: { key: `device:${deviceId}` } }))) as Record<string, any> | null;

    it("pairing writes the route, a heartbeat restores a missing one, revoking deletes it", async () => {
        const device = await pair(ownerId);

        expect(await routeOf(device.deviceId)).toMatchObject({ ownerId });

        // A device paired before the ingest existed.
        await harness.run(async (ctx: any) => {
            const route = await ctx.db.shardRoutes.findFirst({ where: { key: `device:${device.deviceId}` } });

            await ctx.db.delete(route._id);
        });
        expect(await routeOf(device.deviceId)).toBeNull();

        // The in-isolate recheck throttle is per device id; a fresh id on a fresh isolate is what a real beat is.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 11 * 60_000);

        try {
            await as(ownerId).mutation(devices.heartbeatDevice as never, { deviceId: device.deviceId } as never);
        } finally {
            vi.useRealTimers();
        }

        expect(await routeOf(device.deviceId)).toMatchObject({ ownerId });

        await as(ownerId).mutation(devices.revokeDevice as never, { deviceId: device.deviceId } as never);
        expect(await routeOf(device.deviceId)).toBeNull();
    });
});

describe("acp calls", () => {
    it("have their own claim window and open-call budget", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("x")]);
        await harness.run(async (ctx: any) => await ctx.runMutation(library.stopActiveForThread, { threadId }));

        const [call] = await cancelCalls();

        // 30 s old: past a device tool's 20 s window, inside an acp call's 60 s.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch(call?._id, { createdAt: Date.now() - 30_000 });
        });
        await expect(as(ownerId).mutation(devices.claimDeviceCall as never, { callId: call?._id, deviceId: device.deviceId } as never)).resolves.toEqual({
            claimed: true,
        });
    });

    it("do not count against the device tools' budget", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("x")]);
        await harness.run(async (ctx: any) => await ctx.runMutation(library.stopActiveForThread, { threadId }));

        // The cancel is open; a device tool call is still admitted (here refused only for the missing tool).
        const result = (await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(deviceInternals.createDeviceCall, {
                    deviceId: device.deviceId,
                    input: "{}",
                    taintedBy: [],
                    threadId,
                    toolName: "fs_read",
                    userId: ownerId,
                }),
        )) as { error?: string };

        expect(result.error).not.toBe("busy");
    });
});

describe("the apply mutation", () => {
    it("is rate limited per device before it reads anything else", async () => {
        const device = await pair(ownerId);

        await spendBudget(device.deviceId);

        const result = await harness.run(
            async (ctx: any) => await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [SESSION_OPEN], sessionId: "s" }),
        );

        expect(result).toEqual({ outcome: "limited" });
    });
});
