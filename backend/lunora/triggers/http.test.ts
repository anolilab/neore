/**
 * Trigger webhooks: a delivery must carry a timestamp inside the window, signed
 * together with the body, and each signature is accepted once. The old
 * body-only signature let a captured request be replayed forever.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { internal } from "../_generated/internal";
import { claimKey, releaseKey } from "../lib/claim-once";
import { SIGNED_REQUEST_WINDOW_MS } from "../lib/crypto";
import handleTriggerWebhook from "./http";

const rateLimit = vi.hoisted(() => {
    return { charged: 0, ok: true };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        checkRateLimit: async () => {
            rateLimit.charged += 1;

            return { ok: rateLimit.ok };
        },
    };
});

const SECRET = "whsec_test";
const NOW = 1_800_000_000_000;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const hmacHex = async (payload: string): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));

    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const SIGNED_TRIGGER = { enabled: true, type: "webhook", webhookSecret: SECRET };

const setup = async (trigger: Record<string, unknown> = SIGNED_TRIGGER) => {
    const triggerId = await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("triggers", {
                createdAt: NOW,
                enabled: true,
                model: "m",
                name: "t",
                triggerCount: 0,
                type: "webhook",
                updatedAt: NOW,
                userId: "u",
            }),
    );
    const scheduled: unknown[] = [];
    const scheduler = { fail: false };
    const context = {
        runMutation: async (reference: unknown, args: unknown) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(reference === internal.lib.claim_once.releaseKey ? releaseKey : claimKey, args)),
        runQuery: async () => trigger,
        scheduler: {
            runAfter: async (_delay: number, _reference: unknown, args: unknown) => {
                if (scheduler.fail) {
                    throw new Error("scheduler unavailable");
                }

                scheduled.push(args);
            },
        },
    };

    const post = async (body: string, headers: Record<string, string>) =>
        await handleTriggerWebhook(context as never, new Request("https://x/triggers/webhook/t", { body, headers, method: "POST" }), triggerId);

    /** Just the status code of a delivery. */
    const statusOf = async (body: string, headers: Record<string, string>): Promise<number> => {
        const response = await post(body, headers);

        return response.status;
    };

    return { post, scheduled, scheduler, statusOf };
};

const signedHeaders = async (body: string, timestampSeconds = Math.floor(NOW / 1000)) => {
    return {
        "x-neore-timestamp": String(timestampSeconds),
        "x-signature-256": `sha256=${await hmacHex(`${String(timestampSeconds)}.${body}`)}`,
    };
};

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    rateLimit.charged = 0;
    rateLimit.ok = true;
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("trigger webhook signing", () => {
    it("runs a fresh, correctly signed delivery exactly once — a replay is acknowledged but not run", async () => {
        const { post, scheduled, statusOf } = await setup();
        const body = '{"event":"x"}';
        const headers = await signedHeaders(body);

        expect(await statusOf(body, headers)).toBe(200);
        expect(scheduled).toHaveLength(1);

        const replay = await post(body, headers);

        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ duplicate: true });
        expect(scheduled).toHaveLength(1);
    });

    it("refuses a timestamp outside the window, even when correctly signed", async () => {
        const { scheduled, statusOf } = await setup();
        const body = "{}";
        const stale = Math.floor((NOW - SIGNED_REQUEST_WINDOW_MS - 1000) / 1000);

        expect(await statusOf(body, await signedHeaders(body, stale))).toBe(401);
        expect(scheduled).toHaveLength(0);
    });

    it("refuses the old body-only signature and a missing timestamp", async () => {
        const { scheduled, statusOf } = await setup();
        const body = "{}";
        const bodyOnly = `sha256=${await hmacHex(body)}`;

        expect(await statusOf(body, { "x-signature-256": bodyOnly })).toBe(401);
        expect(await statusOf(body, { "x-neore-timestamp": String(Math.floor(NOW / 1000)), "x-signature-256": bodyOnly })).toBe(401);
        expect(scheduled).toHaveLength(0);
    });

    it("refuses every delivery to a trigger without a secret (legacy rows)", async () => {
        const { scheduled, statusOf } = await setup({ enabled: true, type: "webhook" });

        expect(await statusOf("{}", await signedHeaders("{}"))).toBe(401);
        expect(scheduled).toHaveLength(0);
    });

    it("charges the delivery limit only once the signature is verified", async () => {
        const { scheduled, statusOf } = await setup();
        const body = "{}";

        rateLimit.ok = false;
        expect(await statusOf(body, { "x-neore-timestamp": String(Math.floor(NOW / 1000)), "x-signature-256": "sha256=00" })).toBe(401);
        expect(rateLimit.charged).toBe(0);

        expect(await statusOf(body, await signedHeaders(body))).toBe(429);
        expect(rateLimit.charged).toBe(1);
        expect(scheduled).toHaveLength(0);
    });

    it("gives the replay claim back when scheduling fails, so the sender's retry runs", async () => {
        const { scheduled, scheduler, statusOf } = await setup();
        const body = '{"event":"retry"}';
        const headers = await signedHeaders(body);

        scheduler.fail = true;
        expect(await statusOf(body, headers)).toBe(500);
        expect(scheduled).toHaveLength(0);

        scheduler.fail = false;
        expect(await statusOf(body, headers)).toBe(200);
        expect(scheduled).toHaveLength(1);
    });
});
