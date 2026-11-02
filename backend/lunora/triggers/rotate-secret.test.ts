/**
 * Rotating a webhook trigger's secret: the old secret is refused at once, or only after an opt-in 24 h overlap,
 * proved through the real webhook handler against the stored row.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internal } from "../_generated/internal";
import { claimKey, claimKeyFenced, releaseKey } from "../lib/claim-once";
import schema from "../schema";
import { createTrigger, getTriggers, rotateWebhookSecret, WEBHOOK_SECRET_OVERLAP_MS } from "./functions";
import handleTriggerWebhook from "./http";

const { registry, sessionFrom } = vi.hoisted(() => {
    return {
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
    };
});

vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "triggers_functions", await import("./functions"));
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        checkRateLimit: async () => {
            return { ok: true };
        },
        rateLimitGuard: async () => undefined,
    };
});

const NOW = 1_800_000_000_000;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const as = (userId = "user-a") => harness.withIdentity({ userId } as never);

const create = async (): Promise<{ triggerId: string; webhookSecret: string }> =>
    (await as().mutation(createTrigger as never, { model: "m", name: "Hook", type: "webhook" } as never)) as { triggerId: string; webhookSecret: string };

const rotate = async (triggerId: string, keepOldFor24h?: boolean) =>
    (await as().mutation(rotateWebhookSecret as never, { keepOldFor24h, triggerId } as never)) as {
        previousSecretExpiresAt: null | number;
        webhookSecret: string;
    };

const hmacHex = async (secret: string, payload: string): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));

    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** One timestamped delivery signed with `secret`, through the handler against the stored row; the status code. */
let counter = 0;

const deliverResponse = async (triggerId: string, secret: string, same?: { body: string; timestamp: string }): Promise<Response> => {
    // A fresh body per call, so the replay claim never answers for the signature check.
    counter += 1;

    const body = same?.body ?? `{"n":${String(counter)}}`;
    const timestamp = same?.timestamp ?? String(Math.floor(Date.now() / 1000));
    const context = {
        runMutation: async (reference: unknown, args: unknown) => {
            const mutations = new Map<unknown, unknown>([
                [internal.lib.claim_once.claimKeyFenced, claimKeyFenced],
                [internal.lib.claim_once.releaseKey, releaseKey],
            ]);
            const mutation = mutations.get(reference) ?? claimKey;

            return await harness.run(async (ctx: any) => await ctx.runMutation(mutation, args));
        },
        runQuery: async () => await harness.run(async (ctx: any) => await ctx.db.get("triggers", triggerId as never)),
        scheduler: { runAfter: async () => undefined },
    };
    const headers = { "x-neore-timestamp": timestamp, "x-signature-256": `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}` };

    return await handleTriggerWebhook(context as never, new Request("https://x/triggers/webhook/t", { body, headers, method: "POST" }), triggerId);
};

const deliver = async (triggerId: string, secret: string): Promise<number> => {
    const response = await deliverResponse(triggerId, secret);

    return response.status;
};

const enable = async (triggerId: string) => await harness.run(async (ctx: any) => await ctx.db.patch("triggers", triggerId as never, { enabled: true }));

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("rotateWebhookSecret", () => {
    it("refuses a delivery signed with the old secret once rotated, and accepts the new one", async () => {
        const { triggerId, webhookSecret: oldSecret } = await create();

        await enable(triggerId);
        expect(await deliver(triggerId, oldSecret)).toBe(200);

        const { previousSecretExpiresAt, webhookSecret: newSecret } = await rotate(triggerId);

        expect(newSecret).not.toBe(oldSecret);
        expect(previousSecretExpiresAt).toBeNull();
        expect(await deliver(triggerId, oldSecret)).toBe(401);
        expect(await deliver(triggerId, newSecret)).toBe(200);

        const row = await harness.run(async (ctx: any) => await ctx.db.get("triggers", triggerId as never));

        expect(row.webhookPreviousSecret).toBeUndefined();
        expect(row.webhookPreviousSecretExpiresAt).toBeUndefined();
    });

    it("accepts the old secret during an opted-in overlap and refuses it after 24 hours", async () => {
        const { triggerId, webhookSecret: oldSecret } = await create();

        await enable(triggerId);

        const { previousSecretExpiresAt, webhookSecret: newSecret } = await rotate(triggerId, true);

        expect(previousSecretExpiresAt).toBe(NOW + WEBHOOK_SECRET_OVERLAP_MS);
        expect(await deliver(triggerId, oldSecret)).toBe(200);
        expect(await deliver(triggerId, newSecret)).toBe(200);

        const [listed] = (await as().query(getTriggers as never, {} as never)) as { webhookPreviousSecretExpiresAt: null | number }[];

        expect(listed!.webhookPreviousSecretExpiresAt).toBe(NOW + WEBHOOK_SECRET_OVERLAP_MS);

        vi.setSystemTime(NOW + WEBHOOK_SECRET_OVERLAP_MS + 1);
        expect(await deliver(triggerId, oldSecret)).toBe(401);
        expect(await deliver(triggerId, newSecret)).toBe(200);
    });

    it("runs one delivery once when it is signed with both the old and the new secret during an overlap", async () => {
        const { triggerId, webhookSecret: oldSecret } = await create();

        await enable(triggerId);

        const { webhookSecret: newSecret } = await rotate(triggerId, true);
        const same = { body: '{"event":"push"}', timestamp: String(Math.floor(Date.now() / 1000)) };
        const first = await deliverResponse(triggerId, oldSecret, same);
        const second = await deliverResponse(triggerId, newSecret, same);

        expect(first.status).toBe(200);
        expect(await first.json()).not.toHaveProperty("duplicate");
        expect(await second.json()).toMatchObject({ duplicate: true });
    });

    it("a second rotation ends the overlap of the first, and a plain rotation clears a running one", async () => {
        const { triggerId, webhookSecret: first } = await create();

        await enable(triggerId);

        const { webhookSecret: second } = await rotate(triggerId, true);
        const { webhookSecret: third } = await rotate(triggerId, true);

        expect(await deliver(triggerId, first)).toBe(401);
        expect(await deliver(triggerId, second)).toBe(200);

        const { webhookSecret: fourth } = await rotate(triggerId);

        expect(await deliver(triggerId, second)).toBe(401);
        expect(await deliver(triggerId, third)).toBe(401);
        expect(await deliver(triggerId, fourth)).toBe(200);
    });

    it("is refused for another user's trigger and for a trigger that is not a webhook", async () => {
        const { triggerId } = await create();

        await expect(as("user-b").mutation(rotateWebhookSecret as never, { triggerId } as never)).rejects.toThrow("Trigger not found");

        const schedule = (await as().mutation(
            createTrigger as never,
            { cronExpression: "0 9 * * 1", model: "m", name: "Daily", type: "schedule" } as never,
        )) as {
            triggerId: string;
        };

        await expect(as().mutation(rotateWebhookSecret as never, { triggerId: schedule.triggerId } as never)).rejects.toThrow("Only a webhook trigger");
    });

    it("never lists a secret", async () => {
        const { triggerId } = await create();

        await rotate(triggerId, true);

        const listed = JSON.stringify(await as().query(getTriggers as never, {} as never));

        expect(listed).not.toContain("webhookSecret");
        expect(listed).not.toContain("v1:");
    });
});
