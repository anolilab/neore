/**
 * Remote control of a coding agent against the in-memory harness (acp-agent-host.md §4.1, §4.4, §4.6, S4):
 * the offers a manifest carries, starting a session, sending into one (`sendToHost`), the lease and the clock on
 * a command, the prompt that is cleared, Stop and the permission answers.
 *
 * Time is the real clock moved with `vi.setSystemTime`; the scheduler is not run, so each scheduled check
 * (`checkAcpCall`) is called by the test at the moment it would have fired.
 */
import { lunoraTest } from "@lunora/testing";
import { MIN_DEVICE_PROTOCOL } from "../devices/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashPasscode, mintUnlockProof, newPasscodeEpoch } from "../lib/thread-lock";

const { activeOrganization, sessionFrom } = vi.hoisted(() => {
    /** The caller's verified active organization, as `getSessionUser` resolves it; `null` is the personal space. */
    const active = { current: null as null | { id: string; name: string; role: string; slug: null } };

    return {
        activeOrganization: active,
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: active.current, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
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

// A read replica that still holds a project row the primary has changed: a project read that does not ask for the primary
// gets `replica.project` while it is set, the way a lagging replica answers just after the project moved organization.
// `replica.readable` is a project a replica still admits the caller to, the way it answers just after their membership was revoked.
const { replica } = vi.hoisted(() => {
    return { replica: {} as { project?: Record<string, unknown>; readable?: Record<string, unknown> } };
});

vi.mock("../projects/functions", async (importOriginal) => {
    const original = await importOriginal<typeof import("../projects/functions")>();

    return {
        ...original,
        readableProject: async (...args: Parameters<typeof original.readableProject>) =>
            args[3]?.primary !== true && replica.readable?._id === args[1] ? (replica.readable as never) : await original.readableProject(...args),
        writableProject: async (...args: Parameters<typeof original.writableProject>) =>
            args[3]?.primary !== true && replica.project?._id === args[1] ? (replica.project as never) : await original.writableProject(...args),
    };
});

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
const agentProjects = await import("../agent/projects");
const projectsGdpr = await import("../projects/gdpr");
const projectRunner = await import("./lib/project-runner");
const { signDevicePayload } = await import("../devices/lib/signing");
const { ACP_CLAIM_LEASE_MS, ACP_CLAIM_WINDOW_MS, DEVICE_CALL_DEADLINE_MS } = await import("../devices/lib/constants");
const { parseAcpOffers } = await import("../devices/lib/manifest");
const { applyHostEvents } = await import("./ingest");
const { createAcpCall, createAcpCancelCall } = await import("../devices/lib/acp-call");
const calls = await import("./calls");
const remote = await import("./remote");
const send = await import("./send");
const { getHostSession } = await import("./functions");
const streaming = await import("../chat/streaming/index");
const { reapExpiredHostStreams } = await import("./lib/reap");

registerModule(registry, "acp_calls", calls);
registerModule(registry, "acp_ingest", await import("./ingest"));
registerModule(registry, "agent_sharing", await import("../agent/sharing"));
registerModule(registry, "agent_streams", await import("../agent/streams"));
registerModule(registry, "chat_streaming_persistent_library", await import("../chat/streaming/persistent/library"));
registerModule(registry, "lib_shard_routes", await import("../lib/shard-routes"));
registerModule(registry, "lib_shard_housekeeping", await import("../lib/shard-housekeeping"));

type Harness = ReturnType<typeof lunoraTest>;
type Row = Record<string, any>;

let harness: Harness;
let ownerId: string;

const NOT_APPROVED = /not approved/u;
const NOT_ONLINE = /not online/u;
const NOT_OFFERED = /did not offer/u;
const NOT_FOUND = /not found/u;
const ANOTHER_PROJECT = /another project/u;
const NOT_IN_PROJECT = /not allowed in this project/u;

const OFFER = { agentKey: "claude", agentLabel: "Claude Code", folderId: "f1", folderLabel: "neore" };
const SESSION_OPEN = { ...OFFER, kind: "session_open" };

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertUser = async () =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", { createdAt: 0, email: `u${String(Math.random())}@example.com`, emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;

let manifestAt = 0;

const OUT_OF_DATE = /out of date/;
const NOT_ALLOWED = /does not allow agents on your computer/u;

const manifest = async (deviceId: string, secret: string, extra: Record<string, unknown>) => {
    manifestAt += 1;

    const payload = JSON.stringify({ deviceId, issuedAt: Date.now() + manifestAt, kind: "manifest", tools: [], v: 1, ...extra });

    return { deviceId, payload, signature: await signDevicePayload(secret, "manifest", payload) };
};

interface Device {
    deviceId: string;
    secret: string;
}

/** A paired, online device that offers the (agent, folder) pair. */
const pairedDevice = async (userId: string, offers: unknown[] = [OFFER]): Promise<Device> => {
    const { deviceId, secret } = (await as(userId).mutation(devices.registerDevice as never, { name: "Laptop", platform: "linux" } as never)) as Device;

    await as(userId).mutation(devices.updateDeviceManifest as never, (await manifest(deviceId, secret, { acpOffers: offers })) as never);

    return { deviceId, secret };
};

const run = async <T>(read: (ctx: any) => Promise<T>): Promise<T> => (await harness.run(read)) as T;

const rows = async (table: string, where: Row = {}): Promise<Row[]> =>
    await run(async (ctx) => {
        const { page } = await ctx.db[table].findMany({ where });

        return page as Row[];
    });

const findRow = async (table: string, where: Row, matches: (candidate: Row) => boolean): Promise<Row | undefined> => {
    const found = await rows(table, where);

    return found.find((candidate) => matches(candidate));
};

const fieldOf = async (id: string, key: string): Promise<unknown> => {
    const found = await row(id);

    return found?.[key];
};

const sessionStatus = async (): Promise<unknown> => {
    const [session] = await rows("acpSessions");

    return session?.status;
};

const sessionStatusOf = async (threadId: string): Promise<unknown> => {
    const [session] = await rows("acpSessions", { threadId });

    return session?.status;
};

const row = async (id: string): Promise<Row | null> =>
    await run(
        async (ctx) =>
            (await ctx.db.get("devices", id as never)) ??
            (await ctx.db.get("threads", id as never)) ??
            (await ctx.db.get("deviceCalls", id as never)) ??
            (await ctx.db.get("acpSessions", id as never)),
    );

/** A local-style session on the device: the desktop's `session_open`, as the ingest applies it. */
const openSession = async (device: Device, hostSessionId = "host-s1"): Promise<string> => {
    const result = await run(
        async (ctx) => await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [SESSION_OPEN], sessionId: hostSessionId }),
    );

    return result.threadId as string;
};

const sendText = async (threadId: string, text = "fix the bug", requestId = crypto.randomUUID(), userId = ownerId, unlockProof?: string) =>
    await run(async (ctx) => await ctx.runMutation(send.sendToHost, { plan: "free", requestId, text, threadId, unlockProof, userId }));

const outcomeOfSend = async (...args: Parameters<typeof sendText>): Promise<unknown> => {
    const result = await sendText(...args);

    return result.outcome;
};

const claim = async (device: Device, callId: string) =>
    await as(ownerId).mutation(devices.claimDeviceCall as never, { callId, deviceId: device.deviceId } as never);

const accept = async (device: Device, callId: string, fields: Record<string, unknown> = {}) => {
    const payload = JSON.stringify({
        callId,
        decision: "rule",
        deviceId: device.deviceId,
        kind: "result",
        output: "accepted",
        status: "completed",
        v: 1,
        ...fields,
    });

    return await as(ownerId).mutation(
        devices.completeDeviceCall as never,
        { callId, deviceId: device.deviceId, payload, signature: await signDevicePayload(device.secret, "result", payload) } as never,
    );
};

const check = async (callId: string) => await run(async (ctx) => await ctx.runMutation(calls.checkAcpCall, { callId }));

const sendCall = async (): Promise<Row> => {
    const [call] = await rows("deviceCalls", { toolName: "acp_send" });

    return call as Row;
};

const streamField = async (threadId: string, key: string): Promise<unknown> => {
    const stream = await streamOf(threadId);

    return stream[key];
};

const streamOf = async (threadId: string): Promise<Row> => {
    const [stream] = await rows("persistentStreams", { threadId });

    return stream as Row;
};

const addRequest = async (
    streamId: string,
    seq: number,
    requestId: string,
    kinds: string[] = ["allow_once", "allow_always", "reject_once"],
    complete?: boolean,
) =>
    await run(async (ctx) => {
        await ctx.db.persistentChunks.insert({
            event: {
                kind: "permission_request",
                options: kinds.map((kind) => {
                    return { kind, name: kind, optionId: `${requestId}-${kind}` };
                }),
                requestId,
                tool: "Run tests",
                ...(complete !== undefined && { complete }),
            },
            seq,
            streamId,
            text: "",
        });
        await ctx.db.patch("persistentStreams", streamId, { hostPendingPermissions: [requestId] });
    });

/** Several requests waiting at once on one stream. */
const addRequests = async (streamId: string, ids: string[]) => {
    for (const [seq, id] of ids.entries()) {
        await addRequest(streamId, seq, id);
    }

    await run(async (ctx) => await ctx.db.patch("persistentStreams", streamId as never, { hostPendingPermissions: ids }));
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    ownerId = await insertUser();
    activeOrganization.current = null;
    delete replica.project;
    delete replica.readable;
});

afterEach(() => {
    vi.useRealTimers();
    harness.close();
});

