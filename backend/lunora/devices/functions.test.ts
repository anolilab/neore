/**
 * Device execution against the in-memory harness: pairing, the signed manifest,
 * the relay (claim-once, signed results, terminal rows never rewritten), who may
 * reach which thread's devices, the per-device open-call cap and revocation.
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

// `lib/encryption.ts` refuses to load without a key.
const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const { default: schema } = await import("../schema");
const functions = await import("./functions");
const internals = await import("./internal");
const { signDevicePayload, verifyDevicePayload } = await import("./lib/signing");
const { MAX_OPEN_CALLS_PER_DEVICE } = await import("./lib/constants");

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const STRANGER = "stranger";

const HEX_SECRET = /^[0-9a-f]{64}$/u;
const NOT_FOUND_ERROR = /not found/u;
const REQUIRES_AN_ACCOUNT_ERROR = /requires an account/u;
const SIGNATURE_ERROR = /signature/u;
const STALE_ERROR = /stale/u;
const MALFORMED_ERROR = /malformed/u;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertUser = async (fields: Record<string, unknown> = {}) =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", {
                createdAt: 0,
                email: `u${String(Math.random())}@example.com`,
                emailVerified: true,
                name: "U",
                updatedAt: 0,
                ...fields,
            }),
    )) as string;

const insertThread = async (owner: string, fields: Record<string, unknown> = {}) =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Build", userId: owner, ...fields }))) as string;

const register = async (userId: string) =>
    (await as(userId).mutation(functions.registerDevice as never, { name: "Laptop", platform: "linux" } as never)) as { deviceId: string; secret: string };

const TOOLS = [
    { description: "Read a file", inputSchema: { properties: { path: { type: "string" } }, type: "object" }, kind: "fs", name: "fs_read", readOnly: true },
];

const signManifest = async (deviceId: string, secret: string, issuedAt = Date.now()) => {
    const payload = JSON.stringify({ deviceId, issuedAt, kind: "manifest", tools: TOOLS, v: 1 });

    return { deviceId, payload, signature: await signDevicePayload(secret, "manifest", payload) };
};

/** A paired, online device with a manifest, owned by the (real-account) user. */
const pairedDevice = async (userId: string) => {
    const { deviceId, secret } = await register(userId);

    await as(userId).mutation(functions.updateDeviceManifest as never, (await signManifest(deviceId, secret)) as never);

    return { deviceId, secret };
};

const createCall = async (fields: { deviceId: string; threadId: string; toolCallId?: string; userId: string }) =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(internals.createDeviceCall, { input: '{"path":"a.txt"}', taintedBy: ["web"], toolName: "fs_read", ...fields }),
    )) as { callId: string } | { error: string };

const signedResult = async (deviceId: string, secret: string, callId: string, fields: Record<string, unknown> = {}) => {
    const payload = JSON.stringify({ callId, decision: "once", deviceId, kind: "result", output: "file body", status: "completed", v: 1, ...fields });

    return { callId, deviceId, payload, signature: await signDevicePayload(secret, "result", payload) };
};

const readCall = async (callId: string) => await harness.run(async (ctx: any) => await ctx.db.get(callId));

let ownerId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    // The user row's `_id` IS the caller's id.
    ownerId = await insertUser();
});

afterEach(() => {
    harness.close();
});

describe("registerDevice", () => {
    it("pairs a real account and returns the secret once; the list never carries it", async () => {
        const { deviceId, secret } = await register(ownerId);

        expect(secret).toMatch(HEX_SECRET);

        const listed = (await as(ownerId).query(functions.listDevices as never, {} as never)) as Record<string, unknown>[];

        expect(listed).toHaveLength(1);
        expect(listed[0]?._id).toBe(deviceId);
        expect(JSON.stringify(listed)).not.toContain(secret);
    });

    it("refuses a guest", async () => {
        const guest = await insertUser({ isAnonymous: true });

        await expect(register(guest)).rejects.toThrow(REQUIRES_AN_ACCOUNT_ERROR);
    });
});

