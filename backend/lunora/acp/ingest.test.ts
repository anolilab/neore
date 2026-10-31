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

/** The storage-backed finalize: the real one needs a bucket, so a test says what it answers. */
const stagedFinalize = vi.hoisted(() => vi.fn());

vi.mock("../lib/chat-upload", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/chat-upload")>()), finalizeStagedUploadFile: stagedFinalize };
});

/**
 * Signed host routes cross to the owner's shard as the system (`systemRunners` → `callOnShard`), past the
 * request's own runners: route those calls through the same runners the test's `httpContext` has, so the
 * finalize stub and the failing mutation still apply.
 */
vi.mock("../lib/cross-shard", () => {
    return {
        callOnShard: async (reference: { __lunoraRef?: string; kind?: string }, args: never) => {
            const registered = reference.kind === undefined ? await import("../_generated/functions") : undefined;
            const kind = reference.kind ?? registered?.LUNORA_FUNCTIONS[reference.__lunoraRef ?? ""]?.kind;
            const runners = httpContext() as unknown as Record<"runAction" | "runMutation" | "runQuery", (r: unknown, a: never) => Promise<unknown>>;
            const methods: Record<string, "runAction" | "runMutation"> = { action: "runAction", mutation: "runMutation" };

            return await runners[methods[kind ?? ""] ?? "runQuery"](reference, args);
        },
    };
});

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
const { deleteSessionsOfThread, getHostSession, getThreadCapabilities, listHostSessions } = await import("./functions");
const { collectAcpSessionsForExport } = await import("./gdpr");
const agentThreads = await import("../agent/threads");
const composite = await import("../chat/composite");
const { measureDb } = await import("../../test/db-cost");
const { HOST_STREAM_IDLE_MS, HOST_TURN_MAX_MS, INGEST_FLOOD_LIMIT_PER_MINUTE, MAX_IMPORT_TURNS } = await import("./lib/constants");
const { streamLogger } = await import("../lib/logger");
const { MAX_OPEN_ACP_CALLS_PER_DEVICE, MAX_OPEN_ACP_CANCELS_PER_DEVICE } = await import("../devices/lib/constants");

registerModule(registry, "lib_shard_routes", await import("../lib/shard-routes"));
registerModule(registry, "lib_shard_housekeeping", await import("../lib/shard-housekeeping"));
registerModule(registry, "acp_ingest", await import("./ingest"));
registerModule(registry, "acp_upload", await import("./upload"));
registerModule(registry, "lib_action_cache", await import("../lib/action-cache"));
registerModule(registry, "agent_sharing", await import("../agent/sharing"));
registerModule(registry, "agent_streams", await import("../agent/streams"));
registerModule(registry, "chat_streaming_persistent_library", await import("../chat/streaming/persistent/library"));

// Documentation addresses (RFC 5737): the guard only keys on the string.
const FLOODER = "192.0.2.1";
const NEIGHBOUR = "192.0.2.2";
const HOST_TEXT = { neore: { runner: "host" } };
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

/** Makes the next `applyHostEvents` throw, as a failing mutation or a lost response would. */
let failApply = false;

/** What the next `finalizeHostUpload` answers; `undefined` means no action may run. */
let finalizeStub: ((args: { filename: string; uploadId: string; userId: string }) => Promise<unknown>) | undefined;