describe("the offers in a manifest", () => {
    it("stores the pairs a signed manifest offers, labels and ids only", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const device = await row(deviceId);

        expect(device?.acpOffers).toEqual([OFFER]);
    });

    it("shows them on the owner's device list, with the time each command was claimed in the audit list", async () => {
        const device = await pairedDevice(ownerId);
        const listed = (await as(ownerId).query(devices.listDevices as never, {} as never)) as Row[];

        expect(listed[0]?.acpOffers).toEqual([OFFER]);

        const threadId = await openSession(device);

        await sendText(threadId);

        const call = await sendCall();

        await claim(device, call._id);

        const audit = (await as(ownerId).query(devices.listDeviceCalls as never, {} as never)) as Row[];

        expect(audit.find((entry) => entry._id === call._id)?.claimedAt).toEqual(expect.any(Number));
    });

    it("clears them when a later manifest offers none, and keeps none for a shell that predates coding agents", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);

        await as(ownerId).mutation(devices.updateDeviceManifest as never, (await manifest(deviceId, secret, { acpOffers: [] })) as never);
        expect(await fieldOf(deviceId, "acpOffers")).toEqual([]);

        await as(ownerId).mutation(devices.updateDeviceManifest as never, (await manifest(deviceId, secret, {})) as never);
        expect(await fieldOf(deviceId, "acpOffers")).toEqual([]);
    });

    it("refuses a malformed list whole and bounds every field", () => {
        expect(parseAcpOffers([{ ...OFFER, agentKey: "" }])).toBeNull();
        // A label is only shown, so a long one is cut; an id too long to match is still refused.
        expect(parseAcpOffers([{ ...OFFER, folderLabel: "x".repeat(201) }])?.[0]?.folderLabel).toBe("x".repeat(200));
        expect(parseAcpOffers([{ ...OFFER, folderId: "x".repeat(129) }])).toBeNull();
        expect(parseAcpOffers([{ agentKey: "claude" }])).toBeNull();
        expect(parseAcpOffers("claude")).toBeNull();
        const tooMany = Array.from({ length: 51 }, (_, index) => {
            return { ...OFFER, folderId: `f${String(index)}` };
        });

        expect(parseAcpOffers(tooMany)).toBeNull();
        expect(parseAcpOffers([OFFER, OFFER])).toEqual([OFFER]);
    });
});

describe("startHostSession", () => {
    const start = async (clientId = "tap-1", overrides: Record<string, unknown> = {}, deviceId = "") =>
        await as(ownerId).mutation(remote.startHostSession as never, { agentKey: "claude", clientId, deviceId, folderId: "f1", ...overrides } as never);

    it("makes a host thread and a starting session and queues a signed acp_start for the approved pair", async () => {
        const device = await pairedDevice(ownerId);
        const result = (await start("tap-1", {}, device.deviceId)) as { started: boolean; threadId: string };

        expect(result.started).toBe(true);

        const thread = await row(result.threadId);
        const [session] = await rows("acpSessions");
        const [call] = await rows("deviceCalls", { toolName: "acp_start" });

        expect(thread).toMatchObject({ runner: "host", userId: ownerId });
        expect(session).toMatchObject({ agentKey: "claude", folderId: "f1", status: "starting", threadId: result.threadId });

        const envelope = JSON.parse(call?.envelope as string) as Row;

        expect(envelope).toMatchObject({ deviceId: device.deviceId, tool: "acp_start" });
        expect(envelope.input).toEqual({ agentKey: "claude", folderId: "f1", sessionId: session?.hostSessionId, threadId: result.threadId });
        // No path and no command line ever leave the desktop, so none can be in the call.
        expect(call?.envelope).not.toContain("/");
    });

    it("tells the person to update an outdated computer instead of calling it busy or unavailable", async () => {
        const device = await pairedDevice(ownerId);

        await run(async (ctx) => await ctx.db.patch("devices", device.deviceId, { hostProtocol: MIN_DEVICE_PROTOCOL - 1 }));
        await expect(start("tap-old", {}, device.deviceId)).rejects.toThrow(OUT_OF_DATE);
    });

    it("starts one session for a double tap", async () => {
        const device = await pairedDevice(ownerId);
        const first = (await start("tap-1", {}, device.deviceId)) as { threadId: string };
        const second = (await start("tap-1", {}, device.deviceId)) as { started: boolean; threadId?: string };

        expect(second).toEqual({ started: false, threadId: first.threadId });
        expect(await rows("acpSessions")).toHaveLength(1);
        expect(await rows("deviceCalls", { toolName: "acp_start" })).toHaveLength(1);
    });

    it("hands a retry its thread after the agent opened, or the session ended", async () => {
        const device = await pairedDevice(ownerId);
        const first = (await start("tap-1", {}, device.deviceId)) as { threadId: string };
        const [session] = await rows("acpSessions");

        for (const status of ["idle", "ended"]) {
            await run(async (ctx) => await ctx.db.patch("acpSessions", session?._id as never, { status }));

            expect(await start("tap-1", {}, device.deviceId)).toEqual({ started: false, threadId: first.threadId });
        }
    });

    it("refuses a pair the computer did not offer, an offline computer and another user's device", async () => {
        const device = await pairedDevice(ownerId);

        await expect(start("a", { folderId: "somewhere-else" }, device.deviceId)).rejects.toThrow(NOT_APPROVED);
        await expect(start("b", { agentKey: "codex" }, device.deviceId)).rejects.toThrow(NOT_APPROVED);

        const stranger = await insertUser();
        const theirs = await pairedDevice(stranger);

        await expect(start("c", {}, theirs.deviceId)).rejects.toThrow(NOT_APPROVED);

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 10 * 60_000);
        await expect(start("d", {}, device.deviceId)).rejects.toThrow(NOT_ONLINE);
        expect(await rows("acpSessions")).toHaveLength(0);
    });

    it("moves to idle when the computer's agent opens the session, and ends if the start is refused", async () => {
        const device = await pairedDevice(ownerId);

        await start("tap-1", {}, device.deviceId);

        const [session] = await rows("acpSessions");

        await run(
            async (ctx) =>
                await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [SESSION_OPEN], sessionId: session?.hostSessionId as string }),
        );
        expect(await sessionStatus()).toBe("idle");
        expect(await rows("acpSessions")).toHaveLength(1);
        expect(await rows("threads", { runner: "host" })).toHaveLength(1);

        // A refused start ends its session instead of leaving it starting for ever.
        const second = (await start("tap-2", {}, device.deviceId)) as { threadId: string };
        const open = (await findRow("deviceCalls", { toolName: "acp_start" }, (call) => call.threadId === second.threadId)) as Row;

        await claim(device, open._id);
        await accept(device, open._id, { error: "refused: not approved on this computer", status: "failed" });

        const ended = await findRow("acpSessions", {}, (candidate) => candidate.threadId === second.threadId);

        expect(ended?.status).toBe("ended");
        expect(await row(open._id)).toMatchObject({ envelope: "", input: "", status: "failed" });
    });
});

describe("a start the computer accepted", () => {
    it("ends the session if its agent never opens it, and leaves one that did", async () => {
        const device = await pairedDevice(ownerId);
        const start = async (clientId: string) => {
            const { threadId } = (await as(ownerId).mutation(
                remote.startHostSession as never,
                { agentKey: "claude", clientId, deviceId: device.deviceId, folderId: "f1" } as never,
            )) as { threadId: string };
            const call = (await findRow("deviceCalls", { toolName: "acp_start" }, (candidate) => candidate.threadId === threadId)) as Row;

            await claim(device, call._id);
            await accept(device, call._id);

            return (await findRow("acpSessions", {}, (session) => session.threadId === threadId)) as Row;
        };
        const end = async (session: Row) =>
            await run(async (ctx) => await ctx.runMutation(calls.endUnopenedSession, { deviceId: device.deviceId, hostSessionId: session.hostSessionId }));
        const silent = await start("a");
        const opened = await start("b");

        await run(
            async (ctx) => await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [SESSION_OPEN], sessionId: opened.hostSessionId }),
        );
        await end(silent);
        await end(opened);

        expect(await fieldOf(silent._id, "status")).toBe("ended");
        expect(await fieldOf(opened._id, "status")).toBe("idle");
    });
});

describe("a message sent while the session is still starting", () => {
    const startedThread = async (device: Device) => {
        const { threadId } = (await as(ownerId).mutation(
            remote.startHostSession as never,
            { agentKey: "claude", clientId: "t", deviceId: device.deviceId, folderId: "f1" } as never,
        )) as { threadId: string };

        return threadId;
    };

    it("is accepted and held: the stream exists, the session stays starting, and opening it leaves it busy", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await startedThread(device);
        const result = await sendText(threadId, "fix the bug");

        expect(result.outcome).toBe("sent");
        expect(await streamField(threadId, "hostState")).toBe("accepted");
        expect(await sessionStatus()).toBe("starting");

        const [session] = await rows("acpSessions");

        await run(
            async (ctx) =>
                await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [SESSION_OPEN], sessionId: session?.hostSessionId as string }),
        );
        expect(await sessionStatus()).toBe("busy");
    });

    it("opens idle when nothing was waiting for it", async () => {
        const device = await pairedDevice(ownerId);

        await startedThread(device);

        const [session] = await rows("acpSessions");

        await run(
            async (ctx) =>
                await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [SESSION_OPEN], sessionId: session?.hostSessionId as string }),
        );
        expect(await sessionStatus()).toBe("idle");
    });

    it("keeps the session starting while the computer posts the held turn, so the agent opening it is still seen", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await startedThread(device);

        await sendText(threadId, "fix the bug");

        const [session] = await rows("acpSessions");
        const stream = await streamOf(threadId);

        await run(
            async (ctx) =>
                await ctx.runMutation(applyHostEvents, {
                    deviceId: device.deviceId,
                    events: [{ kind: "turn_start", text: "fix the bug" }],
                    firstSeq: 0,
                    sessionId: session?.hostSessionId as string,
                    threadId,
                    turnId: stream.hostTurnId as string,
                }),
        );
        expect(await streamField(threadId, "hostState")).toBe("received");
        expect(await sessionStatus()).toBe("starting");
    });

    it("ends the held stream with an error when the agent never opens the session", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await startedThread(device);
        const call = (await findRow("deviceCalls", { toolName: "acp_start" }, (candidate) => candidate.threadId === threadId)) as Row;

        await claim(device, call._id);
        await accept(device, call._id);
        await sendText(threadId, "fix the bug");

        const [session] = await rows("acpSessions");

        await run(
            async (ctx) => await ctx.runMutation(calls.endUnopenedSession, { deviceId: device.deviceId, hostSessionId: session?.hostSessionId as string }),
        );

        expect(await sessionStatus()).toBe("ended");
        expect(await streamOf(threadId)).toMatchObject({ hostEndReason: "failed", hostState: "ended", status: "error" });

        const messages = await rows("messages", { threadId });
        const reply = messages.find((message) => message.message?.role === "assistant");

        expect(reply?.error).toContain("did not start");
    });

    it("ends the held stream when the start itself is refused", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await startedThread(device);
        const call = (await findRow("deviceCalls", { toolName: "acp_start" }, (candidate) => candidate.threadId === threadId)) as Row;

        await sendText(threadId, "fix the bug");
        await claim(device, call._id);
        await accept(device, call._id, { error: "refused: not approved on this computer", status: "failed" });

        expect(await streamOf(threadId)).toMatchObject({ hostState: "ended", status: "error" });
    });
});