describe("updateDeviceManifest", () => {
    it("stores a manifest the device signed", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const listed = (await as(ownerId).query(functions.listDevices as never, {} as never)) as { _id: string; toolNames: string[] }[];

        expect(listed.find((device) => device._id === deviceId)?.toolNames).toEqual(["fs_read"]);
    });

    it("refuses a manifest the page forged, and one older than the stored one", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);
        const forged = await signManifest(deviceId, "f".repeat(64));

        await expect(as(ownerId).mutation(functions.updateDeviceManifest as never, forged as never)).rejects.toThrow(SIGNATURE_ERROR);
        await expect(
            as(ownerId).mutation(functions.updateDeviceManifest as never, (await signManifest(deviceId, secret, Date.now() - 1000)) as never),
        ).rejects.toThrow(STALE_ERROR);
    });

    it("refuses another user's device", async () => {
        const { deviceId, secret } = await register(ownerId);

        await expect(as(STRANGER).mutation(functions.updateDeviceManifest as never, (await signManifest(deviceId, secret)) as never)).rejects.toThrow(
            NOT_FOUND_ERROR,
        );
    });
});

describe("getDeviceToolContext", () => {
    const contextFor = async (threadId: string, userId = ownerId, now = Date.now()) =>
        (await harness.run(async (ctx: any) => await ctx.runQuery(internals.getDeviceToolContext, { now, threadId, userId }))) as {
            devices: { deviceId: string }[];
        } | null;

    it("offers the owner's online devices in a thread they own alone", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);

        const context = await contextFor(threadId);

        expect(context?.devices.map((device) => device.deviceId)).toEqual([deviceId]);
    });

    it("leaves out a device that stopped beating", async () => {
        await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);

        const context = await contextFor(threadId, ownerId, Date.now() + 10 * 60_000);

        expect(context?.devices).toEqual([]);
    });

    it("offers nothing in a shared, public, group or messenger thread, or to a collaborator", async () => {
        await pairedDevice(ownerId);
        const shared = await insertThread(ownerId);

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: ownerId, ownerId, permission: "write", threadId: shared, userId: STRANGER });
        });

        expect(await contextFor(shared)).toBeNull();
        expect(await contextFor(await insertThread(ownerId, { isPublic: true }))).toBeNull();
        expect(await contextFor(await insertThread(ownerId, { externalThreadId: "telegram:1" }))).toBeNull();
        expect(await contextFor(await insertThread(ownerId), STRANGER)).toBeNull();
    });
});

describe("isDeviceEligibleThread", () => {
    it("refuses a group chat and a deleted thread, whoever owns them", () => {
        const base = { deleted: undefined, externalThreadId: undefined, groupChat: undefined, isPublic: undefined, userId: "u" };

        expect(internals.isDeviceEligibleThread(base as never, "u", false)).toBe(true);
        expect(internals.isDeviceEligibleThread({ ...base, groupChat: { participants: [] } } as never, "u", false)).toBe(false);
        expect(internals.isDeviceEligibleThread({ ...base, deleted: true } as never, "u", false)).toBe(false);
        expect(internals.isDeviceEligibleThread(base as never, "u", true)).toBe(false);
        expect(internals.isDeviceEligibleThread(null, "u", false)).toBe(false);
    });
});

