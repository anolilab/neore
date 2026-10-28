/**
 * Remote control of a coding agent against the in-memory harness (plans/acp-agent-host.md §4.1, §4.4, §4.6, S4):
 * the offers a manifest carries, starting a session, sending into one (`sendToHost`), the lease and the clock on
 * a command, the prompt that is cleared, Stop and the permission answers.
 *
 * Time is the real clock moved with `vi.setSystemTime`; the scheduler is not run, so each scheduled check
 * (`checkAcpCall`) is called by the test at the moment it would have fired.
 */
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
const { signDevicePayload } = await import("../devices/lib/signing");
const { ACP_CLAIM_LEASE_MS, ACP_CLAIM_WINDOW_MS, DEVICE_CALL_DEADLINE_MS } = await import("../devices/lib/constants");
const { parseAcpOffers } = await import("../devices/lib/manifest");
const { applyHostEvents } = await import("./ingest");
const calls = await import("./calls");
const remote = await import("./remote");
const send = await import("./send");
const { getHostSession } = await import("./functions");
const { reapExpiredHostStreams } = await import("./lib/reap");

registerModule(registry, "acp_calls", calls);
registerModule(registry, "acp_ingest", await import("./ingest"));
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

const OFFER = { agentKey: "claude", agentLabel: "Claude Code", folderId: "f1", folderLabel: "neore" };
const SESSION_OPEN = { ...OFFER, kind: "session_open" };

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertUser = async () =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", { createdAt: 0, email: `u${String(Math.random())}@example.com`, emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;

let manifestAt = 0;

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

const rows = async (table: string, where: Row = {}): Promise<Row[]> => (await run(async (ctx) => (await ctx.db[table].findMany({ where })).page)) as Row[];

const row = async (id: string): Promise<Row | null> => await run(async (ctx) => await ctx.db.get(id));

/** A local-style session on the device: the desktop's `session_open`, as the ingest applies it. */
const openSession = async (device: Device, hostSessionId = "host-s1"): Promise<string> => {
    const result = await run(
        async (ctx) => await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [SESSION_OPEN], sessionId: hostSessionId }),
    );

    return result.threadId as string;
};

const sendText = async (threadId: string, text = "fix the bug", requestId = crypto.randomUUID(), userId = ownerId) =>
    await run(async (ctx) => await ctx.runMutation(send.sendToHost, { requestId, text, threadId, userId }));

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

const streamOf = async (threadId: string): Promise<Row> => {
    const [stream] = await rows("persistentStreams", { threadId });

    return stream as Row;
};

const addRequest = async (streamId: string, seq: number, requestId: string, kinds: string[] = ["allow_once", "allow_always", "reject_once"]) =>
    await run(async (ctx) => {
        await ctx.db.persistentChunks.insert({
            event: {
                kind: "permission_request",
                options: kinds.map((kind) => {
                    return { kind, name: kind, optionId: `${requestId}-${kind}` };
                }),
                requestId,
                tool: "Run tests",
            },
            seq,
            streamId,
            text: "",
        });
        await ctx.db.patch(streamId, { hostPendingPermissions: [requestId] });
    });

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    ownerId = await insertUser();
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

    it("clears them when a later manifest offers none, and keeps none for a shell that predates coding agents", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);

        await as(ownerId).mutation(devices.updateDeviceManifest as never, (await manifest(deviceId, secret, { acpOffers: [] })) as never);
        expect((await row(deviceId))?.acpOffers).toEqual([]);

        await as(ownerId).mutation(devices.updateDeviceManifest as never, (await manifest(deviceId, secret, {})) as never);
        expect((await row(deviceId))?.acpOffers).toEqual([]);
    });

    it("refuses a malformed list whole and bounds every field", () => {
        expect(parseAcpOffers([{ ...OFFER, agentKey: "" }])).toBeNull();
        expect(parseAcpOffers([{ ...OFFER, folderLabel: "x".repeat(201) }])).toBeNull();
        expect(parseAcpOffers([{ agentKey: "claude" }])).toBeNull();
        expect(parseAcpOffers("claude")).toBeNull();
        expect(parseAcpOffers(Array.from({ length: 51 }, () => OFFER))).toBeNull();
        expect(parseAcpOffers([OFFER, OFFER])).toEqual([OFFER]);
    });
});