describe("sendToHost", () => {
    const readyThread = async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        return { device, threadId };
    };

    it("stores the prompt, an accepted stream and a signed acp_send before anything reaches the computer", async () => {
        const { device, threadId } = await readyThread();
        const result = await sendText(threadId, "fix the bug");

        expect(result.outcome).toBe("sent");

        const stream = await streamOf(threadId);
        const call = await sendCall();
        const envelope = JSON.parse(call.envelope as string) as Row;
        const [prompt] = await rows("messages", { threadId });

        expect(stream).toMatchObject({ hostState: "accepted", messageId: result.messageId, producer: "host", status: "pending", userId: ownerId });
        expect(prompt?.message).toMatchObject({ content: "fix the bug", role: "user" });
        expect(envelope).toMatchObject({ deviceId: device.deviceId, tool: "acp_send" });
        expect(envelope.input).toMatchObject({ sessionId: "host-s1", text: "fix the bug", turnId: stream.hostTurnId });
        expect(await sessionStatus()).toBe("busy");
    });

    it("strips hidden characters from the prompt on every send, so the saved message and the computer get only the visible text", async () => {
        const { threadId } = await readyThread();
        const hidden = "fix\u{E0041} the\u{202E} bug\u{200B}";
        const result = await sendText(threadId, hidden);

        expect(result.outcome).toBe("sent");

        const call = await sendCall();
        const envelope = JSON.parse(call.envelope as string) as Row;
        const [prompt] = await rows("messages", { threadId });

        expect(prompt?.message).toMatchObject({ content: "fix the bug", role: "user" });
        expect(envelope.input).toMatchObject({ text: "fix the bug" });
    });

    it("answers a retry of the same request with the first try, not a second turn", async () => {
        const { threadId } = await readyThread();
        const first = await sendText(threadId, "fix the bug", "req-1");
        const again = await sendText(threadId, "fix the bug", "req-1");

        expect(again).toMatchObject({ messageId: first.messageId, outcome: "duplicate", streamId: first.streamId });
        expect(await rows("persistentStreams", { threadId })).toHaveLength(1);
        expect(await rows("deviceCalls", { toolName: "acp_send" })).toHaveLength(1);
    });

    it("answers a retry with the turn it started, not a later one on the same thread", async () => {
        const { threadId } = await readyThread();
        const first = await sendText(threadId, "one", "req-1");

        await run(async (ctx) => {
            const stream = await ctx.db.persistentStreams.findFirst({ where: { threadId: threadId as never } });

            await ctx.db.patch("persistentStreams", stream?._id as never, { status: "done" });
        });
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });

        const second = await sendText(threadId, "two", "req-2");
        const again = await sendText(threadId, "one", "req-1");

        expect(second.outcome).toBe("sent");
        expect(again).toMatchObject({ messageId: first.messageId, outcome: "duplicate", streamId: first.streamId });
    });

    it("sends only into the owner's own host thread, and one turn at a time", async () => {
        const { threadId } = await readyThread();
        const stranger = await insertUser();
        const cloud = await run(async (ctx) => await ctx.db.insert("threads", { status: "active", title: "Cloud", userId: ownerId }));

        expect(await outcomeOfSend(threadId, "hi", "r1", stranger)).toBe("not_found");
        expect(await outcomeOfSend(cloud as string, "hi", "r2")).toBe("not_found");
        expect(await outcomeOfSend("nonsense", "hi", "r3")).toBe("not_found");
        expect(await outcomeOfSend(threadId, "one")).toBe("sent");
        expect(await outcomeOfSend(threadId, "two")).toBe("turn_running");
        expect(await rows("messages", { threadId })).toHaveLength(1);
    });

    describe("a locked thread", () => {
        const SECRET = "unlock-secret-for-host-send";
        let epoch: string;

        const lock = async (threadId: string) => {
            epoch = newPasscodeEpoch();

            const hashed = await hashPasscode("a passcode", 1000);

            await run(async (ctx) => {
                await ctx.db.patch("threads", threadId as never, { lockedAt: Date.now() });
                await ctx.db.insert("threadPasscodes", {
                    createdAt: 1,
                    epoch,
                    failedAttempts: 0,
                    hash: hashed.hash,
                    iterations: hashed.iterations,
                    salt: hashed.salt,
                    threadId: threadId as never,
                    updatedAt: 1,
                    userId: ownerId,
                });
            });
        };

        const proofFor = async (threadId: string, userId = ownerId): Promise<string> => {
            const { proof } = await mintUnlockProof({ epoch, threadId, userId }, SECRET, Date.now());

            return proof;
        };

        beforeEach(() => {
            vi.stubEnv("STORAGE_SIGNING_SECRET", SECRET);
        });

        it("takes a message with the owner's unlock proof", async () => {
            const { threadId } = await readyThread();

            await lock(threadId);

            const result = await sendText(threadId, "one", "r1", ownerId, await proofFor(threadId));

            expect(result.outcome).toBe("sent");
            expect(await rows("messages", { threadId })).toHaveLength(1);
        });

        it("refuses a message without a proof, with a stale one and with another thread's, and writes nothing", async () => {
            const { threadId } = await readyThread();
            const other = await openSession(await pairedDevice(ownerId), "host-s9");

            await lock(threadId);

            const stale = await proofFor(threadId);

            await run(async (ctx) => {
                const { page } = await ctx.db.threadPasscodes.findMany({ where: { threadId } });
                const [passcode] = page;

                await ctx.db.patch("threadPasscodes", passcode._id, { epoch: newPasscodeEpoch() });
            });

            expect(await outcomeOfSend(threadId, "one", "r1")).toBe("locked");
            expect(await outcomeOfSend(threadId, "one", "r2", ownerId, "garbage")).toBe("locked");
            expect(await outcomeOfSend(threadId, "one", "r3", ownerId, stale)).toBe("locked");
            expect(await outcomeOfSend(other, "one", "r4", ownerId, stale)).toBe("sent");
            expect(await rows("messages", { threadId })).toHaveLength(0);
            expect(await rows("deviceCalls", { toolName: "acp_send" })).toHaveLength(1);
        });

        it("answers a retry of a message that was sent before the lock as a duplicate", async () => {
            const { threadId } = await readyThread();
            const first = await sendText(threadId, "one", "r1");

            expect(first.outcome).toBe("sent");

            await lock(threadId);

            expect(await sendText(threadId, "one", "r1")).toMatchObject({ messageId: first.messageId, outcome: "duplicate", streamId: first.streamId });
            expect(await outcomeOfSend(threadId, "two", "r2")).toBe("locked");
        });
    });

    it("refuses a session that has ended, an offline computer and a prompt past the call's cap", async () => {
        const device = await pairedDevice(ownerId);

        const open = await openSession(device, "host-s2");

        expect(await outcomeOfSend(open, "x".repeat(40_000))).toBe("too_large");

        await run(async (ctx) => {
            const { page } = await ctx.db.acpSessions.findMany({ where: { threadId: open } });
            const [session] = page;

            await ctx.db.patch("acpSessions", session._id, { status: "ended" });
        });
        expect(await outcomeOfSend(open)).toBe("session_ended");

        const idle = await openSession(device, "host-s3");

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 10 * 60_000);
        expect(await outcomeOfSend(idle)).toBe("offline");
        expect(await rows("persistentStreams", { threadId: idle })).toHaveLength(0);
    });

    it("moves the turn to received on the computer's accepted result and clears the prompt", async () => {
        const { device, threadId } = await readyThread();

        await sendText(threadId, "secret prompt");

        const call = await sendCall();

        await expect(claim(device, call._id)).resolves.toEqual({ claimed: true });
        await expect(accept(device, call._id)).resolves.toEqual({ accepted: true });

        expect(await streamField(threadId, "hostState")).toBe("received");
        expect(await sendCall()).toMatchObject({ envelope: "", input: "", status: "completed" });
    });

    it("ends the turn with the reason when the computer refuses the prompt, and frees the session", async () => {
        const { device, threadId } = await readyThread();

        await sendText(threadId);

        const call = await sendCall();

        await claim(device, call._id);
        await accept(device, call._id, { error: "refused: no such session", status: "failed" });

        const stream = await streamOf(threadId);
        const reply = await findRow("messages", { threadId }, (message) => message.message.role === "assistant");

        expect(stream).toMatchObject({ hostEndReason: "failed", hostState: "ended", status: "error" });
        expect(reply?.error).toContain("no such session");
        expect(await sessionStatus()).toBe("idle");
    });
});

