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
const gdpr = await import("./gdpr");
const { MAX_OPEN_CALLS_PER_DEVICE } = await import("./lib/constants");
const { ACP_CLAIM_WINDOW_MS, DEVICE_CLAIM_WINDOW_MS } = await import("./lib/constants");
const { claimWindowMs, isAcpTool, OPEN_CALL_PAGE } = await import("./lib/state");

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

const routeOf = async (deviceId: string) => await harness.run(async (ctx: any) => await ctx.db.shardRoutes.findFirst({ where: { key: `device:${deviceId}` } }));

describe("a device's ingest route", () => {
    it("is written when the device is paired and gone once it is revoked", async () => {
        const { deviceId } = await register(ownerId);

        expect(await routeOf(deviceId)).toMatchObject({ ownerId });

        await as(ownerId).mutation(functions.revokeDevice as never, { deviceId } as never);

        expect(await routeOf(deviceId)).toBeNull();
    });

    it("is erased with the account's devices", async () => {
        const first = await register(ownerId);
        const second = await register(ownerId);
        const other = await register(await insertUser());

        const result = await harness.run(async (ctx: any) => await ctx.runMutation(gdpr.deleteUserDevices, { userId: ownerId }));

        expect(result).toEqual({ hasMore: false });
        expect(await routeOf(first.deviceId)).toBeNull();
        expect(await routeOf(second.deviceId)).toBeNull();
        expect(await routeOf(other.deviceId)).not.toBeNull();
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
            taintedBy: string[];
        } | null;

    it("offers the owner's online devices in a thread they own alone", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);

        const context = await contextFor(threadId);

        expect(context?.devices.map((device) => device.deviceId)).toEqual([deviceId]);
    });

    it("snapshots the taint of the thread's context summaries", async () => {
        await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);

        // A web page the model read once, then lost to the window: only the summary of it remains.
        await harness.run(async (ctx: any) => {
            const messageId = await ctx.db.insert("messages", {
                message: { content: "hi", role: "user" },
                order: 0,
                status: "success",
                stepOrder: 0,
                threadId,
                tool: false,
                userId: ownerId,
            });

            await ctx.db.insert("threadContextSummaries", {
                coveredCount: 1,
                coveredUpToMessageId: messageId,
                createdAt: 1,
                summary: "notes",
                taintedBy: ["mcp"],
                threadId,
                userId: ownerId,
            });
        });

        const context = await contextFor(threadId);

        expect(context?.taintedBy).toStrictEqual(["mcp"]);
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

const insertProject = async (owner: string, fields: Record<string, unknown> = {}) =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("projects", { createdAt: 0, title: "Project", userId: owner, ...fields }))) as string;

const setScope = async (userId: string, deviceId: string, projectIds?: string[]) =>
    await as(userId).mutation(
        functions.setDeviceProjectScope as never,
        { deviceId, scope: projectIds === undefined ? { kind: "any" } : { kind: "projects", projectIds } } as never,
    );

const deviceRows = async (userId = ownerId) =>
    (await as(userId).query(functions.listDevices as never, {} as never)) as { _id: string; projectIds?: string[]; transport?: string }[];

const scopeOf = async () => {
    const [first] = await deviceRows();

    return first?.projectIds;
};

describe("a device's project scope past one page of reads", () => {
    it("keeps every chosen project when the scope holds more than 25", async () => {
        const { deviceId } = await register(ownerId);
        const projects: string[] = [];

        for (let index = 0; index < 40; index += 1) {
            projects.push(await insertProject(ownerId, { title: `Project ${index}` }));
        }

        await setScope(ownerId, deviceId, projects);

        expect(new Set(await scopeOf())).toStrictEqual(new Set(projects));
    });
});

describe("the device list with many scoped projects", () => {
    it("checks more projects than one read may name, and keeps every device's scope", async () => {
        const scopes: string[][] = [];

        for (let device = 0; device < 3; device += 1) {
            const { deviceId } = await register(ownerId);
            const projects: string[] = [];

            for (let index = 0; index < 40; index += 1) {
                projects.push(await insertProject(ownerId, { title: `D${device} P${index}` }));
            }

            await setScope(ownerId, deviceId, projects);
            scopes.push(projects);
        }

        const listed = await deviceRows();

        expect(listed.map((device) => new Set(device.projectIds)).toSorted((a, b) => [...a][0]!.localeCompare([...b][0]!))).toStrictEqual(
            scopes.map((projects) => new Set(projects)).toSorted((a, b) => [...a][0]!.localeCompare([...b][0]!)),
        );
    });
});