describe("startHostSession", () => {
    const start = async (clientId = "tap-1", overrides: Record<string, unknown> = {}, deviceId = "") =>
        await as(ownerId).mutation(
            remote.startHostSession as never,
            { agentKey: "claude", clientId, deviceId, folderId: "f1", ...overrides } as never,
        );

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

    it("starts one session for a double tap", async () => {
        const device = await pairedDevice(ownerId);
        const first = (await start("tap-1", {}, device.deviceId)) as { threadId: string };
        const second = (await start("tap-1", {}, device.deviceId)) as { started: boolean; threadId?: string };

        expect(second).toEqual({ started: false, threadId: first.threadId });
        expect(await rows("acpSessions")).toHaveLength(1);
        expect(await rows("deviceCalls", { toolName: "acp_start" })).toHaveLength(1);
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
        const { threadId } = (await start("tap-1", {}, device.deviceId)) as { threadId: string };
        const [session] = await rows("acpSessions");

        await run(async (ctx) => await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [SESSION_OPEN], sessionId: session?.hostSessionId as string }));
        expect((await rows("acpSessions"))[0]?.status).toBe("idle");
        expect(await rows("acpSessions")).toHaveLength(1);
        expect(await rows("threads", { runner: "host" })).toHaveLength(1);
        expect(threadId).toBeTruthy();

        // A refused start ends its session instead of leaving it starting for ever.
        const second = (await start("tap-2", {}, device.deviceId)) as { threadId: string };
        const open = (await rows("deviceCalls", { toolName: "acp_start" })).find((call) => call.threadId === second.threadId) as Row;

        await claim(device, open._id);
        await accept(device, open._id, { error: "refused: not approved on this computer", status: "failed" });

        const ended = (await rows("acpSessions")).find((candidate) => candidate.threadId === second.threadId);

        expect(ended?.status).toBe("ended");
        expect(await row(open._id)).toMatchObject({ envelope: "", input: "", status: "failed" });
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
        expect((await rows("acpSessions"))[0]?.status).toBe("busy");
    });

    it("answers a retry of the same request with the first try, not a second turn", async () => {
        const { threadId } = await readyThread();
        const first = await sendText(threadId, "fix the bug", "req-1");
        const again = await sendText(threadId, "fix the bug", "req-1");

        expect(again).toMatchObject({ messageId: first.messageId, outcome: "duplicate", streamId: first.streamId });
        expect(await rows("persistentStreams", { threadId })).toHaveLength(1);
        expect(await rows("deviceCalls", { toolName: "acp_send" })).toHaveLength(1);
    });

    it("sends only into the owner's own host thread, and one turn at a time", async () => {
        const { threadId } = await readyThread();
        const stranger = await insertUser();
        const cloud = await run(async (ctx) => await ctx.db.insert("threads", { status: "active", title: "Cloud", userId: ownerId }));

        expect((await sendText(threadId, "hi", "r1", stranger)).outcome).toBe("not_found");
        expect((await sendText(cloud as string, "hi", "r2")).outcome).toBe("not_found");
        expect((await sendText("nonsense", "hi", "r3")).outcome).toBe("not_found");
        expect((await sendText(threadId, "one")).outcome).toBe("sent");
        expect((await sendText(threadId, "two")).outcome).toBe("turn_running");
        expect(await rows("messages", { threadId })).toHaveLength(1);
    });

    it("refuses a session that is still starting or has ended, an offline computer and a prompt past the call's cap", async () => {
        const device = await pairedDevice(ownerId);
        const { threadId } = (await as(ownerId).mutation(
            remote.startHostSession as never,
            { agentKey: "claude", clientId: "t", deviceId: device.deviceId, folderId: "f1" } as never,
        )) as { threadId: string };

        expect((await sendText(threadId)).outcome).toBe("session_starting");

        const open = await openSession(device, "host-s2");

        expect((await sendText(open, "x".repeat(40_000))).outcome).toBe("too_large");

        await run(async (ctx) => {
            const [session] = (await ctx.db.acpSessions.findMany({ where: { threadId: open } })).page;

            await ctx.db.patch(session._id, { status: "ended" });
        });
        expect((await sendText(open)).outcome).toBe("session_ended");

        const idle = await openSession(device, "host-s3");

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 10 * 60_000);
        expect((await sendText(idle)).outcome).toBe("offline");
        expect(await rows("persistentStreams", { threadId: idle })).toHaveLength(0);
    });

    it("moves the turn to received on the computer's accepted result and clears the prompt", async () => {
        const { device, threadId } = await readyThread();

        await sendText(threadId, "secret prompt");

        const call = await sendCall();

        await expect(claim(device, call._id)).resolves.toEqual({ claimed: true });
        await expect(accept(device, call._id)).resolves.toEqual({ accepted: true });

        expect((await streamOf(threadId)).hostState).toBe("received");
        expect(await sendCall()).toMatchObject({ envelope: "", input: "", status: "completed" });
    });

    it("ends the turn with the reason when the computer refuses the prompt, and frees the session", async () => {
        const { device, threadId } = await readyThread();

        await sendText(threadId);

        const call = await sendCall();

        await claim(device, call._id);
        await accept(device, call._id, { error: "refused: no such session", status: "failed" });

        const stream = await streamOf(threadId);
        const [reply] = (await rows("messages", { threadId })).filter((message) => message.message.role === "assistant");

        expect(stream).toMatchObject({ hostEndReason: "failed", hostState: "ended", status: "error" });
        expect(reply?.error).toContain("no such session");
        expect((await rows("acpSessions"))[0]?.status).toBe("idle");
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
        const [reply] = (await rows("messages", { threadId })).filter((message) => message.message.role === "assistant");

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
        expect((await row(call._id))?.status).toBe("claimed");

        // The main process died between the claim and the receipt: the lease lapses.
        vi.setSystemTime(Date.now() + ACP_CLAIM_LEASE_MS + 1000);
        await check(call._id);
        expect((await row(call._id))?.status).toBe("pending");
        await expect(as(ownerId).query(devices.listPendingDeviceCalls as never, { deviceId: device.deviceId } as never)).resolves.toHaveLength(1);

        // Past the claim window: the window decides whether a call is ever taken, not a second look.
        vi.setSystemTime(Date.now() + ACP_CLAIM_WINDOW_MS);
        await expect(claim(device, call._id)).resolves.toEqual({ claimed: true });
        await expect(accept(device, call._id)).resolves.toEqual({ accepted: true });
        expect((await row(call._id))?.status).toBe("completed");
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
        expect((await streamOf(threadId)).hostEndReason).toBe("failed");
    });

    it("never moves a command the computer already finished", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);

        const call = await sendCall();

        await claim(device, call._id);
        await accept(device, call._id);
        await check(call._id);

        expect((await row(call._id))?.status).toBe("completed");
        expect((await streamOf(threadId)).hostState).toBe("received");
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

