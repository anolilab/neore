/**
 * Trigger webhooks: a delivery must carry a timestamp inside the window, signed
 * together with the body, and each signature is accepted once. The old
 * body-only signature let a captured request be replayed forever.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { internal } from "../_generated/internal";
import { claimKey, claimKeyFenced, releaseKey, TRIGGER_CLAIM_TTL_MS } from "../lib/claim-once";
import { SIGNED_REQUEST_WINDOW_MS } from "../lib/crypto";
import { claimWebhookDelivery, releaseWebhookDelivery } from "./deliveries";
import { recordFilteredExecution } from "./functions";
import handleTriggerWebhook, { verifyHmacSignature } from "./http";

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

/** The claim mutation the webhook handler calls, served by the harness's own copy. */
const claimMutation = (reference: unknown) => {
    if (reference === internal.lib.claim_once.releaseKey) {
        return releaseKey;
    }

    if (reference === internal.triggers.deliveries.claimWebhookDelivery) {
        return claimWebhookDelivery;
    }

    if (reference === internal.triggers.deliveries.releaseWebhookDelivery) {
        return releaseWebhookDelivery;
    }

    return reference === internal.lib.claim_once.claimKeyFenced ? claimKeyFenced : claimKey;
};

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
    const scheduler: { beforeFail?: () => Promise<void>; fail: boolean; recordFails: boolean } = { fail: false, recordFails: false };
    const context = {
        runMutation: async (reference: unknown, args: unknown) => {
            if (reference === internal.triggers.functions.recordFilteredExecution) {
                if (scheduler.recordFails) {
                    throw new Error("write failed");
                }

                return await harness.run(async (ctx: any) => await ctx.runMutation(recordFilteredExecution, args));
            }

            return await harness.run(async (ctx: any) => await ctx.runMutation(claimMutation(reference), args));
        },
        runQuery: async () => trigger,
        scheduler: {
            runAfter: async (_delay: number, _reference: unknown, args: unknown) => {
                if (scheduler.fail) {
                    await scheduler.beforeFail?.();

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

        it("flags a body that is not valid UTF-8 for the run, so admission evaluates the same text", async () => {
            const { scheduled, statusOf } = await setup(SIGNED_TRIGGER);
            const body = new Uint8Array([...new TextEncoder().encode('{"note":"'), 0xff, 0x22, 0x7d]);
            const timestamp = String(Math.floor(NOW / 1000));
            const signed = new Uint8Array([...new TextEncoder().encode(`${timestamp}.`), ...body]);

            expect(await statusOf(body, { "x-neore-timestamp": timestamp, "x-signature-256": `sha256=${await hmacHex(signed)}` })).toBe(200);
            expect(scheduled).toEqual([expect.objectContaining({ invalidUtf8: true })]);
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

    it("does not clear the replacement claim when scheduling fails after the claim's TTL", async () => {
        const { scheduler, statusOf } = await setup();
        const body = '{"event":"slow"}';
        const headers = await signedHeaders(body);
        const claimRows = async (): Promise<{ claimedAt: number; key: string; scope: string }[]> =>
            await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect());

        scheduler.fail = true;
        // The scheduler call hangs past the TTL, a redelivery takes the lapsed key, then the call fails.
        scheduler.beforeFail = async () => {
            const [original] = await claimRows();

            vi.setSystemTime(NOW + TRIGGER_CLAIM_TTL_MS + 1);
            await harness.run(
                async (ctx: any) => await ctx.runMutation(claimKeyFenced, { key: original!.key, scope: original!.scope, ttlMs: TRIGGER_CLAIM_TTL_MS }),
            );
        };

        expect(await statusOf(body, headers)).toBe(500);
        expect(await claimRows()).toEqual([expect.objectContaining({ claimedAt: NOW + TRIGGER_CLAIM_TTL_MS + 1 })]);
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

describe("provider signature schemes", () => {
    const GITLAB_TRIGGER = { ...SIGNED_TRIGGER, webhookSignatureScheme: "gitlab-token" };

    it("matches the documented GitHub test vector, both prefixed and bare", async () => {
        const secret = "It's a Secret to Everybody";
        const digest = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

        expect(await verifyHmacSignature(secret, "Hello, World!", `sha256=${digest}`)).toBe(true);
        expect(await verifyHmacSignature(secret, "Hello, World!", digest)).toBe(true);
        expect(await verifyHmacSignature(secret, "Hello, World!!", digest)).toBe(false);
    });

    describe("a request carrying X-Gitlab-Token", () => {
        const body = "{}";
        const valid = {
            native: async () => {
                return { "x-hub-signature-256": `sha256=${await hmacHex(body)}` };
            },
            timestamped: async () => await signedHeaders(body),
        };

        for (const scheme of ["native", "timestamped"] as const) {
            it(`is refused by a ${scheme} trigger, even with a valid ${scheme} signature`, async () => {
                const { scheduled, statusOf } = await setup({ ...SIGNED_TRIGGER, webhookSignatureScheme: scheme });
                const headers = await valid[scheme]();

                expect(await statusOf(body, { ...headers, "x-gitlab-token": SECRET })).toBe(401);
                expect(scheduled).toHaveLength(0);
                // The same request without the foreign header is accepted, so the refusal is the header's.
                expect(await statusOf(body, headers)).toBe(200);
                expect(scheduled).toHaveLength(1);
            });
        }

        it("is refused by a trigger with no stored scheme, which is timestamped", async () => {
            const { statusOf } = await setup(SIGNED_TRIGGER);

            expect(await statusOf(body, { ...(await signedHeaders(body)), "x-gitlab-token": SECRET })).toBe(401);
        });
    });

    describe("gitlab-token", () => {
        const UUID = "0a2f7c1e-6c1d-4b53-9d3a-1f7e4d0c9b11";
        const gitlab = (uuid: string = UUID) => {
            return { "x-gitlab-event-uuid": uuid, "x-gitlab-token": SECRET };
        };
        const records = async (): Promise<{ bodyDigest: string; createdAt: number; deliveryId: string }[]> =>
            await harness.run(async (ctx: any) => await ctx.db.query("webhookDeliveries").collect());

        it("accepts the token with a delivery id, and records the delivery", async () => {
            const { scheduled, statusOf } = await setup(GITLAB_TRIGGER);

            expect(await statusOf('{"object_kind":"merge_request"}', gitlab())).toBe(200);
            expect(scheduled).toHaveLength(1);
            expect(await records()).toEqual([expect.objectContaining({ createdAt: NOW, deliveryId: UUID })]);
        });

        it("takes no body claim: the permanent record is the only replay guard", async () => {
            const { statusOf } = await setup(GITLAB_TRIGGER);

            await statusOf('{"n":1}', gitlab());

            expect(await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect())).toEqual([]);
        });

        it("runs two different deliveries that carry the same token", async () => {
            // The token is the same on every delivery, so a claim keyed on it would swallow the second.
            const { scheduled, statusOf } = await setup(GITLAB_TRIGGER);

            expect(await statusOf('{"n":1}', gitlab("11111111-1111-4111-8111-111111111111"))).toBe(200);
            expect(await statusOf('{"n":2}', gitlab("22222222-2222-4222-8222-222222222222"))).toBe(200);
            expect(scheduled).toHaveLength(2);
        });

        it("answers the same delivery id and body as a duplicate", async () => {
            const { post, scheduled } = await setup(GITLAB_TRIGGER);
            const body = '{"n":1}';

            await post(body, gitlab());

            const replay = await post(body, gitlab());

            expect(replay.status).toBe(200);
            expect(await replay.json()).toMatchObject({ duplicate: true });
            expect(scheduled).toHaveLength(1);
            expect(await records()).toHaveLength(1);
        });

        it("still refuses the replay after the 15-minute claim window, and long after", async () => {
            const { post, scheduled, statusOf } = await setup(GITLAB_TRIGGER);
            const body = '{"n":1}';

            expect(await statusOf(body, gitlab())).toBe(200);

            for (const elapsed of [TRIGGER_CLAIM_TTL_MS + 1, 30 * 24 * 60 * 60 * 1000]) {
                vi.setSystemTime(NOW + elapsed);

                const replay = await post(body, gitlab());

                expect(await replay.json()).toMatchObject({ duplicate: true });
            }

            expect(scheduled).toHaveLength(1);
        });

        it("runs a delivery that shares the event id but not the body (recursive webhooks share one)", async () => {
            const { scheduled, statusOf } = await setup(GITLAB_TRIGGER);

            expect(await statusOf('{"object_kind":"push"}', gitlab())).toBe(200);
            expect(await statusOf('{"object_kind":"note"}', gitlab())).toBe(200);
            expect(scheduled).toHaveLength(2);
        });

        it("refuses a verified delivery with no delivery id, an empty one or an over-long one, charging nothing", async () => {
            const { scheduled, statusOf } = await setup(GITLAB_TRIGGER);

            expect(await statusOf("{}", { "x-gitlab-token": SECRET })).toBe(401);
            expect(await statusOf("{}", { "x-gitlab-event-uuid": " ".repeat(3), "x-gitlab-token": SECRET })).toBe(401);
            expect(await statusOf("{}", gitlab("a".repeat(129)))).toBe(401);
            expect(scheduled).toHaveLength(0);
            expect(rateLimit.charged).toBe(0);
            expect(await records()).toEqual([]);
        });

        it("checks the token before the delivery id, so a caller without the token learns nothing about it", async () => {
            const { post } = await setup(GITLAB_TRIGGER);
            const noId = await post("{}", { "x-gitlab-token": "not-the-secret" });
            const withId = await post("{}", { ...gitlab(), "x-gitlab-token": "not-the-secret" });
            const missingId = await post("{}", { "x-gitlab-token": SECRET });

            // The same answer with and without an id; only the right token reaches the id check.
            expect(noId.status).toBe(401);
            expect(await noId.json()).toEqual({ error: "Invalid signature" });
            expect(await withId.json()).toEqual({ error: "Invalid signature" });
            expect(await missingId.json()).toEqual({ error: "Missing or invalid delivery identifier" });
        });

        it("refuses a wrong or missing token even with a valid delivery id, and records nothing", async () => {
            const { scheduled, statusOf } = await setup(GITLAB_TRIGGER);

            expect(await statusOf("{}", { ...gitlab(), "x-gitlab-token": "not-the-secret" })).toBe(401);
            expect(await statusOf("{}", { "x-gitlab-event-uuid": UUID })).toBe(401);
            expect(scheduled).toHaveLength(0);
            expect(await records()).toEqual([]);
        });

        it("gives the record back when scheduling fails, so the sender's retry runs", async () => {
            const { scheduled, scheduler, statusOf } = await setup(GITLAB_TRIGGER);
            const body = '{"n":1}';

            scheduler.fail = true;
            expect(await statusOf(body, gitlab())).toBe(500);
            expect(await records()).toEqual([]);

            scheduler.fail = false;
            expect(await statusOf(body, gitlab())).toBe(200);
            expect(scheduled).toHaveLength(1);
        });

        it("gives the record back for a filtered delivery, so a redelivery after fixing the filters is evaluated again", async () => {
            const { scheduled, statusOf } = await setup({ ...GITLAB_TRIGGER, filters: [{ op: "equals", path: "object_kind", value: "push" }] });

            expect(await statusOf('{"object_kind":"note"}', gitlab())).toBe(202);
            expect(await records()).toEqual([]);
            expect(scheduled).toHaveLength(0);
        });

        it("passes the record to the execution instead of a claim", async () => {
            const { scheduled, statusOf } = await setup(GITLAB_TRIGGER);

            expect(await statusOf('{"n":1}', gitlab())).toBe(200);

            const args = scheduled[0] as { claim?: unknown; deliveryRecord?: string };

            expect(args.claim).toBeUndefined();
            expect(args.deliveryRecord).toEqual(expect.any(String));
        });

        it("refuses a request carrying another scheme's header", async () => {
            const { scheduled, statusOf } = await setup(GITLAB_TRIGGER);

            expect(await statusOf("{}", { ...gitlab(), "x-hub-signature-256": `sha256=${await hmacHex("{}")}` })).toBe(401);
            expect(scheduled).toHaveLength(0);
        });

        it("fails closed when the trigger has no secret", async () => {
            const { scheduled, statusOf } = await setup({ ...GITLAB_TRIGGER, webhookSecret: undefined });

            expect(await statusOf("{}", gitlab())).toBe(401);
            expect(scheduled).toHaveLength(0);
        });

        for (const scheme of ["native", "timestamped"] as const) {
            it(`does not make a ${scheme} trigger require or record a delivery id`, async () => {
                const { scheduled, statusOf } = await setup({ ...SIGNED_TRIGGER, webhookSignatureScheme: scheme });
                const headers = scheme === "native" ? { "x-hub-signature-256": `sha256=${await hmacHex("{}")}` } : await signedHeaders("{}");

                expect(await statusOf("{}", { ...headers, "x-gitlab-event-uuid": UUID })).toBe(200);
                expect(scheduled).toHaveLength(1);
                expect(await records()).toEqual([]);
            });
        }
    });
});
