/**
 * The backend-started `acp_cancel` call has its own open-call budget; a call that can no longer be claimed
 * (past `ACP_CLAIM_WINDOW_MS`) must not count against it, or Stop stays refused after an offline spell.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lib/encryption.ts` refuses to load without a key.
const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const { default: schema } = await import("../../schema");
const { encryptKey } = await import("../../lib/encryption");
const { createAcpCall, createAcpCancelCall } = await import("./acp-call");
const { ACP_CLAIM_WINDOW_MS, MAX_OPEN_ACP_CALLS_PER_DEVICE } = await import("./constants");

const OWNER = "owner";
const NOW = 1_000_000_000;

let harness: ReturnType<typeof lunoraTest>;
let deviceId: string;
let threadId: string;

const insertCall = async (fields: Record<string, unknown>) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("deviceCalls", {
                createdAt: NOW,
                deadline: NOW + 600_000,
                deviceId,
                deviceName: "Laptop",
                envelope: "",
                input: "{}",
                signature: "",
                status: "pending",
                taintedBy: [],
                threadId,
                toolName: "acp_cancel",
                userId: OWNER,
                ...fields,
            }),
    );

const cancel = async () =>
    await harness.run(
        async (ctx: any) =>
            await createAcpCancelCall(ctx, { deviceId: deviceId as never, hostSessionId: "s", threadId: threadId as never, turnId: "t", userId: OWNER }, NOW),
    );

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    deviceId = (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("devices", {
                createdAt: NOW,
                encryptedSecret: await encryptKey("00".repeat(32), "device-secrets"),
                name: "Laptop",
                platform: "linux",
                userId: OWNER,
            }),
    )) as string;
    threadId = (await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { runner: "host", status: "active", title: "Agent", userId: OWNER }),
    )) as string;
});

afterEach(() => {
    harness.close();
});

describe("createAcpCancelCall", () => {
    it("is refused as busy while the budget is spent on claimable calls", async () => {
        for (let index = 0; index < MAX_OPEN_ACP_CALLS_PER_DEVICE; index += 1) {
            await insertCall({});
        }

        await expect(cancel()).resolves.toEqual({ error: "busy" });
    });

    it("does not count pending calls past their claim window", async () => {
        for (let index = 0; index < MAX_OPEN_ACP_CALLS_PER_DEVICE; index += 1) {
            await insertCall({ createdAt: NOW - ACP_CLAIM_WINDOW_MS - 1 });
        }

        await expect(cancel()).resolves.toHaveProperty("callId");
    });

    it("still counts a claimed call, however old", async () => {
        for (let index = 0; index < MAX_OPEN_ACP_CALLS_PER_DEVICE; index += 1) {
            await insertCall({ claimedAt: NOW - 1000, createdAt: NOW - ACP_CLAIM_WINDOW_MS - 1, status: "claimed" });
        }

        await expect(cancel()).resolves.toEqual({ error: "busy" });
    });
});

describe("createAcpCall taint", () => {
    const send = async (taintedBy?: string[]) =>
        await harness.run(
            async (ctx: any) =>
                await createAcpCall(
                    ctx,
                    {
                        deviceId: deviceId as never,
                        input: { sessionId: "s", text: "hi", turnId: "t" },
                        kind: "acp_send",
                        taintedBy: taintedBy as never,
                        threadId: threadId as never,
                        userId: OWNER,
                    },
                    Date.now(),
                ),
        );

    const lastCall = async (): Promise<{ envelope: string; taintedBy: string[] }> => {
        const { page } = (await harness.run(async (ctx: any) => await ctx.db.deviceCalls.findMany({ where: {} }))) as { page: any[] };

        return page.at(-1);
    };

    it("signs the taint it is given into the row and the envelope, in the stable order", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(deviceId, { lastSeenAt: Date.now() }));
        expect(await send(["mcp", "web"])).toHaveProperty("callId");

        const call = await lastCall();

        expect(call.taintedBy).toEqual(["web", "mcp"]);
        expect(JSON.parse(call.envelope)).toMatchObject({ taintedBy: ["web", "mcp"] });
    });

    it("is untainted when nothing says otherwise", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(deviceId, { lastSeenAt: Date.now() }));
        await send();

        const call = await lastCall();

        expect(call.taintedBy).toEqual([]);
    });
});