describe("the relay", () => {
    it("signs the envelope with the device's secret, taint included", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);
        const created = await createCall({ deviceId, threadId, userId: ownerId });

        expect("callId" in created).toBe(true);

        const pending = (await as(ownerId).query(functions.listPendingDeviceCalls as never, { deviceId } as never)) as {
            envelope: string;
            signature: string;
        }[];

        expect(pending).toHaveLength(1);
        await expect(verifyDevicePayload(secret, "call", pending[0]!.envelope, pending[0]!.signature)).resolves.toBe(true);
        expect(JSON.parse(pending[0]!.envelope)).toMatchObject({ kind: "call", taintedBy: ["web"], threadTitle: "Build", tool: "fs_read" });
        // A stranger's relay sees nothing.
        await expect(as(STRANGER).query(functions.listPendingDeviceCalls as never, { deviceId } as never)).resolves.toEqual([]);
    });

    it("claims once and accepts only a result the device signed", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);
        const { callId } = (await createCall({ deviceId, threadId, userId: ownerId })) as { callId: string };

        await expect(as(STRANGER).mutation(functions.claimDeviceCall as never, { callId, deviceId } as never)).resolves.toEqual({ claimed: false });
        await expect(as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId } as never)).resolves.toEqual({ claimed: true });
        await expect(as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId } as never)).resolves.toEqual({ claimed: false });

        const forged = await signedResult(deviceId, "e".repeat(64), callId);

        await expect(as(ownerId).mutation(functions.completeDeviceCall as never, forged as never)).rejects.toThrow(SIGNATURE_ERROR);
        await expect(as(ownerId).mutation(functions.completeDeviceCall as never, (await signedResult(deviceId, secret, callId)) as never)).resolves.toEqual({
            accepted: true,
        });
        expect(await readCall(callId)).toMatchObject({ decision: "once", output: "file body", status: "completed" });

        // A replayed (even validly signed) result never rewrites a finished call.
        await expect(
            as(ownerId).mutation(functions.completeDeviceCall as never, (await signedResult(deviceId, secret, callId, { output: "other" })) as never),
        ).resolves.toEqual({ accepted: false });
        expect(await readCall(callId)).toMatchObject({ output: "file body" });
    });

    it("caps what a device returns, whatever it claims", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);
        const { callId } = (await createCall({ deviceId, threadId, userId: ownerId })) as { callId: string };

        await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId } as never);
        await as(ownerId).mutation(
            functions.completeDeviceCall as never,
            (await signedResult(deviceId, secret, callId, { output: "x".repeat(100_000) })) as never,
        );

        const call = (await readCall(callId)) as { output: string; truncated: boolean };

        expect(call.output).toHaveLength(64 * 1024);
        expect(call.truncated).toBe(true);
    });

    it(`holds at most ${String(MAX_OPEN_CALLS_PER_DEVICE)} open calls per device`, async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);

        for (let index = 0; index < MAX_OPEN_CALLS_PER_DEVICE; index += 1) {
            expect("callId" in (await createCall({ deviceId, threadId, userId: ownerId }))).toBe(true);
        }

        await expect(createCall({ deviceId, threadId, userId: ownerId })).resolves.toEqual({ error: "busy" });
    });

    it("never signs a call for a thread the device may not reach", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const threadId = await insertThread(STRANGER);

        await expect(createCall({ deviceId, threadId, userId: ownerId })).resolves.toEqual({ error: "ineligible" });
    });

    it("expiring a call the device already finished returns the finished state", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);
        const { callId } = (await createCall({ deviceId, threadId, userId: ownerId })) as { callId: string };

        await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId } as never);
        await as(ownerId).mutation(functions.completeDeviceCall as never, (await signedResult(deviceId, secret, callId)) as never);

        await expect(harness.run(async (ctx: any) => await ctx.runMutation(internals.expireDeviceCall, { callId, reason: "late" }))).resolves.toMatchObject({
            status: "completed",
        });
    });
});

const signedProgress = async (deviceId: string, secret: string, callId: string, fields: Record<string, unknown> = {}) => {
    const payload = JSON.stringify({ callId, deviceId, issuedAt: Date.now(), kind: "progress", phase: "prompting", v: 1, ...fields });

    return { callId, deviceId, payload, signature: await signDevicePayload(secret, "progress", payload) };
};