describe("cancelHostTurn", () => {
    const cancel = async (threadId: string, userId = ownerId) =>
        await as(userId).mutation(remote.cancelHostTurn as never, { threadId } as never);

    it("ends the turn, keeps what was written and tells the computer to cancel; a prompt it never received is withdrawn", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);

        await sendText(threadId);

        const send1 = await sendCall();

        await expect(cancel(threadId)).resolves.toEqual({ cancelled: true });
        expect(await streamOf(threadId)).toMatchObject({ hostEndReason: "stopped", hostState: "ended" });
        expect(await row(send1._id)).toMatchObject({ error: "Stopped", input: "", status: "expired" });

        const [stop] = await rows("deviceCalls", { toolName: "acp_cancel" });

        expect(JSON.parse(stop?.envelope as string).input).toMatchObject({ sessionId: "host-s1", turnId: (await streamOf(threadId)).hostTurnId });
        await expect(cancel(threadId)).resolves.toEqual({ cancelled: false });
        expect((await rows("acpSessions"))[0]?.status).toBe("idle");
    });

    it("is the owner's alone", async () => {
        const device = await pairedDevice(ownerId);
        const threadId = await openSession(device);
        const stranger = await insertUser();

        await sendText(threadId);
        await expect(cancel(threadId, stranger)).rejects.toThrow(NOT_FOUND);
        expect((await streamOf(threadId)).hostState).toBe("accepted");
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
        const { threadId } = await waiting();

        // Three open commands is the budget (`MAX_OPEN_ACP_CALLS_PER_DEVICE`) and the send holds one; nothing is claimed
        // here, so the answers stay open.
        for (let index = 0; index < 2; index += 1) {
            await expect(answer(threadId, "r1", "r1-allow_once")).resolves.toEqual({ sent: true });
        }

        await expect(answer(threadId, "r1", "r1-allow_once")).resolves.toEqual({ reason: "busy", sent: false });
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
    const post = async (body: unknown): Promise<number> =>
        (await send.hostSendHttpAction({} as never, new Request("https://example.test/hosts/send", { body: typeof body === "string" ? body : JSON.stringify(body), method: "POST" })))
            .status;

    it("refuses a body that is not a send before it asks who is calling", async () => {
        vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", "secret");

        await expect(post("not json")).resolves.toBe(400);
        await expect(post({ requestId: "r", text: "hi" })).resolves.toBe(400);
        await expect(post({ requestId: "r", text: "   ", threadId: "t" })).resolves.toBe(400);
        await expect(post({ requestId: "r", text: "x".repeat(30_001), threadId: "t" })).resolves.toBe(400);
        await expect(post({ requestId: "", text: "hi", threadId: "t" })).resolves.toBe(400);
    });
});
