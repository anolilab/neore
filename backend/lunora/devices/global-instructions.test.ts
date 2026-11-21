/**
 * The rule-file editor's read of global instruction files: who may start it, on which computer, what is signed, and
 * that it is relayed, approved and recorded like any other device call.
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

const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const { default: schema } = await import("../schema");
const functions = await import("./functions");
const globalInstructions = await import("./global-instructions");
const { signDevicePayload, verifyDevicePayload } = await import("./lib/signing");
const { DEVICE_ONLINE_WINDOW_MS } = await import("./lib/constants");

const NOT_FOUND_ERROR = /not found/u;

let harness: ReturnType<typeof lunoraTest>;
let ownerId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertUser = async () =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", { createdAt: 0, email: `u${String(Math.random())}@example.com`, emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;

/** A paired desktop that just sent its signed manifest, so it is online. */
const pairedDesktop = async (userId: string, viaDeviceId?: string) => {
    const { deviceId, secret } = (await as(userId).mutation(
        functions.registerDevice as never,
        { name: "Laptop", platform: "linux", ...(viaDeviceId !== undefined && { viaDeviceId }) } as never,
    )) as { deviceId: string; secret: string };
    const payload = JSON.stringify({ deviceId, issuedAt: Date.now(), kind: "manifest", tools: [], v: 1 });

    await as(userId).mutation(
        functions.updateDeviceManifest as never,
        { deviceId, payload, signature: await signDevicePayload(secret, "manifest", payload), ...(viaDeviceId !== undefined && { viaDeviceId }) } as never,
    );

    return { deviceId, secret };
};

const start = async (userId: string, args: Record<string, unknown>) =>
    (await as(userId).mutation(globalInstructions.startGlobalInstructionsCall as never, args as never)) as { callId: string };

const read = async (userId: string, callId: string) => await as(userId).query(globalInstructions.getGlobalInstructionsCall as never, { callId } as never);

const pending = async (deviceId: string) =>
    (await as(ownerId).query(functions.listPendingDeviceCalls as never, { deviceId } as never)) as { callId: string; envelope: string; signature: string }[];

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    ownerId = await insertUser();
});

afterEach(() => {
    harness.close();
});

describe("startGlobalInstructionsCall", () => {
    it("queues nothing until the person starts it, then one signed list call with no thread and no path", async () => {
        const { deviceId, secret } = await pairedDesktop(ownerId);

        // The acceptance case: pairing and the manifest alone ask the computer for nothing.
        await expect(pending(deviceId)).resolves.toEqual([]);

        const { callId } = await start(ownerId, { deviceId });
        const [call] = await pending(deviceId);

        expect(call?.callId).toBe(callId);
        await expect(verifyDevicePayload(secret, "call", call!.envelope, call!.signature)).resolves.toBe(true);

        const envelope = JSON.parse(call!.envelope) as Record<string, unknown>;

        expect(envelope).toMatchObject({ deviceId, input: {}, kind: "call", taintedBy: [], tool: "instructions_list" });
        expect(envelope).not.toHaveProperty("threadId");

        const row = (await harness.run(async (ctx: any) => await ctx.db.get("deviceCalls", callId))) as Record<string, unknown>;

        expect(row).not.toHaveProperty("threadId");
        expect(row).toMatchObject({ input: "{}", status: "pending", toolName: "instructions_list" });
    });

    it("reads only the ids picked, signed into the envelope", async () => {
        const { deviceId } = await pairedDesktop(ownerId);

        await start(ownerId, { deviceId, files: ["gemini", "claude"] });

        const [call] = await pending(deviceId);

        expect(JSON.parse(call!.envelope)).toMatchObject({ input: { files: ["gemini", "claude"] }, tool: "instructions_read" });
    });

    it("refuses a path, an unknown id, a repeat or an empty pick", async () => {
        const { deviceId } = await pairedDesktop(ownerId);

        for (const files of [["~/.ssh/id_rsa"], ["claude", "claude"], [], ["/etc/passwd"]]) {
            await expect(start(ownerId, { deviceId, files })).rejects.toThrow();
        }

        await expect(pending(deviceId)).resolves.toEqual([]);
    });

    it("refuses another person's computer as if it did not exist", async () => {
        const { deviceId } = await pairedDesktop(ownerId);
        const stranger = await insertUser();

        await expect(start(stranger, { deviceId })).rejects.toThrow(NOT_FOUND_ERROR);
        await expect(pending(deviceId)).resolves.toEqual([]);
    });

    it("refuses an offline computer and a server reached over SSH", async () => {
        const { deviceId } = await pairedDesktop(ownerId);
        const server = await pairedDesktop(ownerId, deviceId);

        await expect(start(ownerId, { deviceId: server.deviceId })).rejects.toThrow(NOT_FOUND_ERROR);

        await harness.run(async (ctx: any) => await ctx.db.patch("devices", deviceId, { lastSeenAt: Date.now() - DEVICE_ONLINE_WINDOW_MS - 1000 }));

        await expect(start(ownerId, { deviceId })).rejects.toMatchObject({ data: { code: "DEVICE_OFFLINE" } });
        await expect(pending(deviceId)).resolves.toEqual([]);
    });
    it("refuses a machine paired by code: only the person's desktop takes it", async () => {
        const { deviceId } = await pairedDesktop(ownerId);

        await harness.run(async (ctx: any) => await ctx.db.patch("devices", deviceId, { transport: "headless" }));

        await expect(start(ownerId, { deviceId })).rejects.toThrow(NOT_FOUND_ERROR);
        await expect(pending(deviceId)).resolves.toEqual([]);
    });
});