describe("reportDeviceCallProgress", () => {
    const report = async (userId: string, args: Awaited<ReturnType<typeof signedProgress>>) =>
        await as(userId).mutation(functions.reportDeviceCallProgress as never, args as never);

    it("moves a claimed call forward on a signed report, never back, never for a stranger", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);
        const { callId } = (await createCall({ deviceId, threadId, userId: ownerId })) as { callId: string };

        // Not claimed yet: nothing to move.
        await expect(report(ownerId, await signedProgress(deviceId, secret, callId))).resolves.toEqual({ accepted: false });
        await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId } as never);

        await expect(report(STRANGER, await signedProgress(deviceId, secret, callId))).rejects.toThrow(NOT_FOUND_ERROR);
        await expect(report(ownerId, await signedProgress(deviceId, "e".repeat(64), callId))).rejects.toThrow(SIGNATURE_ERROR);
        // A result signature replayed as progress is refused by its domain.
        const asResult = await signedProgress(deviceId, secret, callId);

        await expect(report(ownerId, { ...asResult, signature: await signDevicePayload(secret, "result", asResult.payload) })).rejects.toThrow(SIGNATURE_ERROR);

        await expect(report(ownerId, await signedProgress(deviceId, secret, callId))).resolves.toEqual({ accepted: true });
        expect(await readCall(callId)).toMatchObject({ phase: "prompting", status: "claimed" });
        await expect(report(ownerId, await signedProgress(deviceId, secret, callId, { phase: "running" }))).resolves.toEqual({ accepted: true });
        await expect(report(ownerId, await signedProgress(deviceId, secret, callId))).resolves.toEqual({ accepted: false });
        expect(await readCall(callId)).toMatchObject({ phase: "running", status: "claimed" });
    });

    it("refuses a stale report, another call's report and an unknown phase", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);
        const { callId } = (await createCall({ deviceId, threadId, userId: ownerId })) as { callId: string };
        const other = (await createCall({ deviceId, threadId, userId: ownerId })) as { callId: string };

        await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId } as never);

        await expect(report(ownerId, await signedProgress(deviceId, secret, callId, { issuedAt: Date.now() - 60 * 60_000 }))).rejects.toThrow(MALFORMED_ERROR);
        await expect(report(ownerId, { ...(await signedProgress(deviceId, secret, other.callId)), callId })).rejects.toThrow(MALFORMED_ERROR);
        await expect(report(ownerId, await signedProgress(deviceId, secret, callId, { phase: "completed" }))).rejects.toThrow(MALFORMED_ERROR);
        expect(await readCall(callId)).not.toHaveProperty("phase");
    });
});

describe("getDeviceCallByToolCall", () => {
    it("finds the caller's call by its tool call id, and nothing for a stranger", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);

        await createCall({ deviceId, threadId, toolCallId: "tc-1", userId: ownerId });
        await createCall({ deviceId, threadId, toolCallId: "tc-2", userId: ownerId });

        await expect(as(ownerId).query(functions.getDeviceCallByToolCall as never, { toolCallId: "tc-1" } as never)).resolves.toMatchObject({
            deviceName: "Laptop",
            status: "pending",
            toolName: "fs_read",
        });
        await expect(as(ownerId).query(functions.getDeviceCallByToolCall as never, { toolCallId: "nope" } as never)).resolves.toBeNull();
        await expect(as(STRANGER).query(functions.getDeviceCallByToolCall as never, { toolCallId: "tc-1" } as never)).resolves.toBeNull();
    });
});

describe("releaseDeviceCall", () => {
    it("fails the caller's own claimed call at once, and nobody else's", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);
        const { callId } = (await createCall({ deviceId, threadId, userId: ownerId })) as { callId: string };

        await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId } as never);
        await as(STRANGER).mutation(functions.releaseDeviceCall as never, { callId, deviceId, reason: "x" } as never);
        expect(await readCall(callId)).toMatchObject({ status: "claimed" });

        await as(ownerId).mutation(functions.releaseDeviceCall as never, { callId, deviceId, reason: "the request has expired" } as never);
        expect(await readCall(callId)).toMatchObject({ error: "The device refused the request: the request has expired", status: "failed" });
    });
});

describe("revokeDevice", () => {
    it("deletes the device and expires its open calls; the audit rows stay", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);
        const { callId } = (await createCall({ deviceId, threadId, userId: ownerId })) as { callId: string };

        await expect(as(STRANGER).mutation(functions.revokeDevice as never, { deviceId } as never)).rejects.toThrow(NOT_FOUND_ERROR);
        await as(ownerId).mutation(functions.revokeDevice as never, { deviceId } as never);

        await expect(as(ownerId).query(functions.listDevices as never, {} as never)).resolves.toEqual([]);
        expect(await readCall(callId)).toMatchObject({ deviceName: "Laptop", status: "expired" });
        await expect(as(ownerId).mutation(functions.heartbeatDevice as never, { deviceId } as never)).resolves.toEqual({ paired: false });
    });
});