describe("a continue from the web", () => {
    it("reaches the agent and streams back to every client, from the send to the saved reply", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);
        const post = async (firstSeq: number, events: unknown[], turnId: string) =>
            await run(
                async (ctx) => await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events, firstSeq, sessionId: "host-s1", threadId, turnId }),
            );
        const bodyOf = async (streamId: string) => (await as(ownerId).query(streaming.getStreamBody as never, { streamId } as never)) as Row;

        // The web sends: stored, signed, not yet anywhere near the agent.
        const sent = await sendText(threadId, "now add a test");
        const stream = await streamOf(threadId);
        const turnId = stream.hostTurnId as string;

        expect(await bodyOf(sent.streamId)).toMatchObject({ hostState: "accepted", status: "pending" });

        // The page relays the call; the computer takes it and says so.
        const call = await sendCall();

        expect(JSON.parse(call.envelope as string).input).toMatchObject({ text: "now add a test", turnId });
        await claim(device, call._id);
        await accept(device, call._id);
        expect(await bodyOf(sent.streamId)).toMatchObject({ hostState: "received" });

        // The agent starts: the computer posts the turn under the id the backend minted, from the first event.
        await post(
            0,
            [
                { kind: "turn_start", text: "now add a test" },
                { kind: "text", text: "Adding " },
            ],
            turnId,
        );
        expect(await bodyOf(sent.streamId)).toMatchObject({ hostState: "running", status: "streaming", text: "Adding " });

        await post(
            2,
            [
                { kind: "text", text: "the test." },
                { kind: "turn_end", reason: "finished" },
            ],
            turnId,
        );

        // Every client reads the same end, and the reply is saved under the prompt that was sent.
        expect(await bodyOf(sent.streamId)).toMatchObject({ hostState: "ended", status: "done", text: "Adding the test." });

        const messages = await rows("messages", { threadId });
        const reply = messages.find((message) => message.message.role === "assistant");

        expect(messages.find((message) => message.message.role === "user")?._id).toBe(sent.messageId);
        expect(JSON.stringify(reply?.message)).toContain("Adding the test.");
        expect(await sessionStatus()).toBe("idle");
        // And the thread takes the next message.
        expect(await outcomeOfSend(threadId, "thanks")).toBe("sent");
    });
});

