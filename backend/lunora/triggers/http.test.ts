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
import { recordFilteredExecution } from "./functions";
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

const hmacHex = async (payload: string | Uint8Array): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, typeof payload === "string" ? new TextEncoder().encode(payload) : (payload as BufferSource));

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
    const scheduler = { fail: false, recordFails: false };
    const context = {
        runMutation: async (reference: unknown, args: unknown) => {
            if (reference === internal.triggers.functions.recordFilteredExecution) {
                if (scheduler.recordFails) {
                    throw new Error("write failed");
                }

                return await harness.run(async (ctx: any) => await ctx.runMutation(recordFilteredExecution, args));
            }

            return await harness.run(async (ctx: any) => await ctx.runMutation(reference === internal.lib.claim_once.releaseKey ? releaseKey : claimKey, args));
        },
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

    const post = async (body: string | Uint8Array, headers: Record<string, string>) =>
        await handleTriggerWebhook(
            context as never,
            new Request("https://x/triggers/webhook/t", { body: body as BodyInit, headers, method: "POST" }),
            triggerId,
        );

    /** Just the status code of a delivery. */
    const statusOf = async (body: string | Uint8Array, headers: Record<string, string>): Promise<number> => {
        const response = await post(body, headers);

        return response.status;
    };

    /** The execution rows of the trigger, newest first. */
    const history = async () =>
        await harness.run(async (ctx: any) => {
            const rows = await ctx.db.query("triggerExecutions").collect();

            return rows.toSorted((a: any, b: any) => b.startedAt - a.startedAt);
        });

    return { history, post, scheduled, scheduler, statusOf, triggerId };
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

    it("verifies a timestamped delivery over the raw bytes too, for a body that is not valid UTF-8", async () => {
        const { scheduled, statusOf } = await setup();
        const body = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
        const timestamp = String(Math.floor(NOW / 1000));
        const signed = new Uint8Array([...new TextEncoder().encode(`${timestamp}.`), ...body]);

        expect(await statusOf(body, { "x-neore-timestamp": timestamp, "x-signature-256": `sha256=${await hmacHex(signed)}` })).toBe(200);
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

    describe("native body-only signature (X-Hub-Signature-256)", () => {
        const NATIVE_TRIGGER = { ...SIGNED_TRIGGER, webhookSignatureScheme: "native" };
        const nativeHeaders = async (body: string, extra: Record<string, string> = {}) => {
            return { "x-hub-signature-256": `sha256=${await hmacHex(body)}`, ...extra };
        };

        it("accepts GitHub-style signing with the raw secret and runs the trigger once", async () => {
            const { scheduled, statusOf } = await setup(NATIVE_TRIGGER);
            const body = '{"action":"opened"}';

            expect(await statusOf(body, await nativeHeaders(body))).toBe(200);
            expect(scheduled).toHaveLength(1);
        });

        it("verifies the signature over the raw bytes, so a body that is not valid UTF-8 is accepted", async () => {
            const { scheduled, statusOf } = await setup(NATIVE_TRIGGER);
            const body = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);

            expect(await statusOf(body, { "x-hub-signature-256": `sha256=${await hmacHex(body)}` })).toBe(200);
            expect(scheduled).toHaveLength(1);
        });

        it("verifies a body that starts with a byte-order mark against the bytes as sent", async () => {
            const { scheduled, statusOf } = await setup(NATIVE_TRIGGER);
            const body = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);

            expect(await statusOf(body, { "x-hub-signature-256": `sha256=${await hmacHex(body)}` })).toBe(200);
            expect(scheduled).toHaveLength(1);
        });

        it("refuses a wrong signature, a tampered body, a bare-hex value and a missing secret", async () => {
            const { scheduled, statusOf } = await setup(NATIVE_TRIGGER);
            const body = '{"action":"opened"}';
            const wrong = `sha256=${"0".repeat(64)}`;

            expect(await statusOf(body, { "x-hub-signature-256": wrong })).toBe(401);
            expect(await statusOf('{"action":"closed"}', await nativeHeaders(body))).toBe(401);

            const signed = await nativeHeaders(body);

            expect(await statusOf(body, { "x-hub-signature-256": signed["x-hub-signature-256"].slice(7) })).toBe(401);
            expect(scheduled).toHaveLength(0);

            const legacy = await setup({ enabled: true, type: "webhook", webhookSignatureScheme: "native" });

            expect(await legacy.statusOf(body, await nativeHeaders(body))).toBe(401);
            expect(legacy.scheduled).toHaveLength(0);
        });

        it("answers a replay of the same body as a duplicate, even under a fresh delivery id", async () => {
            const { post, scheduled } = await setup(NATIVE_TRIGGER);
            const body = '{"action":"opened"}';
            const first = await post(body, await nativeHeaders(body, { "x-github-delivery": "one" }));

            expect(first.status).toBe(200);

            const replay = await post(body, await nativeHeaders(body, { "x-github-delivery": "two" }));

            expect(replay.status).toBe(200);
            expect(await replay.json()).toMatchObject({ duplicate: true });
            expect(scheduled).toHaveLength(1);
        });
        it("refuses a timestamped delivery on a native trigger", async () => {
            const { scheduled, statusOf } = await setup(NATIVE_TRIGGER);
            const body = '{"event":"x"}';

            expect(await statusOf(body, await signedHeaders(body))).toBe(401);
            expect(scheduled).toHaveLength(0);
        });

        it('does not let a captured timestamped signature pass as the native signature of "ts.body"', async () => {
            const { scheduled, statusOf } = await setup();
            const body = '{"event":"x"}';
            const captured = await signedHeaders(body);

            expect(await statusOf(`${captured["x-neore-timestamp"]}.${body}`, { "x-hub-signature-256": captured["x-signature-256"] })).toBe(401);
            expect(scheduled).toHaveLength(0);
        });

        it("is refused by a timestamped trigger, with or without the timestamped headers alongside", async () => {
            const { scheduled, statusOf } = await setup();
            const body = "{}";

            expect(await statusOf(body, await nativeHeaders(body))).toBe(401);
            expect(await statusOf(body, { ...(await nativeHeaders(body)), ...(await signedHeaders(body)) })).toBe(401);

            const explicit = await setup({ ...SIGNED_TRIGGER, webhookSignatureScheme: "timestamped" });

            expect(await explicit.statusOf(body, await nativeHeaders(body))).toBe(401);
            expect(await explicit.statusOf(body, await signedHeaders(body))).toBe(200);
            expect(scheduled).toHaveLength(0);
        });

        it("refuses a native trigger's delivery that also carries timestamped headers", async () => {
            const { scheduled, statusOf } = await setup(NATIVE_TRIGGER);
            const body = "{}";

            expect(await statusOf(body, { ...(await nativeHeaders(body)), "x-neore-timestamp": String(Math.floor(NOW / 1000)) })).toBe(401);
            expect(scheduled).toHaveLength(0);
        });

        it("charges the delivery limit only after the native signature verifies", async () => {
            const { statusOf } = await setup(NATIVE_TRIGGER);

            rateLimit.ok = false;
            expect(await statusOf("{}", { "x-hub-signature-256": `sha256=${"0".repeat(64)}` })).toBe(401);
            expect(rateLimit.charged).toBe(0);
        });
    });

    describe("payload filters", () => {
        const FILTERED_TRIGGER = {
            ...SIGNED_TRIGGER,
            filters: [
                { op: "equals", path: "action", value: "opened" },
                { op: "exists", path: "pull_request.number" },
            ],
        };
        const MATCHING = '{"action":"opened","pull_request":{"number":7}}';
        const stampOf = (body: string, seconds: number) => signedHeaders(body, seconds);
        /** Delivers a signed body that fails FILTERED_TRIGGER's filters; `n` keeps each delivery distinct. */
        const missOf = async (statusOf: (body: string, headers: Record<string, string>) => Promise<number>, n: number) => {
            const body = `{"action":"closed","n":${String(n)}}`;

            return await statusOf(body, await stampOf(body, Math.floor(NOW / 1000)));
        };

        it("runs a delivery whose payload matches every filter", async () => {
            const { history, scheduled, statusOf } = await setup(FILTERED_TRIGGER);

            expect(await statusOf(MATCHING, await signedHeaders(MATCHING))).toBe(200);
            expect(scheduled).toHaveLength(1);
            expect(await history()).toHaveLength(0);
        });

        it("answers 202 'filtered' with the first failing filter, runs nothing and records one row", async () => {
            const { history, post, scheduled, triggerId } = await setup(FILTERED_TRIGGER);
            const body = '{"action":"closed","pull_request":{"number":7}}';
            const response = await post(body, await signedHeaders(body));

            expect(response.status).toBe(202);
            expect(await response.json()).toMatchObject({ filter: { op: "equals", path: "action", value: "opened" }, ok: true, outcome: "filtered" });
            expect(scheduled).toHaveLength(0);

            const rows = await history();

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: "filtered", triggerId });
            // The untrusted body is not stored.
            expect(rows[0].payload).toBeUndefined();

            // Nothing counts as a run: the trigger's bookkeeping is untouched.
            const trigger = await harness.run(async (ctx: any) => await ctx.db.get(triggerId));

            expect(trigger).toMatchObject({ triggerCount: 0 });
            expect(trigger.lastTriggeredAt).toBeUndefined();
        });

        it("treats a missing path as a failed match", async () => {
            const { scheduled, statusOf } = await setup(FILTERED_TRIGGER);
            const body = '{"action":"opened"}';

            expect(await statusOf(body, await signedHeaders(body))).toBe(202);
            expect(scheduled).toHaveLength(0);
        });

        it("filters a non-JSON body, fail closed", async () => {
            const { scheduled, statusOf } = await setup({ ...SIGNED_TRIGGER, filters: [{ op: "not_exists", path: "x" }] });

            expect(await statusOf("plain text", await signedHeaders("plain text"))).toBe(202);
            expect(scheduled).toHaveLength(0);
        });

        it("filters a signed body that is only JSON once invalid UTF-8 is replaced", async () => {
            const { scheduled, statusOf } = await setup({ ...SIGNED_TRIGGER, filters: [{ op: "equals", path: "action", value: "opened" }] });
            const prefix = new TextEncoder().encode('{"action":"opened","note":"');
            const body = new Uint8Array([...prefix, 0xff, 0x22, 0x7d]);
            const timestamp = String(Math.floor(NOW / 1000));
            const signed = new Uint8Array([...new TextEncoder().encode(`${timestamp}.`), ...body]);

            expect(await statusOf(body, { "x-neore-timestamp": timestamp, "x-signature-256": `sha256=${await hmacHex(signed)}` })).toBe(202);
            expect(scheduled).toHaveLength(0);
        });

        it("evaluates filters on a signed body that starts with a byte-order mark", async () => {
            const { scheduled, statusOf } = await setup({ ...SIGNED_TRIGGER, filters: [{ op: "equals", path: "action", value: "opened" }] });
            const body = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"action":"opened"}')]);
            const timestamp = String(Math.floor(NOW / 1000));
            const signed = new Uint8Array([...new TextEncoder().encode(`${timestamp}.`), ...body]);

            expect(await statusOf(body, { "x-neore-timestamp": timestamp, "x-signature-256": `sha256=${await hmacHex(signed)}` })).toBe(200);
            expect(scheduled).toHaveLength(1);
        });

        it("never evaluates an unsigned body, and charges nothing for it", async () => {
            const { history, statusOf } = await setup(FILTERED_TRIGGER);

            expect(await statusOf("{}", { "x-neore-timestamp": String(Math.floor(NOW / 1000)), "x-signature-256": "sha256=00" })).toBe(401);
            expect(await history()).toHaveLength(0);
        });

        it("releases the claim, so a replay of a filtered delivery is evaluated again and still collapses into one row", async () => {
            const { history, post, scheduled } = await setup(FILTERED_TRIGGER);
            const body = '{"action":"closed"}';
            const headers = await signedHeaders(body);

            const first = await post(body, headers);

            expect(first.status).toBe(202);

            const replay = await post(body, headers);

            expect(replay.status).toBe(202);
            expect(await replay.json()).toMatchObject({ outcome: "filtered" });
            expect(scheduled).toHaveLength(0);
            expect(await history()).toHaveLength(1);
        });

        it("collapses consecutive filtered deliveries into one history row, and a run starts a new one", async () => {
            const { history, statusOf } = await setup(FILTERED_TRIGGER);
            const miss = async (n: number) => await missOf(statusOf, n);

            expect(await miss(1)).toBe(202);
            expect(await miss(2)).toBe(202);
            expect(await miss(3)).toBe(202);
            expect(await history()).toHaveLength(1);
        });

        it("keeps one filtered row even when misses alternate with runs, so runs stay visible", async () => {
            const { history, statusOf, triggerId } = await setup(FILTERED_TRIGGER);
            const miss = async (n: number) => await missOf(statusOf, n);

            for (let n = 1; n <= 4; n += 1) {
                vi.setSystemTime(NOW + n * 2000);
                expect(await miss(n)).toBe(202);

                vi.setSystemTime(NOW + n * 2000 + 1000);
                await harness.run(async (ctx: any) => {
                    await ctx.db.insert("triggerExecutions", { startedAt: Date.now(), status: "completed", triggerId });
                });
            }

            const rows = await history();

            expect(rows.filter((row: any) => row.status === "filtered")).toHaveLength(1);
            expect(rows.filter((row: any) => row.status === "completed")).toHaveLength(4);
        });

        it("still reuses the filtered row after more runs than the history lookback", async () => {
            const { history, statusOf, triggerId } = await setup(FILTERED_TRIGGER);

            expect(await missOf(statusOf, 1)).toBe(202);

            await harness.run(async (ctx: any) => {
                for (let n = 1; n <= 60; n += 1) {
                    await ctx.db.insert("triggerExecutions", { startedAt: NOW + n, status: "completed", triggerId });
                }
            });

            vi.setSystemTime(NOW + 1000);
            expect(await missOf(statusOf, 2)).toBe(202);

            const rows = await history();

            expect(rows.filter((row: any) => row.status === "filtered")).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: "filtered" });
        });

        it("gives the claim back when the filtered row cannot be written, so the sender's retry is evaluated", async () => {
            const { post, scheduler } = await setup(FILTERED_TRIGGER);
            const body = '{"action":"closed"}';
            const headers = await signedHeaders(body);

            scheduler.recordFails = true;
            const failed = await post(body, headers);

            expect(failed.status).toBe(500);

            scheduler.recordFails = false;

            const retried = await post(body, headers);

            expect(retried.status).toBe(202);
        });

        it("still charges the delivery limit, since the sender is proven", async () => {
            const { statusOf } = await setup(FILTERED_TRIGGER);

            expect(await statusOf('{"action":"closed"}', await signedHeaders('{"action":"closed"}'))).toBe(202);
            expect(rateLimit.charged).toBe(1);
        });
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