describe("a device's project scope in the GDPR export", () => {
    it("is part of the exported device", async () => {
        const { deviceId } = await register(ownerId);
        const project = await insertProject(ownerId);

        await setScope(ownerId, deviceId, [project]);

        const exported = (await harness.run(async (ctx: any) => await ctx.runQuery(gdpr.collectDevicesForExport, { userId: ownerId }))) as {
            devices: { projectIds?: string[] }[];
        };

        expect(exported.devices.map((device) => device.projectIds)).toEqual([[project]]);
    });

    it("lists the coding-agent folders the user approved", async () => {
        const { deviceId } = await register(ownerId);
        const offer = { agentKey: "claude", agentLabel: "Claude Code", folderId: "folder-1", folderLabel: "neore" };

        await harness.run(async (ctx: any) => {
            await ctx.db.patch(deviceId, { acpOffers: [offer] });
        });

        const exported = (await harness.run(async (ctx: any) => await ctx.runQuery(gdpr.collectDevicesForExport, { userId: ownerId }))) as {
            devices: { acpOffers?: unknown[] }[];
        };

        expect(exported.devices.map((device) => device.acpOffers)).toEqual([[offer]]);
    });
});

describe("a device's project scope", () => {
    const offered = async (threadId: string) =>
        (
            (await harness.run(async (ctx: any) => await ctx.runQuery(internals.getDeviceToolContext, { now: Date.now(), threadId, userId: ownerId }))) as {
                devices: { deviceId: string }[];
            } | null
        )?.devices.map((device) => device.deviceId);

    it("offers an unscoped device in any chat, with or without a project", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const project = await insertProject(ownerId);

        expect(await offered(await insertThread(ownerId, { projectId: project }))).toEqual([deviceId]);
        expect(await offered(await insertThread(ownerId))).toEqual([deviceId]);
    });

    it("offers a scoped device only in threads of the chosen projects", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const chosen = await insertProject(ownerId);
        const other = await insertProject(ownerId);

        await setScope(ownerId, deviceId, [chosen]);

        expect(await offered(await insertThread(ownerId, { projectId: chosen }))).toEqual([deviceId]);
        expect(await offered(await insertThread(ownerId, { projectId: other }))).toEqual([]);
        expect(await offered(await insertThread(ownerId))).toEqual([]);
    });

    it("scopes each device on its own", async () => {
        const scoped = await pairedDevice(ownerId);
        const open = await pairedDevice(ownerId);
        const project = await insertProject(ownerId);

        await setScope(ownerId, scoped.deviceId, [project]);

        expect(await offered(await insertThread(ownerId))).toEqual([open.deviceId]);
    });

    it("offers a device with an empty project list nowhere, and tells the list so", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const project = await insertProject(ownerId);

        await setScope(ownerId, deviceId, []);

        expect(await offered(await insertThread(ownerId, { projectId: project }))).toEqual([]);
        expect(await scopeOf()).toEqual([]);
    });

    it("applies a change to the next turn, and goes back to any chat", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);

        await setScope(ownerId, deviceId, []);
        expect(await offered(threadId)).toEqual([]);

        await setScope(ownerId, deviceId);
        expect(await offered(threadId)).toEqual([deviceId]);
        expect(await scopeOf()).toBeUndefined();
    });

    it("refuses to create a call for a thread outside the scope, even after tools were built", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const chosen = await insertProject(ownerId);
        const other = await insertProject(ownerId);
        const inside = await insertThread(ownerId, { projectId: chosen });
        const outside = await insertThread(ownerId, { projectId: other });
        const bare = await insertThread(ownerId);

        expect("callId" in (await createCall({ deviceId, threadId: inside, userId: ownerId }))).toBe(true);

        await setScope(ownerId, deviceId, [chosen]);

        expect("callId" in (await createCall({ deviceId, threadId: inside, userId: ownerId }))).toBe(true);
        expect(await createCall({ deviceId, threadId: outside, userId: ownerId })).toEqual({ error: "ineligible" });
        expect(await createCall({ deviceId, threadId: bare, userId: ownerId })).toEqual({ error: "ineligible" });

        await setScope(ownerId, deviceId, []);

        expect(await createCall({ deviceId, threadId: inside, userId: ownerId })).toEqual({ error: "ineligible" });
    });

    it("follows the thread's current project when it moves", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const chosen = await insertProject(ownerId);
        const other = await insertProject(ownerId);
        const threadId = await insertThread(ownerId, { projectId: chosen });

        await setScope(ownerId, deviceId, [chosen]);
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { projectId: other }));

        expect(await offered(threadId)).toEqual([]);
        expect(await createCall({ deviceId, threadId, userId: ownerId })).toEqual({ error: "ineligible" });
    });

    it("drops a deleted project from the list and from what it offers", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const kept = await insertProject(ownerId);
        const doomed = await insertProject(ownerId);
        // A thread that still names the project it lost.
        const stale = await insertThread(ownerId, { projectId: doomed });

        await setScope(ownerId, deviceId, [kept, doomed]);
        await harness.run(async (ctx: any) => await ctx.db.delete(doomed));

        expect(await scopeOf()).toEqual([kept]);
        expect(await offered(stale)).toEqual([]);
        expect(await createCall({ deviceId, threadId: stale, userId: ownerId })).toEqual({ error: "ineligible" });

        await harness.run(async (ctx: any) => await ctx.db.delete(kept));

        expect(await scopeOf()).toEqual([]);
    });

    it("refuses a project that is not the caller's, and a device that is not", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const theirs = await insertProject(STRANGER);
        const mine = await insertProject(ownerId);

        await expect(setScope(ownerId, deviceId, [theirs])).rejects.toThrow(NOT_FOUND_ERROR);
        await expect(setScope(STRANGER, deviceId, [theirs])).rejects.toThrow(NOT_FOUND_ERROR);
        await expect(setScope(STRANGER, deviceId, [await insertProject(STRANGER)])).rejects.toThrow(NOT_FOUND_ERROR);
        expect(await scopeOf()).toBeUndefined();

        await setScope(ownerId, deviceId, [mine, mine]);

        expect(await scopeOf()).toEqual([mine]);
    });

    it("scopes a server a desktop holds the same way", async () => {
        const desktop = await register(ownerId);
        const server = (await as(ownerId).mutation(
            functions.registerDevice as never,
            { name: "Box", platform: "linux", viaDeviceId: desktop.deviceId } as never,
        )) as { deviceId: string };
        const project = await insertProject(ownerId);

        await setScope(ownerId, server.deviceId, [project]);

        const rows = await deviceRows();

        expect(rows.find((row) => row._id === server.deviceId)).toMatchObject({ projectIds: [project], transport: "ssh" });
        expect(rows.find((row) => row._id === desktop.deviceId)?.projectIds).toBeUndefined();
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

    it("signs the taint it is given and does not re-read the thread's summaries", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);

        // A summary written after the run's context was built: the model never saw it.
        await harness.run(async (ctx: any) => {
            const messageId = await ctx.db.insert("messages", {
                message: { content: "hi", role: "user" },
                order: 0,
                status: "success",
                stepOrder: 0,
                threadId,
                tool: false,
                userId: ownerId,
            });

            await ctx.db.insert("threadContextSummaries", {
                coveredCount: 1,
                coveredUpToMessageId: messageId,
                createdAt: 1,
                summary: "notes",
                taintedBy: ["mcp"],
                threadId,
                userId: ownerId,
            });
        });

        const created = (await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(internals.createDeviceCall, {
                    deviceId,
                    input: "{}",
                    taintedBy: ["web"],
                    threadId,
                    toolName: "fs_read",
                    userId: ownerId,
                }),
        )) as { callId: string };
        const pending = (await as(ownerId).query(functions.listPendingDeviceCalls as never, { deviceId } as never)) as {
            envelope: string;
            signature: string;
        }[];

        await expect(verifyDevicePayload(secret, "call", pending[0]!.envelope, pending[0]!.signature)).resolves.toBe(true);
        expect(JSON.parse(pending[0]!.envelope)).toMatchObject({ taintedBy: ["web"] });
        expect(((await readCall(created.callId)) as { taintedBy: string[] }).taintedBy).toStrictEqual(["web"]);
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

    it("tells a window whose claim was saved but whose answer was lost that it still holds it, and no other window", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);
        const { callId } = (await createCall({ deviceId, threadId, userId: ownerId })) as { callId: string };
        const claim = async (claimId?: string) =>
            await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId, ...(claimId !== undefined && { claimId }) } as never);

        // The first request saved the claim and its answer never arrived; the window asks again with the same id.
        await expect(claim("window-a")).resolves.toEqual({ claimed: true });
        await expect(claim("window-a")).resolves.toEqual({ claimed: true });
        await expect(claim("window-b")).resolves.toEqual({ claimed: false });
        await expect(claim()).resolves.toEqual({ claimed: false });
        expect(await readCall(callId)).toMatchObject({ claimId: "window-a", status: "claimed" });
    });

    it("takes a result only from the window that holds the claim", async () => {
        const { deviceId, secret } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);
        const { callId } = (await createCall({ deviceId, threadId, userId: ownerId })) as { callId: string };
        const complete = async (claimId?: string) =>
            await as(ownerId).mutation(
                functions.completeDeviceCall as never,
                { ...(await signedResult(deviceId, secret, callId)), ...(claimId !== undefined && { claimId }) } as never,
            );

        await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, claimId: "window-a", deviceId } as never);

        // A window whose lease lapsed reports late: its result is not the claimant's, so the call stays open.
        await expect(complete("window-b")).resolves.toEqual({ accepted: false });
        expect(await readCall(callId)).toMatchObject({ claimId: "window-a", status: "claimed" });
        await expect(complete("window-a")).resolves.toEqual({ accepted: true });
        expect(await readCall(callId)).toMatchObject({ status: "completed" });
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

    it("counts its ordinary calls however many coding-agent calls pile up before them", async () => {
        const { deviceId } = await pairedDevice(ownerId);
        const threadId = await insertThread(ownerId);

        // More stale cancels than one page reads, all older than the ordinary calls.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < OPEN_CALL_PAGE + 10; index += 1) {
                await ctx.db.insert("deviceCalls", {
                    createdAt: 1,
                    deadline: 2,
                    deviceId,
                    deviceName: "Laptop",
                    envelope: "",
                    input: "{}",
                    signature: "",
                    status: "pending",
                    taintedBy: [],
                    threadId,
                    toolName: "acp_cancel",
                    userId: ownerId,
                });
            }
        });

        for (let index = 0; index < MAX_OPEN_CALLS_PER_DEVICE; index += 1) {
            expect("callId" in (await createCall({ deviceId, threadId, userId: ownerId }))).toBe(true);
        }

        await expect(createCall({ deviceId, threadId, userId: ownerId })).resolves.toEqual({ error: "busy" });
    });

    it("takes only the four coding-agent call names for one, so no other acp_ tool gets their window", () => {
        for (const name of ["acp_start", "acp_send", "acp_cancel", "acp_permission_answer"]) {
            expect(isAcpTool(name)).toBe(true);
            expect(claimWindowMs(name)).toBe(ACP_CLAIM_WINDOW_MS);
        }

        expect(isAcpTool("acp_backup")).toBe(false);
        expect(claimWindowMs("acp_backup")).toBe(DEVICE_CLAIM_WINDOW_MS);
        expect(isAcpTool("fs_read")).toBe(false);
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

describe("servers reached over SSH", () => {
    const byId = (a: string, b: string) => a.localeCompare(b);

    const registerHost = async (userId: string, viaDeviceId: string, name = "build-box") =>
        (await as(userId).mutation(functions.registerDevice as never, { name, platform: "linux", viaDeviceId } as never)) as {
            deviceId: string;
            secret: string;
        };

    /** A desktop and a host it holds, the host online with a manifest signed by the host's own secret. */
    const desktopWithHost = async (userId: string) => {
        const desktop = await pairedDevice(userId);
        const host = await registerHost(userId, desktop.deviceId);

        await as(userId).mutation(
            functions.updateDeviceManifest as never,
            { ...(await signManifest(host.deviceId, host.secret)), viaDeviceId: desktop.deviceId } as never,
        );

        return { desktop, host };
    };

    const hostCall = async (userId: string, hostId: string) => {
        const threadId = await insertThread(userId);

        return (await createCall({ deviceId: hostId, threadId, userId })) as { callId: string };
    };

    it("lists a host with its transport and the desktop that holds it", async () => {
        const { desktop, host } = await desktopWithHost(ownerId);
        const listed = (await as(ownerId).query(functions.listDevices as never, {} as never)) as { _id: string; transport?: string; viaDeviceId?: string }[];

        expect(listed.find((device) => device._id === host.deviceId)).toMatchObject({ transport: "ssh", viaDeviceId: desktop.deviceId });
        expect(listed.find((device) => device._id === desktop.deviceId)).not.toHaveProperty("transport");
    });

    it("lets the owner rename a server, and nobody else", async () => {
        const { host } = await desktopWithHost(ownerId);

        await as(ownerId).mutation(functions.renameDevice as never, { deviceId: host.deviceId, name: "renamed" } as never);

        const listed = (await as(ownerId).query(functions.listDevices as never, {} as never)) as { _id: string; name: string }[];

        expect(listed.find((device) => device._id === host.deviceId)?.name).toBe("renamed");
        await expect(as(STRANGER).mutation(functions.renameDevice as never, { deviceId: host.deviceId, name: "mine" } as never)).rejects.toThrow(
            NOT_FOUND_ERROR,
        );
    });

    it("refuses to pair a host under a desktop that is not the caller's, or under another host", async () => {
        const mine = await pairedDevice(ownerId);
        const stranger = await insertUser();
        const theirs = await pairedDevice(stranger);
        const { deviceId: hostId } = await registerHost(ownerId, mine.deviceId);

        await expect(registerHost(ownerId, theirs.deviceId)).rejects.toThrow(NOT_FOUND_ERROR);
        await expect(registerHost(stranger, mine.deviceId)).rejects.toThrow(NOT_FOUND_ERROR);
        await expect(registerHost(ownerId, hostId)).rejects.toThrow(NOT_FOUND_ERROR);
    });

    it("offers an online host's tools to a thread, and signs its calls with the host's secret", async () => {
        const { desktop, host } = await desktopWithHost(ownerId);
        const threadId = await insertThread(ownerId);
        const context = (await harness.run(
            async (ctx: any) => await ctx.runQuery(internals.getDeviceToolContext, { now: Date.now(), threadId, userId: ownerId }),
        )) as { devices: { deviceId: string }[] };

        // The desktop has a manifest too; the host is offered beside it.
        expect(context.devices.map((device) => device.deviceId).toSorted(byId)).toEqual([desktop.deviceId, host.deviceId].toSorted(byId));

        const { callId } = await hostCall(ownerId, host.deviceId);
        const pending = (await as(ownerId).query(
            functions.listPendingDeviceCalls as never,
            {
                deviceId: desktop.deviceId,
                hostDeviceIds: [host.deviceId],
            } as never,
        )) as { callId: string; deviceId: string; envelope: string; signature: string }[];

        expect(pending.map((call) => call.deviceId)).toEqual([host.deviceId]);
        await expect(verifyDevicePayload(host.secret, "call", pending[0]!.envelope, pending[0]!.signature)).resolves.toBe(true);
        await expect(verifyDevicePayload(desktop.secret, "call", pending[0]!.envelope, pending[0]!.signature)).resolves.toBe(false);
        expect(pending[0]?.callId).toBe(callId);
    });

    it("lists a host's calls only for the desktop that holds it", async () => {
        const { desktop, host } = await desktopWithHost(ownerId);
        const other = await pairedDevice(ownerId);

        await hostCall(ownerId, host.deviceId);

        const listFor = async (deviceId: string, hostDeviceIds: string[]) =>
            (await as(ownerId).query(functions.listPendingDeviceCalls as never, { deviceId, hostDeviceIds } as never)) as unknown[];

        await expect(listFor(other.deviceId, [host.deviceId])).resolves.toEqual([]);
        await expect(listFor(desktop.deviceId, [])).resolves.toEqual([]);
        await expect(listFor(desktop.deviceId, [host.deviceId])).resolves.toHaveLength(1);
        // A server's id is not a desktop: listing with it as the primary device shows nothing.
        await expect(listFor(host.deviceId, [])).resolves.toEqual([]);
    });

    it("refuses a claim for a host from a desktop that does not hold it, or from none", async () => {
        const { desktop, host } = await desktopWithHost(ownerId);
        const other = await pairedDevice(ownerId);
        const { callId } = await hostCall(ownerId, host.deviceId);
        const claim = async (viaDeviceId?: string) =>
            await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId: host.deviceId, viaDeviceId } as never);

        await expect(claim(other.deviceId)).rejects.toThrow(NOT_FOUND_ERROR);
        await expect(claim()).rejects.toThrow(NOT_FOUND_ERROR);
        await expect(claim(desktop.deviceId)).resolves.toEqual({ claimed: true });
    });

    it("accepts a host's result only when it is signed with the host's secret", async () => {
        const { desktop, host } = await desktopWithHost(ownerId);
        const { callId } = await hostCall(ownerId, host.deviceId);
        const complete = async (secret: string, viaDeviceId = desktop.deviceId) =>
            await as(ownerId).mutation(functions.completeDeviceCall as never, { ...(await signedResult(host.deviceId, secret, callId)), viaDeviceId } as never);

        await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId: host.deviceId, viaDeviceId: desktop.deviceId } as never);

        // The desktop's own secret, a made-up one: neither is the host's.
        await expect(complete(desktop.secret)).rejects.toThrow(SIGNATURE_ERROR);
        await expect(complete("e".repeat(64))).rejects.toThrow(SIGNATURE_ERROR);
        const { deviceId: otherDesktop } = await pairedDevice(ownerId);

        await expect(complete(host.secret, otherDesktop)).rejects.toThrow(NOT_FOUND_ERROR);
        await expect(complete(host.secret)).resolves.toEqual({ accepted: true });
        expect(await readCall(callId)).toMatchObject({ output: "file body", status: "completed" });
    });

    it("beats and reports progress for a host only through its desktop", async () => {
        const { desktop, host } = await desktopWithHost(ownerId);
        const { callId } = await hostCall(ownerId, host.deviceId);

        await as(ownerId).mutation(functions.claimDeviceCall as never, { callId, deviceId: host.deviceId, viaDeviceId: desktop.deviceId } as never);
        await expect(as(ownerId).mutation(functions.heartbeatDevice as never, { deviceId: host.deviceId } as never)).resolves.toEqual({ paired: false });
        await expect(
            as(ownerId).mutation(functions.heartbeatDevice as never, { deviceId: host.deviceId, viaDeviceId: desktop.deviceId } as never),
        ).resolves.toEqual({ paired: true });
        await expect(
            as(ownerId).mutation(
                functions.reportDeviceCallProgress as never,
                { ...(await signedProgress(host.deviceId, host.secret, callId)), viaDeviceId: desktop.deviceId } as never,
            ),
        ).resolves.toEqual({ accepted: true });
        await expect(
            as(ownerId).mutation(functions.reportDeviceCallProgress as never, (await signedProgress(host.deviceId, host.secret, callId)) as never),
        ).rejects.toThrow(NOT_FOUND_ERROR);
    });

    it("revoking the desktop revokes its hosts and expires their open calls; revoking a host leaves the desktop", async () => {
        const first = await desktopWithHost(ownerId);
        const second = await desktopWithHost(ownerId);
        const { callId } = await hostCall(ownerId, first.host.deviceId);
        const ids = async () =>
            ((await as(ownerId).query(functions.listDevices as never, {} as never)) as { _id: string }[]).map((device) => device._id).toSorted(byId);

        await as(ownerId).mutation(functions.revokeDevice as never, { deviceId: second.host.deviceId } as never);
        expect(await ids()).toEqual([first.desktop.deviceId, first.host.deviceId, second.desktop.deviceId].toSorted(byId));

        await as(ownerId).mutation(functions.revokeDevice as never, { deviceId: first.desktop.deviceId } as never);
        expect(await ids()).toEqual([second.desktop.deviceId]);
        expect(await readCall(callId)).toMatchObject({ status: "expired" });
    });
});