describe("a project remembers its runner", () => {
    const startIn = async (projectId: string, device: Device, clientId: string, overrides: Record<string, unknown> = {}) =>
        await as(ownerId).mutation(
            remote.startHostSession as never,
            { agentKey: "claude", clientId, deviceId: device.deviceId, folderId: "f1", projectId, ...overrides } as never,
        );

    const defaultOf = async (projectId: string, userId = ownerId) => await as(userId).query(remote.getProjectRunnerDefault as never, { projectId } as never);

    // The computer's agent opens the session: the project's default is recorded then, not when the start is queued.
    const startOpened = async (projectId: string, device: Device, clientId: string, overrides: Record<string, unknown> = {}) => {
        const started = (await startIn(projectId, device, clientId, overrides)) as { threadId: string };
        const [session] = await rows("acpSessions", { threadId: started.threadId });

        await run(
            async (ctx) =>
                await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [SESSION_OPEN], sessionId: session?.hostSessionId as string }),
        );

        return started;
    };

    const insertProject = async (fields: Record<string, unknown>): Promise<string> =>
        (await run(async (ctx) => await ctx.db.insert("projects", { createdAt: 0, title: "Billing", ...fields }))) as string;

    const projectRow = async (projectId: string): Promise<Row | null> => await run(async (ctx) => await ctx.db.get("projects", projectId as never));

    it("preselects the computer and agent of the last host thread started in the project, and the next one starts on them", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: ownerId });

        expect(await defaultOf(projectId)).toBeNull();

        const first = await startOpened(projectId, device, "tap-p1");

        expect(await row(first.threadId)).toMatchObject({ projectId, runner: "host" });
        expect(await defaultOf(projectId)).toEqual({ agentKey: "claude", deviceId: device.deviceId, folderId: "f1" });

        const preselected = (await defaultOf(projectId)) as Row;
        const second = (await as(ownerId).mutation(remote.startHostSession as never, { ...preselected, clientId: "tap-p2", projectId } as never)) as {
            started: boolean;
            threadId: string;
        };

        expect(second.started).toBe(true);
        expect(await row(second.threadId)).toMatchObject({ projectId, runner: "host" });
    });

    it("keeps an organization project's default on the starter's own settings, out of a member's reach", async () => {
        activeOrganization.current = { id: "org-a", name: "Org", role: "member", slug: null };
        const member = await insertUser();

        await run(async (ctx) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: ownerId });
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: member });
            await ctx.db.insert("organizationPolicies", {
                document: JSON.stringify({ permissionCap: "auto", schemaVersion: 1 }),
                organizationId: "org-a",
                revision: 1,
                schemaVersion: 1,
                updatedAt: Date.now(),
            });
        });

        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ organizationId: "org-a", userId: ownerId });

        await startOpened(projectId, device, "tap-o1");

        const stored = await projectRow(projectId);

        expect(stored?.runnerKind).toBeUndefined();
        expect(await defaultOf(projectId)).toEqual({ agentKey: "claude", deviceId: device.deviceId, folderId: "f1" });
        expect(await defaultOf(projectId, member)).toBeNull();
    });

    it("drops the defaults of deleted projects before it pushes out a live one at the cap", async () => {
        activeOrganization.current = { id: "org-a", name: "Org", role: "member", slug: null };
        await run(async (ctx) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: ownerId });
            await ctx.db.insert("organizationPolicies", {
                document: JSON.stringify({ permissionCap: "auto", schemaVersion: 1 }),
                organizationId: "org-a",
                revision: 1,
                schemaVersion: 1,
                updatedAt: Date.now(),
            });
        });

        const device = await pairedDevice(ownerId);
        const live = await insertProject({ organizationId: "org-a", userId: ownerId });
        const runner = { agentKey: "claude", deviceId: device.deviceId, folderId: "f1" };

        await startOpened(live, device, "tap-live");

        // 199 projects that were deleted, recorded after the live one: the record is at the cap, and the live entry is the oldest.
        await run(async (ctx) => {
            const gone: string[] = [];

            for (let index = 0; index < 199; index += 1) {
                gone.push((await ctx.db.insert("projects", { createdAt: 0, organizationId: "org-a", title: "Gone", userId: ownerId })) as string);
            }

            for (const id of gone) {
                await ctx.db.delete("projects", id as never);
            }

            const settings = await ctx.db.userSettings.findFirst({ where: { userId: ownerId } });

            await ctx.db.patch(
                "userSettings",
                settings?._id as never,
                {
                    projectRunnerDefaults: { ...settings?.projectRunnerDefaults, ...Object.fromEntries(gone.map((id) => [id, runner])) },
                } as never,
            );
        });

        await startOpened(await insertProject({ organizationId: "org-a", userId: ownerId }), device, "tap-new");

        expect(await defaultOf(live)).toEqual(runner);
    });

    it("hands no default to a member whose membership was revoked, though a replica still admits them", async () => {
        activeOrganization.current = { id: "org-a", name: "Org", role: "member", slug: null };
        const creator = await insertUser();

        await run(async (ctx) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: ownerId });
            await ctx.db.insert("organizationPolicies", {
                document: JSON.stringify({ permissionCap: "auto", schemaVersion: 1 }),
                organizationId: "org-a",
                revision: 1,
                schemaVersion: 1,
                updatedAt: Date.now(),
            });
        });

        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ organizationId: "org-a", userId: creator });

        const project = (await projectRow(projectId)) as never;

        await run(
            async (ctx) =>
                await projectRunner.rememberProjectRunner(ctx, project, ownerId, { agentKey: "claude", deviceId: device.deviceId, folderId: "f1" }, Date.now()),
        );

        expect(await defaultOf(projectId)).toEqual({ agentKey: "claude", deviceId: device.deviceId, folderId: "f1" });

        const [membership] = await rows("member", { userId: ownerId });

        await run(async (ctx) => await ctx.db.delete("member", membership?._id as never));
        replica.readable = (await projectRow(projectId)) as Record<string, unknown>;

        expect(await defaultOf(projectId)).toBeNull();
    });

    it("records nothing for a thread started before the project's last move", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ organizationChangedAt: 2000, organizationId: "org-a", userId: ownerId });
        const project = (await projectRow(projectId)) as never;

        await run(
            async (ctx) =>
                await projectRunner.rememberProjectRunner(ctx, project, ownerId, { agentKey: "claude", deviceId: device.deviceId, folderId: "f1" }, 1000),
        );

        const [settings] = await rows("userSettings", { userId: ownerId });

        expect((settings?.projectRunnerDefaults as Record<string, unknown> | undefined)?.[projectId]).toBeUndefined();
    });

    it("drops defaults that can never be used again before it pushes out a live one at the cap", async () => {
        activeOrganization.current = { id: "org-a", name: "Org", role: "member", slug: null };
        await run(async (ctx) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: ownerId });
            await ctx.db.insert("organizationPolicies", {
                document: JSON.stringify({ permissionCap: "auto", schemaVersion: 1 }),
                organizationId: "org-a",
                revision: 1,
                schemaVersion: 1,
                updatedAt: Date.now(),
            });
        });

        const device = await pairedDevice(ownerId);
        const otherDevice = await pairedDevice(await insertUser());
        const creator = await insertUser();
        const runner = { agentKey: "claude", deviceId: device.deviceId, folderId: "f1" };
        const live = await insertProject({ organizationId: "org-a", userId: ownerId });

        await startOpened(live, device, "tap-u0");

        // Right after the live entry, one of each kind that can never be returned again: a project moved out of the organization,
        // one moved after its thread started, one of an organization the person is not in, and one on a computer that is not
        // theirs. Then live projects up to the cap, so the live entry is the oldest and every checked project still exists.
        const unusable = await run(async (ctx) => {
            const insert = async (fields: Record<string, unknown>) =>
                (await ctx.db.insert("projects", { createdAt: 0, title: "Unusable", userId: ownerId, ...fields })) as string;

            return [
                [await insert({ organizationId: "" }), runner],
                [await insert({ organizationChangedAt: 2000, organizationId: "org-a" }), { ...runner, threadAt: 1000 }],
                [await insert({ organizationId: "org-b", userId: creator }), runner],
                [await insert({ organizationId: "org-a" }), { ...runner, deviceId: otherDevice.deviceId }],
            ] as [string, Record<string, unknown>][];
        });

        await run(async (ctx) => {
            const others: [string, unknown][] = [];

            for (let index = 0; index < 199 - unusable.length; index += 1) {
                others.push([(await ctx.db.insert("projects", { createdAt: 0, organizationId: "org-a", title: "Live", userId: ownerId })) as string, runner]);
            }

            const settings = await ctx.db.userSettings.findFirst({ where: { userId: ownerId } });

            await ctx.db.patch(
                "userSettings",
                settings?._id as never,
                { projectRunnerDefaults: { ...settings?.projectRunnerDefaults, ...Object.fromEntries([...unusable, ...others]) } } as never,
            );
        });

        await startOpened(await insertProject({ organizationId: "org-a", userId: ownerId }), device, "tap-u1");

        const [settings] = await rows("userSettings", { userId: ownerId });
        const stored = settings?.projectRunnerDefaults as Record<string, unknown>;

        expect(await defaultOf(live)).toEqual(runner);
        expect(unusable.filter(([key]) => stored[key] !== undefined)).toEqual([]);
        expect(Object.keys(stored)).toHaveLength(200 - unusable.length + 1);
    });

    it("looks up only the oldest few defaults at the cap, and drops the oldest when their projects all exist", async () => {
        activeOrganization.current = { id: "org-a", name: "Org", role: "member", slug: null };
        await run(async (ctx) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: ownerId });
            await ctx.db.insert("organizationPolicies", {
                document: JSON.stringify({ permissionCap: "auto", schemaVersion: 1 }),
                organizationId: "org-a",
                revision: 1,
                schemaVersion: 1,
                updatedAt: Date.now(),
            });
        });

        const device = await pairedDevice(ownerId);
        const runner = { agentKey: "claude", deviceId: device.deviceId, folderId: "f1" };
        const oldest = await insertProject({ organizationId: "org-a", userId: ownerId });

        await startOpened(oldest, device, "tap-c0");

        // 191 live projects after the oldest, then 8 deleted ones: the record is at the cap, and no deleted one is among the oldest.
        await run(async (ctx) => {
            const live: string[] = [];
            const gone: string[] = [];

            for (let index = 0; index < 191; index += 1) {
                live.push((await ctx.db.insert("projects", { createdAt: 0, organizationId: "org-a", title: "Live", userId: ownerId })) as string);
            }

            for (let index = 0; index < 8; index += 1) {
                gone.push((await ctx.db.insert("projects", { createdAt: 0, organizationId: "org-a", title: "Gone", userId: ownerId })) as string);
            }

            for (const id of gone) {
                await ctx.db.delete("projects", id as never);
            }

            const settings = await ctx.db.userSettings.findFirst({ where: { userId: ownerId } });

            await ctx.db.patch(
                "userSettings",
                settings?._id as never,
                {
                    projectRunnerDefaults: { ...settings?.projectRunnerDefaults, ...Object.fromEntries([...live, ...gone].map((id) => [id, runner])) },
                } as never,
            );
        });

        const next = await insertProject({ organizationId: "org-a", userId: ownerId });

        await startOpened(next, device, "tap-c1");

        const [settings] = await rows("userSettings", { userId: ownerId });
        const stored = settings?.projectRunnerDefaults as Record<string, unknown>;

        expect(Object.keys(stored)).toHaveLength(200);
        expect(stored[oldest]).toBeUndefined();
        expect(stored[next]).toMatchObject(runner);
    });

    it.each([
        ["a personal project", undefined],
        ["an organization project", "org-a"],
    ])("keeps a newer thread's runner in %s when an older thread's session opens later (a switch or /clear there)", async (_, organizationId) => {
        if (organizationId) {
            activeOrganization.current = { id: organizationId, name: "Org", role: "member", slug: null };
            await run(async (ctx) => {
                await ctx.db.insert("member", { createdAt: 0, organizationId, role: "member", userId: ownerId });
                await ctx.db.insert("organizationPolicies", {
                    document: JSON.stringify({ permissionCap: "auto", schemaVersion: 1 }),
                    organizationId,
                    revision: 1,
                    schemaVersion: 1,
                    updatedAt: Date.now(),
                });
            });
        }

        const device = await pairedDevice(ownerId, [OFFER, { ...OFFER, folderId: "f2", folderLabel: "Other" }]);
        const projectId = await insertProject({ userId: ownerId, ...(organizationId && { organizationId }) });

        vi.useFakeTimers({ toFake: ["Date"] });

        const older = (await startIn(projectId, device, "tap-old", { folderId: "f2" })) as { threadId: string };

        vi.setSystemTime(Date.now() + 1000);
        await startOpened(projectId, device, "tap-new");

        const [olderSession] = await rows("acpSessions", { threadId: older.threadId });

        await run(
            async (ctx) =>
                await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [SESSION_OPEN], sessionId: olderSession?.hostSessionId as string }),
        );

        expect(await sessionStatusOf(older.threadId)).toBe("idle");
        expect(await defaultOf(projectId)).toEqual({ agentKey: "claude", deviceId: device.deviceId, folderId: "f1" });
    });

    it("offers no default once the computer stops offering that agent and folder", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: ownerId });

        await startOpened(projectId, device, "tap-p3");
        await run(async (ctx) => await ctx.db.patch("devices", device.deviceId as never, { acpOffers: [] }));

        expect(await defaultOf(projectId)).toBeNull();
    });

    it("keeps the default it had when a later start is refused by the computer after it was queued", async () => {
        const device = await pairedDevice(ownerId, [OFFER, { ...OFFER, folderId: "f2", folderLabel: "Other" }]);
        const projectId = await insertProject({ userId: ownerId });

        await startOpened(projectId, device, "tap-p9");
        const working = await defaultOf(projectId);

        expect(working).toEqual({ agentKey: "claude", deviceId: device.deviceId, folderId: "f1" });

        const started = (await startIn(projectId, device, "tap-p10", { folderId: "f2" })) as { threadId: string };
        const open = (await findRow("deviceCalls", { toolName: "acp_start" }, (call) => call.threadId === started.threadId)) as Row;

        await claim(device, open._id);
        await accept(device, open._id, { error: "refused: not approved on this computer", status: "failed" });

        expect(await defaultOf(projectId)).toEqual(working);
    });

    it("exports the personal runner of the user's own projects, one moved out of an organization too, and no organization project's", async () => {
        const device = await pairedDevice(ownerId);
        const personal = await insertProject({ title: "Mine", userId: ownerId });
        const movedOut = await insertProject({ organizationId: "", title: "Moved out", userId: ownerId });

        await startOpened(personal, device, "tap-x1");
        await startOpened(movedOut, device, "tap-x2");
        const organization = await insertProject({
            organizationId: "org-a",
            runnerAgentKey: "claude",
            runnerDeviceId: device.deviceId,
            runnerFolderId: "f1",
            runnerKind: "host",
            title: "Org",
            userId: ownerId,
        });

        const exported = (await run(async (ctx) => await ctx.runQuery(projectsGdpr.collectOwnedProjectsForExport, { userId: ownerId }))) as {
            projects: Row[];
        };
        const runnerOf = (projectId: string) => exported.projects.find((project) => project.projectId === projectId)?.runner;
        const runner = { agentKey: "claude", deviceId: device.deviceId, folderId: "f1" };

        expect(runnerOf(personal)).toEqual(runner);
        expect(runnerOf(movedOut)).toEqual(runner);
        expect(runnerOf(organization)).toBeUndefined();
    });

    it("refuses a start on a computer kept out of the project, and no longer offers it as the default there", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: ownerId });
        const otherId = await insertProject({ title: "Other", userId: ownerId });

        await startOpened(projectId, device, "tap-s1");
        await run(async (ctx) => await ctx.db.patch("devices", device.deviceId as never, { projectIds: [otherId] }));

        expect(await defaultOf(projectId)).toBeNull();
        await expect(startIn(projectId, device, "tap-s2")).rejects.toThrow(NOT_IN_PROJECT);
        expect(await rows("acpSessions")).toHaveLength(1);
    });

    it("answers a lost-answer retry with the thread after the computer was kept out of the project", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: ownerId });
        const otherId = await insertProject({ title: "Other", userId: ownerId });
        const first = (await startIn(projectId, device, "tap-s3")) as { threadId: string };

        await run(async (ctx) => await ctx.db.patch("devices", device.deviceId as never, { projectIds: [otherId] }));

        expect(await startIn(projectId, device, "tap-s3")).toEqual({ started: false, threadId: first.threadId });
    });

    it("records no personal runner on a project moved into an organization after it was read", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: ownerId });
        const read = (await projectRow(projectId)) as never;

        await run(async (ctx) => await ctx.db.patch("projects", projectId as never, { organizationId: "org-a" }));
        await run(
            async (ctx) =>
                await projectRunner.rememberProjectRunner(ctx, read, ownerId, { agentKey: "claude", deviceId: device.deviceId, folderId: "f1" }, Date.now()),
        );

        const stored = await projectRow(projectId);

        expect(stored?.runnerDeviceId).toBeUndefined();
    });

    it("answers a lost-answer retry with the thread after its project was deleted", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: ownerId });
        const first = (await startIn(projectId, device, "tap-d1")) as { threadId: string };

        await run(async (ctx) => await ctx.db.delete("projects", projectId as never));

        expect(await startIn(projectId, device, "tap-d1")).toEqual({ started: false, threadId: first.threadId });
        await expect(startIn(projectId, device, "tap-d2")).rejects.toThrow(NOT_FOUND);
    });

    it("leaves the owner's runner when a member's thread opens in a project moved out of the organization", async () => {
        activeOrganization.current = { id: "org-a", name: "Org", role: "member", slug: null };
        const member = await insertUser();

        await run(async (ctx) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: ownerId });
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: member });
            await ctx.db.insert("organizationPolicies", {
                document: JSON.stringify({ permissionCap: "auto", schemaVersion: 1 }),
                organizationId: "org-a",
                revision: 1,
                schemaVersion: 1,
                updatedAt: Date.now(),
            });
        });

        const ownerDevice = await pairedDevice(ownerId);
        const memberDevice = await pairedDevice(member);
        const projectId = await insertProject({ organizationId: "org-a", userId: ownerId });
        const started = (await as(member).mutation(
            remote.startHostSession as never,
            { agentKey: "claude", clientId: "tap-m1", deviceId: memberDevice.deviceId, folderId: "f1" } as never,
        )) as { threadId: string };
        const ownerRunner = { runnerAgentKey: "claude", runnerDeviceId: ownerDevice.deviceId, runnerFolderId: "f1", runnerKind: "host" };

        // The member's thread sits in the organization's project; the owner then takes the project back to their personal space,
        // with a runner of their own, before the member's agent opens.
        await run(async (ctx) => await ctx.db.patch("threads", started.threadId as never, { projectId: projectId as never }));
        await run(async (ctx) => await ctx.db.patch("projects", projectId as never, { organizationId: "", ...ownerRunner }));
        const [session] = await rows("acpSessions", { threadId: started.threadId });

        await run(
            async (ctx) =>
                await ctx.runMutation(applyHostEvents, {
                    deviceId: memberDevice.deviceId,
                    events: [SESSION_OPEN],
                    sessionId: session?.hostSessionId as string,
                }),
        );

        expect(await projectRow(projectId)).toMatchObject(ownerRunner);
    });

    it("forgets a personal runner when the project moves into an organization, so a move back restores nothing", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: ownerId });

        await startOpened(projectId, device, "tap-p8");
        const opened = await projectRow(projectId);

        expect(opened?.runnerDeviceId).toBe(device.deviceId);

        activeOrganization.current = { id: "org-a", name: "A", role: "member", slug: null };
        await run(async (ctx) => await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: ownerId }));
        await run(async (ctx) => await ctx.runMutation(agentProjects.updateProject, { patch: { organizationId: "org-a" }, projectId: projectId as never }));

        const moved = await projectRow(projectId);

        expect(moved?.organizationId).toBe("org-a");
        expect(moved?.runnerDeviceId).toBeUndefined();
        expect(moved?.runnerAgentKey).toBeUndefined();

        await run(async (ctx) => await ctx.runMutation(agentProjects.updateProject, { patch: { organizationId: "" }, projectId: projectId as never }));

        const movedBack = await projectRow(projectId);

        expect(movedBack?.runnerAgentKey).toBeUndefined();
        expect(await defaultOf(projectId)).toBeNull();
    });

    it("forgets a person's organization default when the project leaves the organization, so a move back restores nothing", async () => {
        activeOrganization.current = { id: "org-a", name: "A", role: "member", slug: null };
        await run(async (ctx) => {
            await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: ownerId });
            await ctx.db.insert("organizationPolicies", {
                document: JSON.stringify({ permissionCap: "auto", schemaVersion: 1 }),
                organizationId: "org-a",
                revision: 1,
                schemaVersion: 1,
                updatedAt: Date.now(),
            });
        });

        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ organizationId: "org-a", userId: ownerId });

        vi.useFakeTimers({ toFake: ["Date"] });
        await startOpened(projectId, device, "tap-o9");

        expect(await defaultOf(projectId)).toEqual({ agentKey: "claude", deviceId: device.deviceId, folderId: "f1" });

        vi.setSystemTime(Date.now() + 1000);
        await run(async (ctx) => await ctx.runMutation(agentProjects.updateProject, { patch: { organizationId: "" }, projectId: projectId as never }));
        await run(async (ctx) => await ctx.runMutation(agentProjects.updateProject, { patch: { organizationId: "org-a" }, projectId: projectId as never }));

        expect(await defaultOf(projectId)).toBeNull();

        // A thread started after the move records the default again.
        vi.setSystemTime(Date.now() + 1000);
        await startOpened(projectId, device, "tap-o10");

        expect(await defaultOf(projectId)).toEqual({ agentKey: "claude", deviceId: device.deviceId, folderId: "f1" });
    });

    it("hands a retry the thread of the project its first try was filed under, and refuses one named for another project", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: ownerId });
        const otherId = await insertProject({ title: "Other", userId: ownerId });
        const first = (await startIn(projectId, device, "tap-p5")) as { threadId: string };

        expect(await startIn(projectId, device, "tap-p5")).toEqual({ started: false, threadId: first.threadId });
        await expect(startIn(otherId, device, "tap-p5")).rejects.toThrow(ANOTHER_PROJECT);
        expect(await rows("acpSessions")).toHaveLength(1);
    });

    it("answers a lost-answer retry with the thread even after that thread was moved to another project", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: ownerId });
        const otherId = await insertProject({ title: "Other", userId: ownerId });
        const first = (await startIn(projectId, device, "tap-p7")) as { threadId: string };

        await run(async (ctx) => await ctx.db.patch("threads", first.threadId as never, { projectId: otherId as never }));

        expect(await startIn(projectId, device, "tap-p7")).toEqual({ started: false, threadId: first.threadId });
        await expect(startIn(otherId, device, "tap-p7")).rejects.toThrow(ANOTHER_PROJECT);
    });

    it("records no default for a start the computer refuses at once, and leaves no thread behind", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: ownerId });

        await run(async (ctx) => await ctx.db.patch("devices", device.deviceId as never, { hostProtocol: MIN_DEVICE_PROTOCOL - 1 }));
        await expect(startIn(projectId, device, "tap-p6")).rejects.toThrow(OUT_OF_DATE);

        const stored = await projectRow(projectId);

        expect(stored?.runnerAgentKey).toBeUndefined();
        expect(await rows("threads", { runner: "host" })).toHaveLength(0);
        expect(await rows("acpSessions")).toHaveLength(0);
    });

    it("refuses to file a thread into another person's project, and starts nothing", async () => {
        const device = await pairedDevice(ownerId);
        const projectId = await insertProject({ userId: await insertUser() });

        await expect(startIn(projectId, device, "tap-p4")).rejects.toThrow(NOT_FOUND);
        expect(await rows("acpSessions")).toHaveLength(0);
    });
});