/** An `HttpActionCtx` over the harness: every shard is the one database. */
const httpContext = () => {
    const runners = {
        runAction: async (_ref: never, args: never) => {
            if (!finalizeStub) {
                throw new Error("no actions here");
            }

            return await finalizeStub(args);
        },
        runMutation: async (ref: never, args: never) => {
            if (failApply && ref === (applyHostEvents as never)) {
                failApply = false;

                throw new Error("the mutation failed");
            }

            return await harness.run(async (ctx: any) => await ctx.runMutation(ref, args));
        },
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
    close?: boolean;
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
    finalizeStub = undefined;
    failApply = false;
    stagedFinalize.mockReset();
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

    it("keeps the stored report when another one carries the same time, and cannot be shut out by a future-dated one", async () => {
        const device = await pair(ownerId);
        const threadId = await openWith(device, REPORT);

        // Same time, different content: the stored one stays.
        await openWith(device, { ...CHANGED, reportedAt: REPORT.reportedAt });
        await expect(reportOf(threadId)).resolves.toEqual(REPORT);

        // A report dated far ahead of this clock is stored as of now, so the next real one still replaces it.
        await openWith(device, { ...CHANGED, reportedAt: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 });
        await expect(reportOf(threadId)).resolves.toMatchObject({ groups: CHANGED.groups });
        await openWith(device, { ...REPORT, reportedAt: Date.now() + 1000 });
        await expect(reportOf(threadId)).resolves.toMatchObject({ groups: REPORT.groups });
    });

    it("clamps a future-dated report on the first open too, so the next real one still replaces it", async () => {
        const device = await pair(ownerId);
        const before = Date.now();
        const threadId = await openWith(device, { ...REPORT, reportedAt: before + 10 * 365 * 24 * 60 * 60 * 1000 });
        const first = (await reportOf(threadId)) as { reportedAt: number };

        expect(first.reportedAt).toBeLessThanOrEqual(Date.now());
        await openWith(device, { ...CHANGED, reportedAt: Date.now() + 1000 });
        await expect(reportOf(threadId)).resolves.toMatchObject({ groups: CHANGED.groups });
    });

    it("stores a new session's future-dated report as of now, so the next real one replaces it", async () => {
        const device = await pair(ownerId);
        const threadId = await openWith(device, { ...CHANGED, reportedAt: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 });

        await expect(reportOf(threadId)).resolves.toMatchObject({ groups: CHANGED.groups });
        await openWith(device, { ...REPORT, reportedAt: Date.now() + 1000 });
        await expect(reportOf(threadId)).resolves.toMatchObject({ groups: REPORT.groups });
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

        it("answers a live grantee of a host thread with nothing, and the owner with its report", async () => {
            const device = await pair(ownerId);
            const threadId = await openWith(device, REPORT);
            const grantee = await insertUser();

            await grant(threadId, grantee);
            await expect(reportOf(threadId, grantee)).resolves.toBeNull();
            await expect(reportOf(threadId)).resolves.toEqual(REPORT);
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
                hosted: { enabled: true, models: [{ id: "shared-name" }], type: "openai-compatible" },
                laptop: { enabled: true, models: [{ id: "shared-name" }], type: "local-browser" },
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

const IMPORT_OPEN = {
    agentKey: "claude",
    agentLabel: "Claude Code",
    folderId: "f1",
    folderLabel: "neore",
    kind: "import_open",
    nativeSessionId: "native-1",
};
const IMPORT_TURN = (user: string, text: string, reasoning?: string) => {
    return { kind: "import_turn", text, user, ...(reasoning !== undefined && { reasoning }) };
};
const IMPORT_END = { kind: "import_end" };

/** What a host does for one saved session: open, post its turns in batches, end. Returns the thread and what the open said. */
const importSession = async (device: Paired, turns: ReturnType<typeof IMPORT_TURN>[], open: Record<string, unknown> = {}) => {
    const sessionId = "import-1";
    const opened = await ingest(device, { events: [{ ...IMPORT_OPEN, ...open }], sessionId });

    if (opened.status !== 200 || opened.json.ended === true) {
        return { opened, threadId: opened.json.threadId as string };
    }

    const threadId = opened.json.threadId as string;
    const sent = await ingest(device, { events: [...turns.slice(opened.json.next), IMPORT_END], firstSeq: opened.json.next, sessionId, threadId });

    return { opened, sent, threadId };
};

const transcriptOf = async (threadId: string) => {
    const rows = await messagesOf(threadId);

    return rows
        .toSorted((a, b) => a.order - b.order || a.stepOrder - b.stepOrder)
        .map((message) => {
            const content = message.message.content as string | { text: string }[];

            return [message.message.role, typeof content === "string" ? content : content.map((part) => part.text).join("")];
        });
};

const sessionRows = async () => await pageOf(async (ctx) => await ctx.db.acpSessions.findMany({}));

const threadRows = async () => await pageOf(async (ctx) => await ctx.db.threads.findMany({}));

describe("importing an agent's saved session", () => {
    const TURNS = [IMPORT_TURN("fix the bug", "Done.", "thinking"), IMPORT_TURN("and the tests", "Tests too.")];

    it("writes the transcript as a host thread, in order, with the native id on the session", async () => {
        const device = await pair(ownerId);
        const { opened, sent, threadId } = await importSession(device, TURNS, { title: "Fix the bug" });

        expect(opened.json).toMatchObject({ ended: false, existing: false, next: 0 });
        expect(sent?.json).toMatchObject({ ended: true, next: 2 });
        await expect(row(threadId)).resolves.toMatchObject({ runner: "host", title: "Fix the bug", userId: ownerId });
        await expect(transcriptOf(threadId)).resolves.toEqual([
            ["user", "fix the bug"],
            ["assistant", "Done."],
            ["user", "and the tests"],
            ["assistant", "Tests too."],
        ]);
        expect(await sessionRows()).toMatchObject([
            { agentKey: "claude", importedTurns: 2, importState: "done", nativeSessionId: "native-1", status: "ended", threadId },
        ]);
        expect(await assistantRepliesOf(threadId)).toHaveLength(2);
    });

    it("yields one thread when the same session is imported twice", async () => {
        const device = await pair(ownerId);
        const first = await importSession(device, TURNS);
        const again = await importSession(device, TURNS);

        expect(again.opened.json).toMatchObject({ ended: true, existing: true, next: 2, threadId: first.threadId });
        expect(await threadRows()).toHaveLength(1);
        expect(await sessionRows()).toHaveLength(1);
        expect(await messagesOf(first.threadId)).toHaveLength(4);
    });

    it("yields one thread and one copy of the transcript when two imports run at once", async () => {
        const device = await pair(ownerId);
        const [a, b] = await Promise.all([importSession(device, TURNS), importSession(device, TURNS)]);

        expect(a.threadId).toBe(b.threadId);
        expect(await threadRows()).toHaveLength(1);
        expect(await sessionRows()).toHaveLength(1);
        await expect(transcriptOf(a.threadId)).resolves.toHaveLength(4);
    });

    it("finds a session that ran here, and writes nothing into it", async () => {
        const device = await pair(ownerId);
        const live = await ingest(device, { events: [{ ...SESSION_OPEN, nativeSessionId: "native-1" }], sessionId: "live-1" });
        const imported = await importSession(device, TURNS);

        expect(imported.opened.json).toMatchObject({ ended: true, existing: true, threadId: live.json.threadId });
        expect(await threadRows()).toHaveLength(1);
        expect(await messagesOf(live.json.threadId)).toHaveLength(0);
        await expect(
            ingest(device, { events: [IMPORT_TURN("x", "y")], firstSeq: 0, sessionId: "live-1", threadId: live.json.threadId }),
        ).resolves.toMatchObject({ status: 403 });
    });

    it("learns the native id of a session the web started, when the host opens it", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await ingest(device, { events: [{ ...SESSION_OPEN, nativeSessionId: "native-1" }] });

        expect(await sessionRows()).toMatchObject([{ nativeSessionId: "native-1", threadId }]);
        await expect(importSession(device, TURNS)).resolves.toMatchObject({ opened: { json: { existing: true, threadId } } });
    });

    it("gives each user their own thread for the same agent session id", async () => {
        const other = await insertUser();
        const mine = await importSession(await pair(ownerId), TURNS);
        const theirs = await importSession(await pair(other), TURNS);

        expect(mine.threadId).not.toBe(theirs.threadId);
        expect(await threadRows()).toHaveLength(2);
    });

    it("keeps an agent's two sessions apart", async () => {
        const device = await pair(ownerId);
        const one = await importSession(device, TURNS);
        const two = await importSession(device, TURNS, { nativeSessionId: "native-2" });

        expect(one.threadId).not.toBe(two.threadId);
    });

    it("drops turns it holds and answers a gap with where to send from", async () => {
        const device = await pair(ownerId);
        const sessionId = "import-1";
        const { json } = await ingest(device, { events: [IMPORT_OPEN], sessionId });
        const { threadId } = json;

        await expect(ingest(device, { events: [IMPORT_TURN("c", "d")], firstSeq: 1, sessionId, threadId })).resolves.toMatchObject({
            json: { next: 0 },
            status: 409,
        });
        await ingest(device, { events: [IMPORT_TURN("a", "b")], firstSeq: 0, sessionId, threadId });
        // A resend that overlaps what is held writes only the new turn.
        await expect(
            ingest(device, { events: [IMPORT_TURN("a", "b"), IMPORT_TURN("c", "d"), IMPORT_END], firstSeq: 0, sessionId, threadId }),
        ).resolves.toMatchObject({
            json: { ended: true, next: 2 },
            status: 200,
        });
        await expect(transcriptOf(threadId)).resolves.toHaveLength(4);
    });

    it("refuses a post that mixes a turn's events with an import's, and one into another user's thread", async () => {
        const device = await pair(ownerId);
        const { threadId } = await importSession(device, TURNS);
        const stranger = await pair(await insertUser());

        await expect(ingest(device, { events: [IMPORT_TURN("a", "b"), TEXT("x")], firstSeq: 0, sessionId: "import-1", threadId })).resolves.toMatchObject({
            status: 403,
        });
        await expect(ingest(stranger, { events: [IMPORT_TURN("a", "b")], firstSeq: 2, sessionId: "import-1", threadId })).resolves.toMatchObject({
            status: 403,
        });
        await expect(ingest(device, { events: [IMPORT_TURN("a", "b")], firstSeq: 0, sessionId: "import-1", threadId, turnId: "t1" })).resolves.toMatchObject({
            status: 200,
        });
        await expect(messagesOf(threadId)).resolves.toHaveLength(4);
    });

    it("keeps a turn post from writing into an imported thread", async () => {
        const device = await pair(ownerId);
        const { threadId } = await importSession(device, TURNS);

        await expect(turn(device, threadId, "t9", 0, [START()])).resolves.toMatchObject({ status: 403 });
    });

    it("keeps the session of a soft-deleted thread, and imports again only once the thread is gone for good", async () => {
        const device = await pair(ownerId);
        const first = await importSession(device, TURNS);

        await harness.run(async (ctx: any) => await ctx.db.patch(first.threadId, { deleted: true }));

        // Undo must still find the session: nothing is deleted and no second thread is made.
        const second = await importSession(device, TURNS);

        expect(second.threadId).toBe(first.threadId);
        expect(second.opened.json).toMatchObject({ ended: true, existing: true });
        expect(await sessionRows()).toHaveLength(1);

        await harness.run(async (ctx: any) => {
            await ctx.runMutation(deleteSessionsOfThread, { threadId: first.threadId });
            await ctx.db.delete(first.threadId);
        });
        expect(await sessionRows()).toHaveLength(0);

        const third = await importSession(device, TURNS);

        expect(third.threadId).not.toBe(first.threadId);
        await expect(transcriptOf(third.threadId)).resolves.toHaveLength(4);

        // A session left behind by anything else than a delete is replaced all the same.
        await harness.run(async (ctx: any) => await ctx.db.delete(third.threadId));

        const fourth = await importSession(device, TURNS);

        expect(fourth.threadId).not.toBe(third.threadId);
    });

    it("replaces the session of a thread that vanished without it", async () => {
        const device = await pair(ownerId);
        const first = await importSession(device, TURNS);

        await harness.run(async (ctx: any) => await ctx.db.delete(first.threadId));

        const second = await importSession(device, TURNS);

        expect(second.threadId).not.toBe(first.threadId);
        expect(await sessionRows()).toHaveLength(1);
    });

    it("does not restart an import whose thread was soft-deleted mid-way", async () => {
        const device = await pair(ownerId);
        const sessionId = "import-1";
        const { json } = await ingest(device, { events: [IMPORT_OPEN], sessionId });

        await ingest(device, { events: [IMPORT_TURN("fix the bug", "Done.")], firstSeq: 0, sessionId, threadId: json.threadId });
        await harness.run(async (ctx: any) => await ctx.db.patch(json.threadId, { deleted: true }));
        await expect(
            ingest(device, { events: [IMPORT_TURN("and the tests", "Tests too."), IMPORT_END], firstSeq: 1, sessionId, threadId: json.threadId }),
        ).resolves.toMatchObject({
            status: 403,
        });

        const again = await importSession(device, TURNS);

        expect(again.threadId).toBe(json.threadId);
        expect(again.opened.json).toMatchObject({ ended: true, existing: true });
        expect(await sessionRows()).toHaveLength(1);
    });

    it("lets another computer of the same user finish an unfinished import", async () => {
        const first = await pair(ownerId);
        const second = await pair(ownerId);
        const sessionId = "import-1";
        const { json } = await ingest(first, { events: [IMPORT_OPEN], sessionId });

        await ingest(first, { events: [TURNS[0]], firstSeq: 0, sessionId, threadId: json.threadId });

        const finished = await importSession(second, TURNS);

        expect(finished.opened.json).toMatchObject({ ended: false, existing: true, next: 1, threadId: json.threadId });
        expect(finished.sent?.json).toMatchObject({ ended: true, next: 2 });
        await expect(transcriptOf(json.threadId)).resolves.toHaveLength(4);
        expect(await sessionRows()).toMatchObject([{ deviceId: second.deviceId, importState: "done" }]);
        // The first computer no longer writes into it.
        await expect(ingest(first, { events: [TURNS[1]], firstSeq: 1, sessionId, threadId: json.threadId })).resolves.toMatchObject({ status: 403 });
    });

    it("closes the import when the end arrives after the backend already holds every turn of the post", async () => {
        const device = await pair(ownerId);
        const sessionId = "import-1";
        const { json } = await ingest(device, { events: [IMPORT_OPEN], sessionId });
        const three = [IMPORT_TURN("a", "1"), IMPORT_TURN("b", "2"), IMPORT_TURN("c", "3")];

        await ingest(device, { events: three, firstSeq: 0, sessionId, threadId: json.threadId });

        await expect(ingest(device, { events: [three[0], three[1], IMPORT_END], firstSeq: 0, sessionId, threadId: json.threadId })).resolves.toMatchObject({
            json: { ended: true, next: 3 },
            status: 200,
        });
        expect(await sessionRows()).toMatchObject([{ importedTurns: 3, importState: "done" }]);
        await expect(transcriptOf(json.threadId)).resolves.toHaveLength(6);
    });

    it("refuses an end that is not the last event", async () => {
        const device = await pair(ownerId);
        const { json } = await ingest(device, { events: [IMPORT_OPEN], sessionId: "import-1" });

        await expect(
            ingest(device, { events: [IMPORT_END, IMPORT_TURN("a", "b")], firstSeq: 0, sessionId: "import-1", threadId: json.threadId }),
        ).resolves.toMatchObject({
            status: 403,
        });
    });

    it("exports the native id and the import state with the session", async () => {
        const device = await pair(ownerId);

        await importSession(device, TURNS);

        const exported = (await harness.run(async (ctx: any) => await ctx.runQuery(collectAcpSessionsForExport, { userId: ownerId }))) as {
            sessions: Record<string, unknown>[];
        };

        expect(exported.sessions).toMatchObject([{ importedTurns: 2, importState: "done", nativeSessionId: "native-1" }]);
    });

    it("takes the capability report the host builds from a handshake, on a live session and on an import", async () => {
        const device = await pair(ownerId);
        // The literal `reportFromHandshake` (apps/desktop/src/acp/capabilities.ts) produces.
        const capabilities = {
            groups: { sessions: { listNative: { degradation: "none", supported: true }, load: { reason: "not_offered", supported: false } } },
            reportedAt: 1_793_179_919_354,
            version: 1,
        };
        const live = await ingest(device, { events: [{ ...SESSION_OPEN, capabilities, nativeSessionId: "native-9" }], sessionId: "live-9" });
        const imported = await importSession(device, TURNS, { capabilities, nativeSessionId: "native-10" });

        expect(live.status).toBe(200);
        expect(imported.opened.status).toBe(200);

        const stored = await sessionRows();

        expect(stored.map((session) => session.capabilities)).toEqual([capabilities, capabilities]);
    });

    it("writes none of a post that would pass the cap", async () => {
        const device = await pair(ownerId);
        const { json } = await ingest(device, { events: [IMPORT_OPEN], sessionId: "import-1" });

        // A session that already holds all but one of the turns it may take.
        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.acpSessions.findMany({});

            await ctx.db.patch(page[0]._id, { importedTurns: MAX_IMPORT_TURNS - 1 });
        });

        await expect(
            ingest(device, {
                events: [IMPORT_TURN("a", "b"), IMPORT_TURN("c", "d")],
                firstSeq: MAX_IMPORT_TURNS - 1,
                sessionId: "import-1",
                threadId: json.threadId,
            }),
        ).resolves.toMatchObject({ status: 403 });
        expect(await messagesOf(json.threadId)).toHaveLength(0);
        expect(await sessionRows()).toMatchObject([{ importedTurns: MAX_IMPORT_TURNS - 1 }]);
    });

    it("takes no more turns than the cap", async () => {
        const device = await pair(ownerId);
        const { json } = await ingest(device, { events: [IMPORT_OPEN], sessionId: "import-1" });
        const batch = Array.from({ length: 26 }, () => IMPORT_TURN("a", "b"));

        await expect(ingest(device, { events: batch, firstSeq: 0, sessionId: "import-1", threadId: json.threadId })).resolves.toMatchObject({ status: 403 });
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
        expect(reply?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "Done.", type: "text" }]);
        expect(await row(threadId)).toMatchObject({ status: "active" });
        await expect(as(ownerId).query(streaming.getActiveStreamForThread as never, { threadId } as never)).resolves.toBeNull();

        // A redelivery of the whole post, and anything after the end, changes nothing.
        await expect(turn(device, threadId, "t1", 0, [START("hello"), TEXT("Done.")])).resolves.toMatchObject({ json: { ended: true }, status: 200 });
        expect(await messagesOf(threadId)).toHaveLength(2);
    });

    it("saves no reply into a thread deleted during the turn, and ends the session when the desktop reopens it", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START("hello"), TEXT("half")]);
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { deleted: true }));
        await turn(device, threadId, "t1", 2, [{ kind: "turn_end", reason: "finished" }]);

        const saved = await messagesOf(threadId);

        expect(saved.filter((message) => message.message.role === "assistant")).toHaveLength(0);

        const reopened = await ingest(device, { events: [SESSION_OPEN] });

        expect(reopened.json).toMatchObject({ ended: true, threadId });
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
        expect(newer?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "second answer", type: "text" }]);
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