describe("getGlobalInstructionsCall", () => {
    it("is relayed and completed like any device call, and shows only its owner the device's known files", async () => {
        const { deviceId, secret } = await pairedDesktop(ownerId);
        const { callId } = await start(ownerId, { deviceId, files: ["claude"] });

        await expect(read(ownerId, callId)).resolves.toEqual({ status: "pending" });
        await expect(as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId } as never)).resolves.toEqual({ claimed: true });

        const output = JSON.stringify([
            { id: "claude", name: "CLAUDE.md", path: "~/.claude/CLAUDE.md", size: 8, status: "read", text: "be brief" },
            { id: "ssh", name: "id_rsa", path: "~/.ssh/id_rsa", status: "read", text: "secret" },
        ]);
        const payload = JSON.stringify({ callId, decision: "once", deviceId, kind: "result", output, status: "completed", v: 1 });

        await as(ownerId).mutation(
            functions.completeDeviceCall as never,
            { callId, deviceId, payload, signature: await signDevicePayload(secret, "result", payload) } as never,
        );

        await expect(read(ownerId, callId)).resolves.toEqual({
            files: [{ id: "claude", name: "CLAUDE.md", path: "~/.claude/CLAUDE.md", size: 8, status: "read", text: "be brief" }],
            status: "completed",
        });
        await expect(read(await insertUser(), callId)).resolves.toBeNull();

        // The call log lists it like the rest, without a thread.
        const logged = ((await as(ownerId).query(functions.listDeviceCalls as never, {} as never)) as Record<string, unknown>[])[0];

        expect(logged).toMatchObject({ _id: callId, decision: "once", status: "completed", toolName: "instructions_read" });
        expect(logged).not.toHaveProperty("threadId");
    });

    it("reports a result it cannot read as failed, not as one that found no files", async () => {
        const { deviceId, secret } = await pairedDesktop(ownerId);
        const { callId } = await start(ownerId, { deviceId, files: ["claude"] });

        await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId } as never);

        // A list cut mid-entry, as a capped result would be.
        const output = JSON.stringify([{ id: "claude", name: "CLAUDE.md", path: "~/.claude/CLAUDE.md", status: "read", text: "be brief" }]).slice(0, 40);
        const payload = JSON.stringify({ callId, decision: "once", deviceId, kind: "result", output, status: "completed", v: 1 });

        await as(ownerId).mutation(
            functions.completeDeviceCall as never,
            { callId, deviceId, payload, signature: await signDevicePayload(secret, "result", payload) } as never,
        );

        await expect(read(ownerId, callId)).resolves.toEqual({ error: "The computer's answer could not be read", status: "failed" });
    });
});

describe("parseGlobalInstructionFiles", () => {
    it("reads a cut list, a non-list and a list of only unknown entries as unreadable, and an empty list as no files", () => {
        expect(globalInstructions.parseGlobalInstructionFiles('[{"id":"claude","status":"re')).toBeUndefined();
        expect(globalInstructions.parseGlobalInstructionFiles('{"id":"claude"}')).toBeUndefined();
        expect(
            globalInstructions.parseGlobalInstructionFiles(
                JSON.stringify([
                    { id: "claude", status: "newer" },
                    { id: "ssh", status: "read" },
                ]),
            ),
        ).toBeUndefined();
        expect(globalInstructions.parseGlobalInstructionFiles("[]")).toEqual([]);
    });
});