describe("an organization's cap on coding agents", () => {
    const start = async (deviceId: string, clientId = "tap-org") =>
        await as(ownerId).mutation(remote.startHostSession as never, { agentKey: "claude", clientId, deviceId, folderId: "f1" } as never);

    const joinOrganization = async (organizationId = "org-a") =>
        await run(async (ctx) => await ctx.db.insert("member", { createdAt: 0, organizationId, role: "member", userId: ownerId }));

    const capOrganization = async (permissionCap: string, organizationId = "org-a") =>
        await run(
            async (ctx) =>
                await ctx.db.insert("organizationPolicies", {
                    document: JSON.stringify({ permissionCap, schemaVersion: 1 }),
                    organizationId,
                    revision: 1,
                    schemaVersion: 1,
                    updatedAt: Date.now(),
                }),
        );

    const sendAs = async (threadId: string, organizationId?: string): Promise<unknown> => {
        const result = await run(
            async (ctx) =>
                await ctx.runMutation(send.sendToHost, {
                    organizationId,
                    plan: "free",
                    requestId: crypto.randomUUID(),
                    text: "fix the bug",
                    threadId,
                    userId: ownerId,
                }),
        );

        return result.outcome;
    };

    it("files a start under the caller's organization when it allows agents, so its cap holds the chat in every space", async () => {
        const device = await pairedDevice(ownerId);

        await joinOrganization();
        activeOrganization.current = { id: "org-a", name: "A", role: "member", slug: null };

        const result = (await start(device.deviceId)) as { started: boolean; threadId: string };

        expect(result.started).toBe(true);
        expect(await row(result.threadId)).toMatchObject({ organizationId: "org-a", runner: "host" });
    });

    it("refuses a start when the caller's organization holds agents below auto, opening nothing", async () => {
        const device = await pairedDevice(ownerId);

        await joinOrganization();
        await capOrganization("ask");
        activeOrganization.current = { id: "org-a", name: "A", role: "member", slug: null };

        await expect(start(device.deviceId)).rejects.toThrow(NOT_ALLOWED);
        expect(await rows("acpSessions")).toHaveLength(0);
        expect(await rows("deviceCalls", { toolName: "acp_start" })).toHaveLength(0);
        expect(await rows("threads", { runner: "host" })).toHaveLength(0);
    });

    describe("an organization project's start from another space", () => {
        const organizationProject = async (): Promise<string> =>
            (await run(async (ctx) => await ctx.db.insert("projects", { createdAt: 0, organizationId: "org-a", title: "Billing", userId: ownerId }))) as string;

        const startIn = async (deviceId: string, projectId: string) =>
            await as(ownerId).mutation(
                remote.startHostSession as never,
                { agentKey: "claude", clientId: "tap-org-p", deviceId, folderId: "f1", projectId } as never,
            );

        it("refuses it when the project's organization holds agents below auto, though the caller is in another space", async () => {
            const device = await pairedDevice(ownerId);
            const projectId = await organizationProject();

            await joinOrganization();
            await capOrganization("ask");

            await expect(startIn(device.deviceId, projectId)).rejects.toThrow(NOT_ALLOWED);
            expect(await rows("acpSessions")).toHaveLength(0);
            expect(await rows("threads", { runner: "host" })).toHaveLength(0);
        });

        it("holds a start into a project moved out of an organization to the caller's organization's cap", async () => {
            const device = await pairedDevice(ownerId);
            const projectId = (await run(
                async (ctx) => await ctx.db.insert("projects", { createdAt: 0, organizationId: "", title: "Moved out", userId: ownerId }),
            )) as string;

            await joinOrganization();
            await capOrganization("ask");
            activeOrganization.current = { id: "org-a", name: "A", role: "member", slug: null };

            await expect(startIn(device.deviceId, projectId)).rejects.toThrow(NOT_ALLOWED);
            expect(await rows("threads", { runner: "host" })).toHaveLength(0);
        });

        it("holds a start to the cap of the organization the project moved into, though a replica still shows the one it left", async () => {
            const device = await pairedDevice(ownerId);
            const projectId = (await run(
                async (ctx) => await ctx.db.insert("projects", { createdAt: 0, organizationId: "org-b", title: "Billing", userId: ownerId }),
            )) as string;

            await joinOrganization("org-a");
            await joinOrganization("org-b");
            await capOrganization("auto", "org-a");
            await capOrganization("ask", "org-b");
            replica.project = { ...(await run(async (ctx) => await ctx.db.get("projects", projectId as never))), organizationId: "org-a" };

            await expect(startIn(device.deviceId, projectId)).rejects.toThrow(NOT_ALLOWED);
            expect(await rows("threads", { runner: "host" })).toHaveLength(0);
        });

        it("files the thread under the project's organization, so its cap holds the chat in every space", async () => {
            const device = await pairedDevice(ownerId);
            const projectId = await organizationProject();

            await joinOrganization();
            await capOrganization("auto");

            const result = (await startIn(device.deviceId, projectId)) as { started: boolean; threadId: string };

            expect(result.started).toBe(true);
            expect(await row(result.threadId)).toMatchObject({ organizationId: "org-a", projectId, runner: "host" });
        });
    });

    it("refuses a send into a chat filed under an organization that has since tightened its cap, or that its owner left", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await run(async (ctx) => await ctx.db.patch("threads", threadId as never, { organizationId: "org-a" }));
        await joinOrganization();
        await capOrganization("ask");

        // From the personal space too: the chat's own organization decides.
        expect(await sendAs(threadId)).toBe("not_allowed");

        const [member] = await rows("member", { userId: ownerId });

        await run(async (ctx) => await ctx.db.delete("member", member?._id));

        expect(await sendAs(threadId)).toBe("left_organization");
        expect(await rows("persistentStreams", { threadId })).toHaveLength(0);
        expect(await rows("deviceCalls", { toolName: "acp_send" })).toHaveLength(0);
    });

    it("caps a send into a personal host chat by the caller's organization", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await joinOrganization();
        await capOrganization("ask");

        expect(await sendAs(threadId, "org-a")).toBe("not_allowed");
        expect(await sendAs(threadId)).toBe("sent");
    });
});