const expire = async (turnId: string, at: number) =>
    await harness.run(async (ctx: any) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { hostTurnId: turnId } });

        await ctx.db.patch(stream._id, { expiresAt: at });
    });

const reap = async () => await harness.run(async (ctx: any) => await ctx.runMutation(reapHostStreams, {}));

describe("the reaper", () => {
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
        expect(reply?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "working", type: "text" }]);
        expect(reply?.error).toMatch(STOPPED_SENDING);
        expect(call).toMatchObject({ deviceId: device.deviceId, status: "pending", toolName: "acp_cancel" });
        expect(JSON.parse(call?.envelope)).toMatchObject({ input: { sessionId: "host-s1", turnId: "t1" }, kind: "call", tool: "acp_cancel" });
        expect(call?.signature).toMatch(HEX_SIGNATURE);

        const late = await turn(device, threadId, "t1", 2, [TEXT("late")]);

        expect(late).toMatchObject({ json: { ended: true }, status: 200 });
        expect(await chunksOf(stream?._id)).toHaveLength(2);
    });

    it("ends a silent stream whose prompt message is gone, without failing the tick", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("working")]);
        await harness.run(async (ctx: any) => {
            const stream = await ctx.db.persistentStreams.findFirst({ where: { hostTurnId: "t1" } });

            await ctx.db.delete(stream.messageId);
        });
        await expire("t1", Date.now() - 1000);
        await reap();

        expect(await streamFor("t1")).toMatchObject({ hostEndReason: "timeout", status: "timeout" });
        expect(await assistantRepliesOf(threadId)).toHaveLength(0);
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

    it("keeps an agent's children with the reply, once each, however often the host posts them", async () => {
        const owner = await insertUser();
        const device = await pair(owner);
        const threadId = await openSession(device);
        const child = (text: string) => {
            return { field: "text", kind: "child_text", spawnId: "task1", text };
        };
        const events = [START(), TEXT("delegating"), child("child "), child("says hi"), { kind: "child_end", spawnId: "task1", status: "completed" }];

        const first = await turn(device, threadId, "t1", 0, events);

        expect(first.status).toBe(200);
        // The same post again, and the end again: dropped by their `seq`, not kept twice.
        await turn(device, threadId, "t1", 0, events);
        await turn(device, threadId, "t1", 5, [
            { kind: "child_end", spawnId: "task1", status: "failed" },
            { kind: "turn_end", reason: "finished" },
        ]);

        const [reply] = await assistantRepliesOf(threadId);

        expect(reply?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "delegating", type: "text" }]);
        expect(reply?.providerMetadata.neore.subagentTranscripts).toEqual([
            { reasoning: "", spawnId: "task1", status: "completed", text: "child says hi", tools: [] },
        ]);
    });

    it("keeps every chunk of a turn longer than one page when it saves the reply", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const texts = Array.from({ length: 450 }, (_, index) => TEXT(String(index % 10)));

        await turn(device, threadId, "t1", 0, [START(), ...texts, { kind: "turn_end", reason: "finished" }]);

        const [reply] = await assistantRepliesOf(threadId);

        expect(reply?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: texts.map((event) => event.text).join(""), type: "text" }]);
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
        expect(reply?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "partial", type: "text" }]);
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
        expect(reply?.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "busy", type: "text" }]);
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

