/**
 * Changing an option of a coding agent from the web (`setHostOption`, slice 2.1): only for a value the agent itself listed, only
 * for the owner, queued as a signed `acp_set_config`, and the agent's answer recorded on the session row for the options row.
 */
import { lunoraTest } from "@lunora/testing";
import { MIN_DEVICE_PROTOCOL } from "../devices/lib/constants";
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
const { ACP_CLAIM_WINDOW_MS } = await import("../devices/lib/constants");
const { applyHostEvents } = await import("./ingest");
const calls = await import("./calls");
const remote = await import("./remote");
const { getHostSession } = await import("./functions");

registerModule(registry, "acp_calls", calls);
registerModule(registry, "acp_ingest", await import("./ingest"));
registerModule(registry, "agent_sharing", await import("../agent/sharing"));
registerModule(registry, "agent_streams", await import("../agent/streams"));
registerModule(registry, "chat_streaming_persistent_library", await import("../chat/streaming/persistent/library"));
registerModule(registry, "lib_shard_routes", await import("../lib/shard-routes"));
registerModule(registry, "lib_shard_housekeeping", await import("../lib/shard-housekeeping"));

type Row = Record<string, any>;

let harness: ReturnType<typeof lunoraTest>;
let ownerId: string;

const NOT_OFFERED = /did not offer/u;
const NOT_FOUND = /not found/u;

const OFFER = { agentKey: "claude", agentLabel: "Claude Code", folderId: "f1", folderLabel: "neore" };

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertUser = async () =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", { createdAt: 0, email: `u${String(Math.random())}@example.com`, emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;

interface Device {
    deviceId: string;
    secret: string;
}

const pairedDevice = async (userId: string): Promise<Device> => {
    const { deviceId, secret } = (await as(userId).mutation(devices.registerDevice as never, { name: "Laptop", platform: "linux" } as never)) as Device;
    const payload = JSON.stringify({ acpOffers: [OFFER], deviceId, issuedAt: Date.now() + 1, kind: "manifest", tools: [], v: 1 });

    await as(userId).mutation(
        devices.updateDeviceManifest as never,
        { deviceId, payload, signature: await signDevicePayload(secret, "manifest", payload) } as never,
    );

    return { deviceId, secret };
};

const run = async <T>(read: (ctx: any) => Promise<T>): Promise<T> => (await harness.run(read)) as T;

const rows = async (table: string, where: Row = {}): Promise<Row[]> =>
    await run(async (ctx) => {
        const { page } = await ctx.db[table].findMany({ where });

        return page as Row[];
    });

const MODEL = {
    category: "model",
    choices: [
        { name: "Fast", value: "fast" },
        { name: "Deep", value: "deep" },
    ],
    currentValue: "fast",
    id: "model",
    name: "Model",
};
const MODE_OPTION = {
    category: "mode",
    choices: [
        { name: "Ask", value: "ask" },
        { name: "Auto", value: "auto" },
    ],
    currentValue: "ask",
    id: "mode",
    name: "Mode",
};
const MODE_REFUSAL = /computer, not from here/u;
const MODES = {
    available: [
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code" },
    ],
    current: "ask",
};

/** A session on the device, with the state the agent reported. */
const readySession = async (state: Row) => {
    const device = await pairedDevice(ownerId);
    const opened = await run(
        async (ctx) =>
            await ctx.runMutation(applyHostEvents, { deviceId: device.deviceId, events: [{ ...OFFER, kind: "session_open" }], sessionId: "host-s1" }),
    );

    await run(
        async (ctx) =>
            await ctx.runMutation(applyHostEvents, {
                deviceId: device.deviceId,
                events: [{ at: 1000, kind: "session_state", ...state }],
                sessionId: "host-s1",
            }),
    );

    return { device, threadId: opened.threadId as string };
};

const setOption = async (threadId: string, args: { optionId?: string; valueId: string }, userId = ownerId) =>
    await as(userId).mutation(remote.setHostOption as never, { threadId, ...args } as never);

const complete = async (device: Device, callId: string, fields: Record<string, unknown> = {}) => {
    await as(ownerId).mutation(devices.claimDeviceCall as never, { callId, deviceId: device.deviceId } as never);

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

    await as(ownerId).mutation(
        devices.completeDeviceCall as never,
        { callId, deviceId: device.deviceId, payload, signature: await signDevicePayload(device.secret, "result", payload) } as never,
    );
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    ownerId = await insertUser();
});

afterEach(() => {
    harness.close();
});