describe("the clock on a command", () => {
    it("expires a command nobody claimed in its window with 'host did not answer', and nothing runs later", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });

        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId, "later?");

        const call = await sendCall();

        vi.setSystemTime(Date.now() + ACP_CLAIM_WINDOW_MS + 2000);
        await check(call._id);

        const expired = await row(call._id);
        const stream = await streamOf(threadId);
        const reply = await findRow("messages", { threadId }, (message) => message.message.role === "assistant");

        expect(expired).toMatchObject({ error: "host did not answer", input: "", status: "expired" });
        expect(stream).toMatchObject({ hostEndReason: "failed", hostState: "ended" });
        expect(reply?.error).toContain("did not answer");
        // A host that comes back finds nothing to claim and nothing pending to run.
        await expect(claim(device, call._id)).resolves.toEqual({ claimed: false });
        await expect(as(ownerId).query(devices.listPendingDeviceCalls as never, { deviceId: device.deviceId } as never)).resolves.toEqual([]);
    });

    it("returns a claimed command to pending when its lease lapses, and lets it be claimed again until its deadline", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });

        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);

        const call = await sendCall();

        await claim(device, call._id);
        // Not yet: a check that fires early does nothing.
        await check(call._id);
        expect(await fieldOf(call._id, "status")).toBe("claimed");

        // The main process died between the claim and the receipt: the lease lapses.
        vi.setSystemTime(Date.now() + ACP_CLAIM_LEASE_MS + 1000);
        await check(call._id);
        expect(await fieldOf(call._id, "status")).toBe("pending");
        await expect(as(ownerId).query(devices.listPendingDeviceCalls as never, { deviceId: device.deviceId } as never)).resolves.toHaveLength(1);

        // Past the claim window: the window decides whether a call is ever taken, not a second look.
        vi.setSystemTime(Date.now() + ACP_CLAIM_WINDOW_MS);
        await expect(claim(device, call._id)).resolves.toEqual({ claimed: true });
        await expect(accept(device, call._id)).resolves.toEqual({ accepted: true });
        expect(await fieldOf(call._id, "status")).toBe("completed");
    });

    it("lets a lapsed lease run out the deadline: the command expires there, not before", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });

        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);

        const call = await sendCall();

        await claim(device, call._id);
        vi.setSystemTime(Date.now() + ACP_CLAIM_LEASE_MS + 1000);
        await check(call._id);
        vi.setSystemTime(call.createdAt + DEVICE_CALL_DEADLINE_MS + 1000);

        await expect(claim(device, call._id)).resolves.toEqual({ claimed: false });
        await check(call._id);
        expect(await row(call._id)).toMatchObject({ error: "host did not answer", status: "expired" });
        expect(await streamField(threadId, "hostEndReason")).toBe("failed");
    });

    it("never moves a command the computer already finished", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);

        const call = await sendCall();

        await claim(device, call._id);
        await accept(device, call._id);
        await check(call._id);

        expect(await fieldOf(call._id, "status")).toBe("completed");
        expect(await streamField(threadId, "hostState")).toBe("received");
    });

    it("times out a turn the computer never acknowledged as one that did not answer, and withdraws the prompt", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });

        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);

        const call = await sendCall();

        await claim(device, call._id);
        vi.setSystemTime(Date.now() + 4 * 60_000);
        await run(async (ctx) => await reapExpiredHostStreams(ctx, Date.now()));

        expect(await streamOf(threadId)).toMatchObject({ hostEndReason: "failed", hostState: "ended" });
        expect(await row(call._id)).toMatchObject({ error: "Stopped", status: "expired" });
    });
});

const LIVE_STATUS = /pending|streaming/u;

describe("cancelHostTurn", () => {
    const cancel = async (threadId: string, userId = ownerId) => await as(userId).mutation(remote.cancelHostTurn as never, { threadId } as never);

    it("ends the turn, keeps what was written and tells the computer to cancel; a prompt it never received is withdrawn", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);

        const send1 = await sendCall();

        await expect(cancel(threadId)).resolves.toEqual({ cancelled: true, delivered: true });
        expect(await streamOf(threadId)).toMatchObject({ hostEndReason: "stopped", hostState: "ended" });
        expect(await row(send1._id)).toMatchObject({ error: "Stopped", input: "", status: "expired" });

        const [stop] = await rows("deviceCalls", { toolName: "acp_cancel" });

        const turnId = await streamField(threadId, "hostTurnId");

        expect(JSON.parse(stop?.envelope as string).input).toMatchObject({ sessionId: "host-s1", turnId });
        // A person's Stop drops the prompts queued on the computer: only a worker run's stop keeps them.
        expect(JSON.parse(stop?.envelope as string).input).not.toHaveProperty("keepQueue");
        await expect(cancel(threadId)).resolves.toEqual({ cancelled: false, reason: "no_turn" });
        expect(await sessionStatus()).toBe("idle");
    });

    it("stops the turn the caller named, not the newest, when two host turns are live on the thread", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);
        const older = await streamOf(threadId);

        // A second live host turn on the thread, started after the first.
        await run(async (ctx) => {
            const doc = (await ctx.db.get("persistentStreams", older._id as never)) as Row;
            const copy: Row = { ...doc };

            delete copy._id;
            delete copy._creationTime;
            await ctx.db.insert("persistentStreams", { ...copy, requestId: `${String(copy.requestId)}-second` } as never);
        });

        await expect(as(ownerId).mutation(remote.cancelHostTurn as never, { streamId: older._id, threadId } as never)).resolves.toEqual({
            cancelled: true,
            delivered: true,
        });

        const streams = await rows("persistentStreams", { threadId });

        expect(streams.find((stream) => stream._id === older._id)).toMatchObject({ hostEndReason: "stopped", status: "done" });
        expect(streams.find((stream) => stream._id !== older._id)).toMatchObject({ status: expect.stringMatching(LIVE_STATUS) });
        // The newer turn is still running, so the shared session is not free for another client.
        expect(await sessionStatus()).toBe("busy");
    });

    it("ends the turn but reports the stop as not delivered when the computer's cancel budget is full", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);

        // Three cancels already waiting for the computer fill its stop budget, so this one cannot be queued.
        for (const turnId of ["filler-1", "filler-2", "filler-3"]) {
            await run(
                async (ctx) =>
                    await createAcpCancelCall(
                        ctx,
                        { deviceId: device.deviceId as never, hostSessionId: "host-s1", threadId: threadId as never, turnId, userId: ownerId },
                        Date.now(),
                    ),
            );
        }

        await expect(cancel(threadId)).resolves.toEqual({ cancelled: true, delivered: false });
        expect(await streamOf(threadId)).toMatchObject({ hostEndReason: "stopped", hostState: "ended" });
    });

    it("goes out however many answers and sends are waiting, and withdraws the answers still on their way", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);
        const live = await streamOf(threadId);

        await addRequests(live._id, ["r1", "r3"]);

        // The open-call budget is full: the send and two answers.
        for (const id of ["r1", "r3"]) {
            await as(ownerId).mutation(remote.answerHostPermission as never, { optionId: `${id}-allow_once`, requestId: id, threadId } as never);
        }

        const full = await run(
            async (ctx) =>
                await createAcpCall(
                    ctx,
                    {
                        deviceId: device.deviceId as never,
                        input: { optionId: "x", requestId: "r2", sessionId: "host-s1" },
                        kind: "acp_permission_answer",
                        threadId: threadId as never,
                        userId: ownerId,
                    },
                    Date.now(),
                ),
        );

        expect(full).toEqual({ error: "busy" });

        await expect(cancel(threadId)).resolves.toEqual({ cancelled: true, delivered: true });

        expect(await rows("deviceCalls", { toolName: "acp_cancel" })).toHaveLength(1);

        const answers = await rows("deviceCalls", { toolName: "acp_permission_answer" });

        expect(answers.map((call) => call.status)).toEqual(["expired", "expired"]);
        expect(answers.map((call) => call.input)).toEqual(["", ""]);
    });

    it("is not held back by a full budget of other commands", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);

        const stream = await streamOf(threadId);

        await addRequests(stream._id, ["r1", "r3"]);

        for (const id of ["r1", "r3"]) {
            await as(ownerId).mutation(remote.answerHostPermission as never, { optionId: `${id}-allow_once`, requestId: id, threadId } as never);
        }

        const cancelCall = await run(
            async (ctx) =>
                await createAcpCall(
                    ctx,
                    {
                        deviceId: device.deviceId as never,
                        input: { sessionId: "host-s1", turnId: stream.hostTurnId },
                        kind: "acp_cancel",
                        threadId: threadId as never,
                        userId: ownerId,
                    },
                    Date.now(),
                ),
        );

        expect(cancelCall).toEqual({ callId: expect.any(String) });
    });

    it("is the owner's alone", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);
        const stranger = await insertUser();

        await sendText(threadId);
        await expect(cancel(threadId, stranger)).rejects.toThrow(NOT_FOUND);
        expect(await streamField(threadId, "hostState")).toBe("accepted");
    });
});