/** A signed session-level close, as the desktop posts it when a local session ends. */
const close = async (device: Paired, sessionId = "host-s1", extra: Partial<Body> = {}) =>
    await ingest(device, { close: true, events: [], sessionId, ...extra } as Body);

describe("a turn that begins while the session's previous turn is live", () => {
    it("is told to wait, and starts once the earlier turn's end has landed", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START("first"), TEXT("working")]);

        const waiting = await turn(device, threadId, "t2", 0, [START("second")]);

        // 409 without `next`: the host reads it as "try again", not as a gap to fill.
        expect(waiting).toMatchObject({ json: { error: "turn_in_progress" }, status: 409 });
        expect(waiting.json.next).toBeUndefined();
        expect(await streamFor("t2")).toBeNull();
        const saved = await messagesOf(threadId);

        expect(saved.filter((message) => message.message.role === "user")).toHaveLength(1);

        await turn(device, threadId, "t1", 2, [{ kind: "turn_end", reason: "finished" }]);

        await expect(turn(device, threadId, "t2", 0, [START("second")])).resolves.toMatchObject({ json: { ended: false }, status: 200 });

        const second = await streamFor("t2");

        await expect(as(ownerId).query(streaming.getActiveStreamForThread as never, { threadId } as never)).resolves.toMatchObject({ streamId: second?._id });
    });

    it("keeps answering a redelivery of the live turn itself, not as busy", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START("first")]);

        await expect(turn(device, threadId, "t1", 0, [START("first"), TEXT("more")])).resolves.toMatchObject({ json: { next: 2 }, status: 200 });
    });

    it("lets the reaper unblock the next turn when the earlier one's host never returned", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START("first")]);
        await expect(turn(device, threadId, "t2", 0, [START("second")])).resolves.toMatchObject({ status: 409 });
        await expire("t1", Date.now() - 1000);
        await reap();

        await expect(turn(device, threadId, "t2", 0, [START("second")])).resolves.toMatchObject({ status: 200 });
    });
});