describe("setHostOption", () => {
    it("queues a signed acp_set_config naming the session, the option and the value", async () => {
        const { device, threadId } = await readySession({ configOptions: [MODEL] });
        const result = (await setOption(threadId, { optionId: "model", valueId: "deep" })) as Row;

        expect(result).toMatchObject({ sent: true });

        const [call] = await rows("deviceCalls", { toolName: "acp_set_config" });
        const envelope = JSON.parse(call?.envelope as string) as Row;

        expect(call?._id).toBe(result.callId);
        expect(envelope).toMatchObject({ deviceId: device.deviceId, tool: "acp_set_config" });
        expect(envelope.input).toEqual({ optionId: "model", sessionId: "host-s1", valueId: "deep" });
    });

    it("refuses an option or a value the agent did not list, and queues nothing", async () => {
        const { threadId } = await readySession({ configOptions: [MODEL] });

        await expect(setOption(threadId, { optionId: "model", valueId: "invented" })).rejects.toThrow(NOT_OFFERED);
        await expect(setOption(threadId, { optionId: "effort", valueId: "high" })).rejects.toThrow(NOT_OFFERED);
        await expect(setOption(threadId, { valueId: "code" })).rejects.toThrow(NOT_OFFERED);
        expect(await rows("deviceCalls", { toolName: "acp_set_config" })).toHaveLength(0);
    });

    it("refuses a mode of the legacy state from the web, since a mode can grant standing permissions", async () => {
        const legacy = await readySession({ modes: MODES });

        await expect(setOption(legacy.threadId, { valueId: "code" })).rejects.toThrow(MODE_REFUSAL);
        expect(await rows("deviceCalls", { toolName: "acp_set_config" })).toHaveLength(0);
    });

    it("refuses an option of the mode category from the web, and still changes the other options", async () => {
        const { threadId } = await readySession({ configOptions: [MODE_OPTION, MODEL] });

        await expect(setOption(threadId, { optionId: "mode", valueId: "auto" })).rejects.toThrow(MODE_REFUSAL);
        await expect(setOption(threadId, { optionId: "model", valueId: "deep" })).resolves.toMatchObject({ sent: true });
        expect(await rows("deviceCalls", { toolName: "acp_set_config" })).toHaveLength(1);
    });

    it("refuses a mode option whatever the case of its category, as the computer does", async () => {
        const { threadId } = await readySession({ configOptions: [{ ...MODE_OPTION, category: "Mode" }, MODEL] });

        await expect(setOption(threadId, { optionId: "mode", valueId: "auto" })).rejects.toThrow(MODE_REFUSAL);
        expect(await rows("deviceCalls", { toolName: "acp_set_config" })).toHaveLength(0);
    });

    it("refuses a legacy mode while the agent sends options, and a session that reported nothing", async () => {
        const both = await readySession({ configOptions: [MODEL], modes: MODES });

        await expect(setOption(both.threadId, { valueId: "code" })).rejects.toThrow(NOT_OFFERED);

        const silent = await readySession({});

        await expect(setOption(silent.threadId, { optionId: "model", valueId: "fast" })).rejects.toThrow(NOT_OFFERED);
    });

    it("is the owner's alone", async () => {
        const { threadId } = await readySession({ configOptions: [MODEL] });
        const stranger = await insertUser();

        await expect(setOption(threadId, { optionId: "model", valueId: "deep" }, stranger)).rejects.toThrow(NOT_FOUND);
        expect(await rows("deviceCalls", { toolName: "acp_set_config" })).toHaveLength(0);
    });

    it("reports a device that is not paired, an offline one and an outdated one with a reason", async () => {
        const { device, threadId } = await readySession({ configOptions: [MODEL] });

        await run(async (ctx) => await ctx.db.patch("devices", device.deviceId, { encryptedSecret: "" }));
        await expect(setOption(threadId, { optionId: "model", valueId: "deep" })).resolves.toEqual({ reason: "unpaired", sent: false });
        expect(await rows("deviceCalls", { toolName: "acp_set_config" })).toHaveLength(0);

        const other = await readySession({ configOptions: [MODEL] });

        await run(async (ctx) => await ctx.db.patch("devices", other.device.deviceId, { hostProtocol: MIN_DEVICE_PROTOCOL - 1 }));
        await expect(setOption(other.threadId, { optionId: "model", valueId: "deep" })).resolves.toEqual({ reason: "outdated", sent: false });

        const offline = await readySession({ configOptions: [MODEL] });

        // Last seen well outside the online window: the device is offline, so nothing is queued.
        await run(async (ctx) => await ctx.db.patch("devices", offline.device.deviceId, { lastSeenAt: 0 }));
        await expect(setOption(offline.threadId, { optionId: "model", valueId: "deep" })).resolves.toEqual({ reason: "offline", sent: false });
        expect(await rows("deviceCalls", { toolName: "acp_set_config" })).toHaveLength(0);
    });

    it("refuses an ended session and a second change while the first is on its way", async () => {
        const { threadId } = await readySession({ configOptions: [MODEL] });

        await expect(setOption(threadId, { optionId: "model", valueId: "deep" })).resolves.toMatchObject({ sent: true });
        await expect(setOption(threadId, { optionId: "model", valueId: "fast" })).resolves.toEqual({ reason: "busy", sent: false });

        await run(async (ctx) => {
            const { page } = await ctx.db.acpSessions.findMany({ where: { threadId } });
            const [session] = page;

            await ctx.db.patch("acpSessions", session._id, { status: "ended" });
        });
        await expect(setOption(threadId, { optionId: "model", valueId: "fast" })).resolves.toEqual({ reason: "ended", sent: false });
    });

    it("records the agent's answer on the session row, and the owner reads it back", async () => {
        const { device, threadId } = await readySession({ configOptions: [MODEL] });
        const { callId } = (await setOption(threadId, { optionId: "model", valueId: "deep" })) as Row;

        await complete(device, callId);

        const view = (await as(ownerId).query(getHostSession as never, { threadId } as never)) as Row;

        expect(view.optionResult).toMatchObject({ callId, optionId: "model", outcome: "confirmed", valueId: "deep" });
        expect(view.optionResult).not.toHaveProperty("reason");
        expect(await rows("deviceCalls", { toolName: "acp_set_config" })).toEqual([expect.objectContaining({ envelope: "", input: "", status: "completed" })]);
    });

    it("records a refusal with its reason, and frees the next change", async () => {
        const { device, threadId } = await readySession({ configOptions: [MODEL] });
        const { callId } = (await setOption(threadId, { optionId: "model", valueId: "deep" })) as Row;

        await complete(device, callId, { error: "refused: the agent does not offer that choice", status: "failed" });

        const view = (await as(ownerId).query(getHostSession as never, { threadId } as never)) as Row;

        expect(view.optionResult).toMatchObject({ callId, outcome: "refused", reason: "the agent does not offer that choice" });
        await expect(setOption(threadId, { optionId: "model", valueId: "fast" })).resolves.toMatchObject({ sent: true });
    });

    it("never shows text it did not sign: a relay's or a device's own error is replaced by a fixed reason", async () => {
        const { device, threadId } = await readySession({ configOptions: [MODEL] });
        const { callId } = (await setOption(threadId, { optionId: "model", valueId: "deep" })) as Row;

        await complete(device, callId, { error: "refused: ENV_TOKEN=sk-live-123 in /Users/me/project", status: "failed" });

        const view = (await as(ownerId).query(getHostSession as never, { threadId } as never)) as Row;

        expect(view.optionResult).toMatchObject({ callId, outcome: "refused", reason: "The host did not change the option." });
        expect(JSON.stringify(view)).not.toContain("sk-live");
    });

    it("records an unanswered change as refused when its window closes", async () => {
        const { threadId } = await readySession({ configOptions: [MODEL] });
        const { callId } = (await setOption(threadId, { optionId: "model", valueId: "deep" })) as Row;

        await run(async (ctx) => await ctx.db.patch("deviceCalls", callId, { createdAt: Date.now() - ACP_CLAIM_WINDOW_MS - 5000 }));
        await run(async (ctx) => await ctx.runMutation(calls.checkAcpCall, { callId }));

        const view = (await as(ownerId).query(getHostSession as never, { threadId } as never)) as Row;

        expect(view.optionResult).toMatchObject({ callId, outcome: "refused", reason: "The host did not answer." });
    });

    it("does not let an older change that expires late replace the confirmed answer to a newer one", async () => {
        const { device, threadId } = await readySession({ configOptions: [MODEL] });
        const { callId: older } = (await setOption(threadId, { optionId: "model", valueId: "deep" })) as Row;

        // The older change is past its claim window, so a newer change can be asked for and answered before the older one expires.
        await run(async (ctx) => await ctx.db.patch("deviceCalls", older, { createdAt: Date.now() - ACP_CLAIM_WINDOW_MS - 5000 }));
        const { callId: newer } = (await setOption(threadId, { optionId: "model", valueId: "fast" })) as Row;

        await complete(device, newer);
        await run(async (ctx) => await ctx.runMutation(calls.checkAcpCall, { callId: older }));

        const view = (await as(ownerId).query(getHostSession as never, { threadId } as never)) as Row;

        expect(view.optionResult).toMatchObject({ callId: newer, outcome: "confirmed", valueId: "fast" });
    });
});