describe("answerHostPermission", () => {
    const answer = async (threadId: string, requestId: string, optionId: string, userId = ownerId) =>
        await as(userId).mutation(remote.answerHostPermission as never, { optionId, requestId, threadId } as never);

    const waiting = async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);

        const stream = await streamOf(threadId);

        await addRequest(stream._id, 0, "r1");

        return { device, stream, threadId };
    };

    it("lists only the options that can be sent: allow once and reject once", async () => {
        const { threadId } = await waiting();
        const pending = (await as(ownerId).query(remote.getHostPendingPermissions as never, { threadId } as never)) as Row[];

        expect(pending).toHaveLength(1);
        expect(pending[0]?.options.map((option: Row) => option.kind)).toEqual(["allow_once", "reject_once"]);
        expect(JSON.stringify(pending)).not.toContain("always");
    });

    it("offers only a decline for a request that was cut, and refuses an allow for it", async () => {
        const { stream, threadId } = await waiting();

        await addRequest(stream._id, 1, "r2", ["allow_once", "reject_once"], false);
        await run(async (ctx) => await ctx.db.patch("persistentStreams", stream._id, { hostPendingPermissions: ["r1", "r2"] }));

        const pending = (await as(ownerId).query(remote.getHostPendingPermissions as never, { threadId } as never)) as Row[];
        const cut = pending.find((request) => request.requestId === "r2");

        expect(cut).toMatchObject({ incomplete: true });
        expect(cut?.options.map((option: Row) => option.kind)).toEqual(["reject_once"]);
        await expect(answer(threadId, "r2", "r2-allow_once")).rejects.toThrow(NOT_OFFERED);
        await expect(answer(threadId, "r2", "r2-reject_once")).resolves.toEqual({ sent: true });
    });

    it("queues a signed acp_permission_answer for an option the agent offered", async () => {
        const { device, threadId } = await waiting();

        await expect(answer(threadId, "r1", "r1-allow_once")).resolves.toEqual({ sent: true });

        const [call] = await rows("deviceCalls", { toolName: "acp_permission_answer" });
        const envelope = JSON.parse(call?.envelope as string) as Row;

        expect(envelope).toMatchObject({ deviceId: device.deviceId, tool: "acp_permission_answer" });
        expect(envelope.input).toEqual({ optionId: "r1-allow_once", requestId: "r1", sessionId: "host-s1" });
    });

    it("never sends an 'always' option, one the agent did not offer, or an answer to a request that is not waiting", async () => {
        const { threadId } = await waiting();

        await expect(answer(threadId, "r1", "r1-allow_always")).rejects.toThrow(NOT_OFFERED);
        await expect(answer(threadId, "r1", "invented")).rejects.toThrow(NOT_OFFERED);
        await expect(answer(threadId, "r2", "r1-allow_once")).resolves.toEqual({ reason: "not_waiting", sent: false });
        expect(await rows("deviceCalls", { toolName: "acp_permission_answer" })).toHaveLength(0);
    });

    it("is the owner's alone", async () => {
        const { threadId } = await waiting();
        const stranger = await insertUser();

        await expect(answer(threadId, "r1", "r1-allow_once", stranger)).rejects.toThrow(NOT_FOUND);
        await expect(as(stranger).query(remote.getHostPendingPermissions as never, { threadId } as never)).resolves.toEqual([]);
    });

    it("reports a busy computer instead of queuing past the open-call budget", async () => {
        const { stream, threadId } = await waiting();

        await addRequests(stream._id, ["r1", "r2", "r3"]);

        // Three open commands is the budget (`MAX_OPEN_ACP_CALLS_PER_DEVICE`) and the send holds one; nothing is claimed
        // here, so the answers stay open.
        for (const id of ["r1", "r2"]) {
            await expect(answer(threadId, id, `${id}-allow_once`)).resolves.toEqual({ sent: true });
        }

        await expect(answer(threadId, "r3", "r3-allow_once")).resolves.toEqual({ reason: "busy", sent: false });
    });

    it("reports an outdated computer as outdated, not busy", async () => {
        const { device, threadId } = await waiting();

        await run(async (ctx) => await ctx.db.patch("devices", device.deviceId, { hostProtocol: MIN_DEVICE_PROTOCOL - 1 }));
        await expect(answer(threadId, "r1", "r1-allow_once")).resolves.toEqual({ reason: "outdated", sent: false });
    });

    it("does not report a still-pending answer as sent once its computer has gone outdated, but a claimed one stays sent", async () => {
        const { device, threadId } = await waiting();

        await expect(answer(threadId, "r1", "r1-allow_once")).resolves.toEqual({ sent: true });
        await run(async (ctx) => await ctx.db.patch("devices", device.deviceId, { hostProtocol: MIN_DEVICE_PROTOCOL - 1 }));
        await expect(answer(threadId, "r1", "r1-allow_once")).resolves.toEqual({ reason: "outdated", sent: false });

        const [call] = await rows("deviceCalls", { toolName: "acp_permission_answer" });

        await run(async (ctx) => await ctx.db.patch("deviceCalls", call!._id, { claimedAt: Date.now(), status: "claimed" }));
        await expect(answer(threadId, "r1", "r1-allow_once")).resolves.toEqual({ sent: true });
    });

    it("queues one answer per request: a second tap, or the other device, finds the first on its way", async () => {
        const { threadId } = await waiting();

        await expect(answer(threadId, "r1", "r1-allow_once")).resolves.toEqual({ sent: true });
        await expect(answer(threadId, "r1", "r1-allow_once")).resolves.toEqual({ sent: true });
        await expect(answer(threadId, "r1", "r1-reject_once")).resolves.toEqual({ sent: true });

        const queued = await rows("deviceCalls", { toolName: "acp_permission_answer" });

        expect(queued).toHaveLength(1);
        expect(JSON.parse(queued[0]?.input as string)).toMatchObject({ optionId: "r1-allow_once" });
    });
});

describe("the last turn's end, for Continue", () => {
    it("reads off the last stream, so a restart after the reaper still offers it", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);
        await as(ownerId).mutation(remote.cancelHostTurn as never, { threadId } as never);

        const session = (await as(ownerId).query(getHostSession as never, { threadId } as never)) as Row;

        expect(session).toMatchObject({ lastEndReason: "stopped", status: "idle" });
    });
});

describe("POST /hosts/send", () => {
    const post = async (body: unknown): Promise<number> => {
        const request = new Request("https://example.test/hosts/send", { body: typeof body === "string" ? body : JSON.stringify(body), method: "POST" });
        const response = await send.hostSendHttpAction({} as never, request);

        return response.status;
    };

    it("refuses a body that is not a send before it asks who is calling", async () => {
        vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", "secret");

        await expect(post("not json")).resolves.toBe(400);
        await expect(post({ requestId: "r", text: "hi" })).resolves.toBe(400);
        await expect(post({ requestId: "r", text: " ".repeat(3), threadId: "t" })).resolves.toBe(400);
        await expect(post({ requestId: "r", text: "x".repeat(30_001), threadId: "t" })).resolves.toBe(400);
        // A body far past a prompt's worth is refused unread, with or without a Content-Length.
        await expect(post({ extra: "x".repeat(200_000), requestId: "r", text: "hi", threadId: "t" })).resolves.toBe(413);
        await expect(post({ requestId: "", text: "hi", threadId: "t" })).resolves.toBe(400);
        await expect(post({ requestId: "r", text: "hi", threadId: "t", unlockProof: 5 })).resolves.toBe(400);
        await expect(post({ requestId: "r", text: "hi", threadId: "t", unlockProof: "x".repeat(5000) })).resolves.toBe(400);
    });

    it("takes hidden characters out before the checks, so the cap and the empty check apply to the text sent", async () => {
        vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", "secret");

        // Only hidden characters is an empty prompt.
        await expect(post({ requestId: "r", text: "\u{E0041}\u{202E}", threadId: "t" })).resolves.toBe(400);
        // 30,000 visible characters and one tag character: the tag goes, so the text is within the cap and the request
        // reaches the caller check (401 with no identity).
        await expect(post({ requestId: "r", text: `${"x".repeat(30_000)}\u{E0041}`, threadId: "t" })).resolves.toBe(401);
    });
});