describe("a long turn read live", () => {
    it("shows every chunk to a second client, however many pages the turn has", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const texts = Array.from({ length: 300 }, (_, index) => TEXT(String(index % 10)));

        await turn(device, threadId, "t1", 0, [START(), ...texts.slice(0, 150)]);
        await turn(device, threadId, "t1", 151, texts.slice(150));

        const stream = await streamFor("t1");
        const body = (await harness.run(async (ctx: any) => await ctx.runQuery(library.getStreamText, { streamId: stream?._id }))) as {
            status: string;
            text: string;
        };

        expect(body.status).toBe("streaming");
        expect(body.text).toBe(texts.map((event) => event.text).join(""));
        expect(body.text).toHaveLength(300);
    });
});

describe("a session the desktop closed", () => {
    it("ends the session at once, and refuses turn posts into it", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("done"), { kind: "turn_end", reason: "finished" }]);

        const closed = await close(device);

        expect(closed).toMatchObject({ json: { ended: true }, status: 200 });
        await expect(as(ownerId).query(getHostSession as never, { threadId } as never)).resolves.toMatchObject({ status: "ended" });
        await expect(turn(device, threadId, "t2", 0, [START("again")])).resolves.toMatchObject({ status: 403 });
        // The thread and its saved reply are untouched.
        expect(await row(threadId)).toMatchObject({ runner: "host", status: "active" });
        expect(await assistantRepliesOf(threadId)).toHaveLength(1);
    });

    it("is idempotent, and a session it does not know is not an error", async () => {
        const device = await pair(ownerId);

        await openSession(device);

        await expect(close(device)).resolves.toMatchObject({ json: { ended: true }, status: 200 });
        await expect(close(device)).resolves.toMatchObject({ json: { ended: true }, status: 200 });
        await expect(close(device, "never-opened")).resolves.toMatchObject({ json: { ended: true }, status: 200 });
    });

    it("ends a turn the host never finished as interrupted, so no stream stays live", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("half")]);
        await close(device);

        expect(await streamFor("t1")).toMatchObject({ hostEndReason: "interrupted", hostState: "ended", status: "error" });
        await expect(as(ownerId).query(streaming.getActiveStreamForThread as never, { threadId } as never)).resolves.toBeNull();
        expect(await assistantRepliesOf(threadId)).toHaveLength(1);
    });

    it("ends only the sessions of the device that signed it", async () => {
        const device = await pair(ownerId);
        const other = await pair(ownerId);
        const threadId = await openSession(device);

        await close(other);

        await expect(as(ownerId).query(getHostSession as never, { threadId } as never)).resolves.toMatchObject({ status: "idle" });
    });

    it("refuses a close that carries events or a thread", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await expect(close(device, "host-s1", { events: [SESSION_OPEN] })).resolves.toMatchObject({ status: 403 });
        await expect(close(device, "host-s1", { threadId })).resolves.toMatchObject({ status: 403 });
        await expect(as(ownerId).query(getHostSession as never, { threadId } as never)).resolves.toMatchObject({ status: "idle" });
    });

    it("answers 400 to a close flag that is not a boolean", async () => {
        const device = await pair(ownerId);

        await openSession(device);

        await expect(ingest(device, { close: "yes", events: [] } as never)).resolves.toMatchObject({ status: 400 });
    });
});

describe("deleting a host thread", () => {
    const hardDelete = async (threadId: string) =>
        await harness.run(async (ctx: any) => await ctx.runMutation(agentThreads.deleteAllForThreadIdAsync, { threadId }));
    const softDelete = async (threadId: string) => await harness.run(async (ctx: any) => await ctx.runMutation(agentThreads.softDeleteThread, { threadId }));

    it.each([
        ["soft", softDelete],
        ["hard", hardDelete],
    ])("a %s delete during a live turn ends the turn without a reply, asks the host to cancel, and ends the session", async (_kind, remove) => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("half")]);
        await remove(threadId);

        expect(await streamFor("t1")).toMatchObject({ hostEndReason: "stopped", hostState: "ended", status: "done" });
        expect(await assistantRepliesOf(threadId)).toHaveLength(0);
        expect(await cancelCalls()).toHaveLength(1);

        const sessions = await pageOf(async (ctx) => await ctx.db.acpSessions.findMany({ where: { userId: ownerId } }));

        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ status: "ended", threadId });
        // The desktop's next post is refused, and a reopen is told the session is over (not given a new thread).
        await expect(turn(device, threadId, "t1", 2, [TEXT("more")])).resolves.toMatchObject({ status: 403 });
        await expect(ingest(device, { events: [SESSION_OPEN] })).resolves.toMatchObject({ json: { ended: true, threadId } });
    });

    it("undoing a soft delete lets the desktop that still holds the session post into the thread again", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("half")]);
        await softDelete(threadId);
        await expect(turn(device, threadId, "t2", 0, [START("again")])).resolves.toMatchObject({ status: 403 });

        await harness.run(async (ctx: any) => await ctx.runMutation(agentThreads.restoreThread, { threadId }));

        await expect(as(ownerId).query(getHostSession as never, { threadId } as never)).resolves.toMatchObject({ status: "offline" });
        // A redelivered open is no longer told the session is over, and the next turn is taken.
        await expect(ingest(device, { events: [SESSION_OPEN] })).resolves.toMatchObject({ json: { ended: false, threadId } });
        await expect(turn(device, threadId, "t2", 0, [START("again")])).resolves.toMatchObject({ json: { ended: false }, status: 200 });
        await expect(as(ownerId).query(getHostSession as never, { threadId } as never)).resolves.toMatchObject({ status: "busy" });
        // The turn the delete cut short stays ended.
        expect(await streamFor("t1")).toMatchObject({ hostEndReason: "stopped", hostState: "ended" });
    });

    it("undoing a soft delete leaves the session ended when its device was removed meanwhile", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await softDelete(threadId);
        await as(ownerId).mutation(devices.revokeDevice as never, { deviceId: device.deviceId } as never);
        await harness.run(async (ctx: any) => await ctx.runMutation(agentThreads.restoreThread, { threadId }));

        await expect(as(ownerId).query(getHostSession as never, { threadId } as never)).resolves.toMatchObject({ status: "ended" });
    });

    it("a hard delete removes the thread and leaves no live stream behind", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("half")]);
        await hardDelete(threadId);

        expect(await row(threadId)).toBeNull();
        expect(await pageOf(async (ctx) => await ctx.db.persistentStreams.findMany({ where: { status: { in: ["pending", "streaming"] } } }))).toHaveLength(0);
    });

    it("leaves an ordinary thread and a host thread without a live turn alone", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const cloud = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Chat", userId: ownerId }))) as string;

        await softDelete(cloud);
        await softDelete(threadId);

        expect(await cancelCalls()).toHaveLength(0);
        await expect(as(ownerId).query(getHostSession as never, { threadId } as never)).resolves.toMatchObject({ status: "ended" });
    });
});

describe("the cancel a stop or a delete sends", () => {
    const fillOpenCalls = async (device: { deviceId: string }, threadId: string, toolName: string, count: number) => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < count; index += 1) {
                await ctx.db.insert("deviceCalls", {
                    createdAt: Date.now(),
                    deadline: Date.now() + 600_000,
                    deviceId: device.deviceId,
                    deviceName: "Laptop",
                    envelope: "",
                    input: "{}",
                    signature: "",
                    status: "claimed",
                    taintedBy: [],
                    threadId,
                    toolName,
                    userId: ownerId,
                });
            }
        });
    };

    it("still reaches the agent when the device's send budget is spent", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START(), TEXT("x")]);
        await fillOpenCalls(device, threadId, "acp_send", MAX_OPEN_ACP_CALLS_PER_DEVICE);
        await harness.run(async (ctx: any) => await ctx.runMutation(library.stopActiveForThread, { threadId }));

        expect(await streamFor("t1")).toMatchObject({ hostEndReason: "stopped", status: "done" });
        expect(await cancelCalls()).toHaveLength(1);
    });

    it("is logged, not lost silently, when the device's cancel budget is spent", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const warn = vi.spyOn(streamLogger, "warn").mockImplementation(() => {});

        await turn(device, threadId, "t1", 0, [START(), TEXT("x")]);
        await fillOpenCalls(device, threadId, "acp_cancel", MAX_OPEN_ACP_CANCELS_PER_DEVICE);
        await harness.run(async (ctx: any) => await ctx.runMutation(library.stopActiveForThread, { threadId }));

        expect(await streamFor("t1")).toMatchObject({ hostEndReason: "stopped", status: "done" });
        expect(await cancelCalls()).toHaveLength(MAX_OPEN_ACP_CANCELS_PER_DEVICE);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("busy"));
        warn.mockRestore();
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

describe("what a turn changed", () => {
    const SUMMARY = {
        files: [
            { added: 2, path: "src/a.ts", removed: 1 },
            { added: 4, path: "b.md", removed: 0 },
        ],
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+more\n",
    };

    /** The UI message a client reads for the thread's reply. */
    const replyFor = async (threadId: string) => {
        const { toUIMessages } = await import("../agent/ui-messages");
        const ui = toUIMessages((await messagesOf(threadId)) as never);

        return ui.find((message) => message.role === "assistant");
    };

    it("shows the two files a turn wrote with their counts, and the patch, on the reply a client reads", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START("edit"), TEXT("Done."), { kind: "turn_end", reason: "finished", summary: SUMMARY }]);

        const reply = await replyFor(threadId);

        expect(reply?.hostChanges).toEqual(SUMMARY);
        expect(reply?.text).toBe("Done.");
    });

    it("saves a reply for a turn that only changed files, and for a cancelled one", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [
            START("edit"),
            { kind: "turn_end", reason: "cancelled", summary: { files: SUMMARY.files, patch: SUMMARY.patch } },
        ]);

        const replies = await assistantRepliesOf(threadId);

        expect(replies).toHaveLength(1);
        expect(replies[0]?.providerMetadata.neore.hostChanges.files).toEqual(SUMMARY.files);
    });

    it("keeps the file list and counts of a patch the host could not keep", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [
            START("edit"),
            TEXT("ok"),
            { kind: "turn_end", reason: "finished", summary: { files: SUMMARY.files, patch: { tooLarge: true } } },
        ]);

        const reply = await replyFor(threadId);

        expect(reply?.hostChanges).toEqual({ files: SUMMARY.files, patch: { tooLarge: true } });
    });

    it("leaves an earlier reply's patch as it was when a later turn changes the same file", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const later = { files: [{ added: 9, path: "src/a.ts", removed: 9 }], patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,9 +1,9 @@\n" };

        await turn(device, threadId, "t1", 0, [START("one"), TEXT("first"), { kind: "turn_end", reason: "finished", summary: SUMMARY }]);
        await turn(device, threadId, "t2", 0, [START("two"), TEXT("second"), { kind: "turn_end", reason: "finished", summary: later }]);

        const { toUIMessages } = await import("../agent/ui-messages");
        const replies = toUIMessages((await messagesOf(threadId)) as never).filter((message) => message.role === "assistant");

        expect(replies.map((reply) => reply.hostChanges)).toEqual([SUMMARY, later]);

        // A redelivery of the first turn's end, even with a different summary, is dropped.
        await turn(device, threadId, "t1", 0, [START("one"), TEXT("first"), { kind: "turn_end", reason: "finished", summary: later }]);
        expect(toUIMessages((await messagesOf(threadId)) as never).find((message) => message.role === "assistant")?.hostChanges).toEqual(SUMMARY);
    });

    it("ignores a summary that lists no file, so a turn that said nothing still saves no reply", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START("edit"), { kind: "turn_end", reason: "finished", summary: { files: [] } }]);

        expect(await assistantRepliesOf(threadId)).toHaveLength(0);
    });

    it("keeps each turn's summary on its own reply, not on the next turn's", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START("one"), TEXT("first"), { kind: "turn_end", reason: "finished", summary: SUMMARY }]);
        await turn(device, threadId, "t2", 0, [START("two"), TEXT("second"), { kind: "turn_end", reason: "finished" }]);

        const { toUIMessages } = await import("../agent/ui-messages");
        const ui = toUIMessages((await messagesOf(threadId)) as never);

        expect(ui.map((message) => `${message.role}:${message.text}`)).toEqual(["user:one", "assistant:first", "user:two", "assistant:second"]);
        expect(ui[1]?.hostChanges).toEqual(SUMMARY);
        expect(ui[3]?.hostChanges).toBeUndefined();
    });

    it("keeps the patch out of the stream's chunks, which every reader of the stream pays for", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);

        await turn(device, threadId, "t1", 0, [START("edit"), { kind: "turn_end", reason: "finished", summary: SUMMARY }]);

        const stream = await streamFor("t1");
        const chunks = await chunksOf(stream?._id);

        expect(JSON.stringify(chunks)).not.toContain("+more");
        expect(chunks.at(-1)?.event).toEqual({ kind: "turn_end", reason: "finished" });
    });

    it("refuses a whole post whose summary is outside the bounds", async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const bad = [
            { files: [{ added: 1, path: "/etc/passwd", removed: 0 }] },
            { files: [{ added: 1, path: "../outside.txt", removed: 0 }] },
            { files: [{ added: 1, path: String.raw`C:\Windows\x`, removed: 0 }] },
            { files: [{ added: 1, path: "a\n+++ b/forged", removed: 0 }] },
            { files: [{ added: -1, path: "a.ts", removed: 0 }] },
            { files: [{ added: 1.5, path: "a.ts", removed: 0 }] },
            { files: [{ added: 1, path: "x".repeat(1025), removed: 0 }] },
            {
                files: Array.from({ length: 201 }, (_, index) => {
                    return { added: 1, path: `f${String(index)}.ts`, removed: 0 };
                }),
            },
            { files: SUMMARY.files, patch: "x".repeat(256 * 1024 + 1) },
            { files: SUMMARY.files, patch: { tooLarge: false } },
        ];

        await turn(device, threadId, "t1", 0, [START("edit")]);

        for (const summary of bad) {
            const result = await turn(device, threadId, "t1", 1, [{ kind: "turn_end", reason: "finished", summary }]);

            // A patch past the post's body cap is refused by the route itself (413) before the validator sees it.
            expect([400, 413]).toContain(result.status);
        }

        expect(await assistantRepliesOf(threadId)).toHaveLength(0);
        // The accepted bounds themselves are not refused.
        const edge = {
            files: Array.from({ length: 200 }, (_, index) => {
                return { added: 0, path: `${"d/".repeat(5)}f${String(index)}.ts`, removed: 0 };
            }),
            patch: "x".repeat(100 * 1024),
        };

        await expect(turn(device, threadId, "t1", 1, [{ kind: "turn_end", reason: "finished", summary: edge }])).resolves.toMatchObject({ status: 200 });
    });
});

describe("files a reply refers to", () => {
    const KEY = `agent-files/${"b".repeat(64)}`;

    const insertFile = async (): Promise<string> =>
        (await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("chatFiles", {
                    filename: "chart.png",
                    hash: "b".repeat(64),
                    lastTouchedAt: 0,
                    mediaType: "image/png",
                    refcount: 0,
                    storageId: KEY,
                }),
        )) as string;

    const MEDIA = { contentType: "image/png", kind: "media", name: "chart.png", reference: "out/chart.png", size: 1234, uploadId: "u".repeat(21) };

    /** The thread's `index`th assistant reply; a test that expects it fails here, not on a later `undefined`. */
    const replyAt = async (threadId: string, index: number): Promise<Record<string, any>> => {
        const replies = await assistantRepliesOf(threadId);
        const reply = replies[index];

        if (reply === undefined) {
            throw new Error(`expected a reply at ${String(index)}`);
        }

        return reply;
    };

    const setUp = async () => {
        const device = await pair(ownerId);
        const threadId = await openSession(device);
        const fileId = await insertFile();
        const finalize = vi.fn(async () => {
            return { fileId, mediaType: "image/png", storageKey: KEY };
        });

        finalizeStub = finalize;

        return { device, fileId, finalize, threadId };
    };

    it("finalizes the upload for the device's owner and saves the file on the reply, counted once", async () => {
        const { device, fileId, finalize, threadId } = await setUp();
        const sent = await turn(device, threadId, "t1", 0, [
            START(),
            TEXT("Here is the chart: ![c](out/chart.png)"),
            MEDIA,
            { kind: "turn_end", reason: "finished" },
        ]);

        expect(sent.status).toBe(200);
        expect(finalize).toHaveBeenCalledExactlyOnceWith({ filename: "chart.png", uploadId: MEDIA.uploadId, userId: ownerId });

        const stream = await streamFor("t1");
        const chunks = await chunksOf(stream!._id);
        const mediaChunk = chunks.find((chunk) => chunk.event?.kind === "media");

        // What is kept is the stored file, never the upload id.
        expect(mediaChunk!.event).toEqual({
            contentType: "image/png",
            fileId,
            kind: "media",
            name: "chart.png",
            reference: "out/chart.png",
            size: 1234,
            storageKey: KEY,
        });

        const reply = await replyAt(threadId, 0);

        expect(reply.message.content).toEqual([
            { providerMetadata: HOST_TEXT, text: "Here is the chart: c", type: "text" },
            { data: `storage:${KEY}`, filename: "chart.png", mediaType: "image/png", type: "file" },
        ]);
        expect(reply.fileIds).toEqual([fileId]);
        expect(await rowField(fileId, "refcount")).toBe(1);
    });

    it("drops a file id and a storage key a device sends: it cannot name stored bytes", async () => {
        const { device, finalize, threadId } = await setUp();
        const forged = { ...MEDIA, fileId: "someone-elses", storageKey: `agent-files/${"c".repeat(64)}`, uploadId: undefined };

        await turn(device, threadId, "t1", 0, [START(), { ...forged }, { kind: "turn_end", reason: "finished" }]);

        const stream = await streamFor("t1");
        const chunks = await chunksOf(stream!._id);
        const mediaChunk = chunks.find((chunk) => chunk.event?.kind === "media");

        expect(finalize).not.toHaveBeenCalled();
        expect(mediaChunk!.event).not.toHaveProperty("storageKey");
        expect(mediaChunk!.event).not.toHaveProperty("fileId");

        const reply = await replyAt(threadId, 0);

        expect(reply.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "`chart.png` (1 KiB) could not be attached.", type: "text" }]);
        expect(reply.fileIds).toBeUndefined();
    });

    it("does not fail the post when a finalize fails: the file is shown as not attached", async () => {
        const { device, threadId } = await setUp();

        finalizeStub = async () => null;

        const sent = await turn(device, threadId, "t1", 0, [START(), MEDIA, { kind: "turn_end", reason: "finished" }]);

        expect(sent.status).toBe(200);

        const reply = await replyAt(threadId, 0);

        expect(reply.message.content).toEqual([{ providerMetadata: HOST_TEXT, text: "`chart.png` (1 KiB) could not be attached.", type: "text" }]);
    });

    it("names a file over the cap with its size, without an upload", async () => {
        const { device, finalize, threadId } = await setUp();

        await turn(device, threadId, "t1", 0, [
            START(),
            { kind: "media", name: "dump.json", reference: "dump.json", size: 30 * 1024 * 1024 },
            { kind: "turn_end", reason: "finished" },
        ]);

        const reply = await replyAt(threadId, 0);

        expect(finalize).not.toHaveBeenCalled();
        expect(reply.message.content).toEqual([
            { providerMetadata: HOST_TEXT, text: "`dump.json` (30.0 MiB) is over the 20.0 MiB limit and was not attached.", type: "text" },
        ]);
    });

    it("finalizes a redelivered post's file once, and not at all for a post the backend answers gap to", async () => {
        const { device, finalize, threadId } = await setUp();

        await turn(device, threadId, "t1", 0, [START(), TEXT("a")]);

        const first = await turn(device, threadId, "t1", 2, [MEDIA]);
        const again = await turn(device, threadId, "t1", 2, [MEDIA]);
        const gap = await turn(device, threadId, "t1", 9, [{ ...MEDIA, uploadId: "v".repeat(21) }]);

        expect(first.json.next).toBe(3);
        expect(again.json.next).toBe(3);
        expect(gap.status).toBe(409);
        expect(finalize).toHaveBeenCalledTimes(1);
    });

    it("leaves an earlier message as it was when the file changes and is attached again", async () => {
        const { device, fileId, threadId } = await setUp();
        const NEW_KEY = `agent-files/${"d".repeat(64)}`;

        await turn(device, threadId, "t1", 0, [START(), MEDIA, { kind: "turn_end", reason: "finished" }]);

        // The file was edited; the next turn uploads the new bytes, which are stored under their own key.
        finalizeStub = async () => {
            return { fileId, mediaType: "image/png", storageKey: NEW_KEY };
        };

        await turn(device, threadId, "t2", 0, [START("again"), { ...MEDIA, uploadId: "w".repeat(21) }, { kind: "turn_end", reason: "finished" }]);

        const first = await replyAt(threadId, 0);
        const second = await replyAt(threadId, 1);
        const keysOf = (reply: Record<string, any>) => reply.message.content.filter((part: any) => part.type === "file").map((part: any) => part.data);

        expect(keysOf(first)).toEqual([`storage:${KEY}`]);
        expect(keysOf(second)).toEqual([`storage:${NEW_KEY}`]);
    });

    it("answers 200 and shows the file as not attached when a finalize throws, or the upload id is malformed", async () => {
        const { device, threadId } = await setUp();

        finalizeStub = async () => {
            throw new Error("storage is down");
        };

        const thrown = await turn(device, threadId, "t1", 0, [START(), { ...MEDIA, name: "n".repeat(255) }]);
        const malformed = await turn(device, threadId, "t1", 2, [
            { ...MEDIA, uploadId: "../x" },
            { kind: "turn_end", reason: "finished" },
        ]);

        expect(thrown.status).toBe(200);
        expect(malformed.status).toBe(200);

        const reply = await replyAt(threadId, 0);

        expect(reply.message.content[0].text).toContain("could not be attached");
        expect(reply.fileIds).toBeUndefined();
    });

    it("finalizes the files of one post one at a time", async () => {
        const { device, fileId, threadId } = await setUp();
        let running = 0;
        let overlapped = false;

        finalizeStub = async () => {
            running += 1;
            overlapped ||= running > 1;
            await new Promise((resolve) => {
                setTimeout(resolve, 5);
            });
            running -= 1;

            return { fileId, mediaType: "image/png", storageKey: KEY };
        };

        await turn(device, threadId, "t1", 0, [START(), MEDIA, { ...MEDIA, uploadId: "x".repeat(21) }, { ...MEDIA, uploadId: "y".repeat(21) }]);

        expect(overlapped).toBe(false);
    });

    it("keeps a finalized file for the resend of a post whose mutation failed: one finalize, one file row, the file attached", async () => {
        const { device, fileId, threadId } = await setUp();
        const { finalizeHostUpload } = await import("./upload");
        const actionContext = {
            runMutation: async (ref: never, args: never) => await harness.run(async (ctx: any) => await ctx.runMutation(ref, args)),
            runQuery: async (ref: never, args: never) => await harness.run(async (ctx: any) => await ctx.runQuery(ref, args)),
            storage: {},
        };

        // The staging object is deleted by the first finalize: a second one throws, as the real one does.
        stagedFinalize.mockResolvedValueOnce({ fileId, mediaType: "image/png", storageId: KEY, url: "https://signed" });
        stagedFinalize.mockRejectedValue(new Error("the upload expired"));
        finalizeStub = async (args) =>
            await (finalizeHostUpload as unknown as { handler: (ctx: unknown, args: unknown) => Promise<unknown> }).handler(actionContext, args);
        failApply = true;

        await expect(turn(device, threadId, "t1", 0, [START(), MEDIA, { kind: "turn_end", reason: "finished" }])).rejects.toThrow("the mutation failed");

        const resent = await turn(device, threadId, "t1", 0, [START(), MEDIA, { kind: "turn_end", reason: "finished" }]);

        expect(resent.status).toBe(200);
        expect(stagedFinalize).toHaveBeenCalledTimes(1);

        const reply = await replyAt(threadId, 0);

        expect(reply.message.content[0]).toMatchObject({ data: `storage:${KEY}`, type: "file" });
        expect(reply.fileIds).toEqual([fileId]);

        const rows = await pageOf(async (ctx) => await ctx.db.chatFiles.findMany({}));

        expect(rows).toHaveLength(1);
    });

    it("spends the device's budget before finalizing a file, and answers 429 without using the upload up", async () => {
        const { device, finalize, threadId } = await setUp();

        await spendBudget(device.deviceId);

        const sent = await turn(device, threadId, "t1", 0, [START(), MEDIA]);

        expect(sent.status).toBe(429);
        expect(finalize).not.toHaveBeenCalled();
    });

    it("charges the device's budget once for a post that names a file: the apply skips what the route already spent", async () => {
        const device = await pair(ownerId);
        const apply = async (budgetSpent?: boolean) =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(applyHostEvents, {
                        ...(budgetSpent && { budgetSpent }),
                        deviceId: device.deviceId,
                        events: [SESSION_OPEN],
                        sessionId: "s",
                    }),
            );

        const rowsOf = async () => {
            const all = await rateLimitRows();

            return all.filter((limit) => JSON.stringify(limit).includes(device.deviceId)).length;
        };

        await apply(true);
        expect(await rowsOf()).toBe(0);

        await apply();
        expect(await rowsOf()).toBe(1);
    });

    it("refuses a post carrying more files than one turn may attach", async () => {
        const { device, finalize, threadId } = await setUp();
        const sent = await turn(device, threadId, "t1", 0, [
            START(),
            ...Array.from({ length: 9 }, () => {
                return { ...MEDIA };
            }),
        ]);

        expect(sent.status).toBe(400);
        expect(finalize).not.toHaveBeenCalled();
    });
});
