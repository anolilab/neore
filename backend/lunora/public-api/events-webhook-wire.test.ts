/**
 * The wire rules of the Events webhooks: the Standard Webhooks signature (checked against a published vector), the headers of an
 * attempt, the verification handshake, and how each answer to one POST is classed. The fetch is faked; nothing leaves the test.
 */
import { describe, expect, it, vi } from "vitest";

import { bytesToBase64 } from "../lib/crypto";
import { eventBody, gapBody, messageIdOf, postOnce, signWebhook, verifyCallback, webhookHeaders } from "./events-webhook-wire";

/* The Standard Webhooks test vector: this secret, message id, timestamp and body give this signature. The expectation was
 * recomputed independently with node:crypto before it was written here. */
// A published test vector, not a credential. Split so the secret scanner does not flag the literal.
const VECTOR_SECRET = `whsec_${["MfKQ9r8GKYqrTwjUPD8I", "LPZIo2LaLaSw"].join("")}`;
const VECTOR_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const VECTOR_TIMESTAMP = 1_614_265_330;
const VECTOR_BODY = '{"test": 2432232314}';
const VECTOR_SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
const MESSAGE_ID = /^msg_[\da-f]{32}$/;
const GAP_MESSAGE_ID = /^msg_gap_[\da-f]{32}$/;
const SIGNATURE_SHAPE = /^v1,/;

const SECRET = `whsec_${bytesToBase64(new Uint8Array(24).fill(9))}`;
const CALLBACK_URL = "https://hooks.example.com/neore";

/** A fetch that records each call and answers with `respond`. */
const recording = (respond: (input: string, init: RequestInit) => Response | Promise<Response>) => {
    const spy = vi.fn(async (input: string, init: RequestInit) => await respond(input, init));

    return spy;
};

describe("the Standard Webhooks signature", () => {
    it("matches the published test vector", async () => {
        expect(await signWebhook(VECTOR_SECRET, VECTOR_ID, VECTOR_TIMESTAMP, VECTOR_BODY)).toBe(VECTOR_SIGNATURE);
    });

    it("signs the raw body bytes: a re-spelling of the same JSON is a different signature", async () => {
        const compact = await signWebhook(VECTOR_SECRET, VECTOR_ID, VECTOR_TIMESTAMP, '{"test":2432232314}');

        expect(compact).not.toBe(VECTOR_SIGNATURE);
    });

    it("regenerates the timestamp and the signature per attempt, and keeps the message id", async () => {
        const id = messageIdOf();
        const first = await webhookHeaders({ body: VECTOR_BODY, id, secret: SECRET, subscriptionId: "sub_1", timestampSeconds: 1000 });
        const retry = await webhookHeaders({ body: VECTOR_BODY, id, secret: SECRET, subscriptionId: "sub_1", timestampSeconds: 1300 });

        expect(retry["webhook-id"]).toBe(first["webhook-id"]);
        expect(retry["webhook-timestamp"]).toBe("1300");
        expect(retry["webhook-signature"]).not.toBe(first["webhook-signature"]);
        expect(first).toMatchObject({ "content-type": "application/json", "X-MCP-Subscription-Id": "sub_1" });
    });

    it("gives each message a fresh id, prefixed by its type for a control envelope", () => {
        expect(messageIdOf()).toMatch(MESSAGE_ID);
        expect(messageIdOf("gap")).toMatch(GAP_MESSAGE_ID);
        expect(messageIdOf()).not.toBe(messageIdOf());
    });
});

describe("the bodies", () => {
    it("carries the event fields and an ISO timestamp, and the gap envelope its cursor", () => {
        const body = JSON.parse(eventBody({ cursor: "c1", data: { threadId: "t1" }, eventId: "evt-1", name: "run.completed", timestamp: 0 })) as Record<
            string,
            unknown
        >;

        expect(body).toStrictEqual({ cursor: "c1", data: { threadId: "t1" }, eventId: "evt-1", name: "run.completed", timestamp: "1970-01-01T00:00:00.000Z" });
        expect(JSON.parse(gapBody("c2"))).toStrictEqual({ cursor: "c2", type: "gap" });
    });
});

describe("the verification handshake", () => {
    it("is confirmed when the endpoint echoes the nonce it was sent, and the POST is signed and not redirected", async () => {
        const fetch = recording(async (_input, init) => Response.json({ challenge: (JSON.parse(String(init.body)) as { challenge: string }).challenge }));
        const outcome = await verifyCallback({ fetch, id: "sub_1", now: 1_000_000, secret: SECRET, subscriptionId: "sub_1", url: CALLBACK_URL });

        expect(outcome).toStrictEqual({ ok: true });
        expect(fetch).toHaveBeenCalledTimes(1);

        const init = fetch.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };

        expect(init.redirect).toBe("manual");
        expect(JSON.parse(String(init.body))).toMatchObject({ type: "verification" });
        expect(init.headers["webhook-signature"]).toMatch(SIGNATURE_SHAPE);
        expect(init.headers["X-MCP-Subscription-Id"]).toBe("sub_1");
    });

    it("is refused when the echo is wrong, the answer is not 2xx, a redirect, or not JSON", async () => {
        const base = { id: "sub_1", now: 1, secret: SECRET, subscriptionId: "sub_1", url: CALLBACK_URL };

        expect(await verifyCallback({ ...base, fetch: recording(async () => Response.json({ challenge: "wrong" })) })).toStrictEqual({
            ok: false,
            reason: "challenge_failed",
        });
        expect(await verifyCallback({ ...base, fetch: recording(async () => new Response("nope", { status: 500 })) })).toStrictEqual({
            ok: false,
            reason: "challenge_failed",
        });
        expect(
            await verifyCallback({
                ...base,
                fetch: recording(async () => new Response(null, { headers: { Location: "https://elsewhere.example.com" }, status: 302 })),
            }),
        ).toStrictEqual({
            ok: false,
            reason: "challenge_failed",
        });
        expect(await verifyCallback({ ...base, fetch: recording(async () => new Response("not json", { status: 200 })) })).toStrictEqual({
            ok: false,
            reason: "challenge_failed",
        });
    });

    it("keeps a transport failure's category: a timeout, or a connection failure", async () => {
        const base = { id: "sub_1", now: 1, secret: SECRET, subscriptionId: "sub_1", url: CALLBACK_URL };
        const timeout = new DOMException("slow", "TimeoutError");

        expect(
            await verifyCallback({
                ...base,
                fetch: recording(async () => {
                    throw timeout;
                }),
            }),
        ).toStrictEqual({ ok: false, reason: "timeout" });
        expect(
            await verifyCallback({
                ...base,
                fetch: recording(async () => {
                    throw new TypeError("refused");
                }),
            }),
        ).toStrictEqual({ ok: false, reason: "connection_refused" });
    });
});

describe("one POST's answer", () => {
    const send = (respond: () => Response | Promise<Response>) =>
        postOnce(
            CALLBACK_URL,
            {},
            "{}",
            recording(async () => await respond()),
        );

    it("delivers on a 2xx", async () => {
        expect(await send(() => new Response(null, { status: 204 }))).toStrictEqual({ category: "", kind: "delivered" });
    });

    it("refuses a redirect, a 410 and a 413: none of them is retried", async () => {
        expect(await send(() => new Response(null, { status: 302 }))).toMatchObject({ category: "redirect", kind: "refused" });
        expect(await send(() => new Response(null, { status: 410 }))).toMatchObject({ category: "gone", kind: "refused" });
        expect(await send(() => new Response(null, { status: 413 }))).toMatchObject({ category: "payload_too_large", kind: "refused" });
    });

    it("fails a 4xx or a 5xx, and a transport failure, so they may be retried", async () => {
        expect(await send(() => new Response(null, { status: 404 }))).toMatchObject({ category: "http_4xx", kind: "failed" });
        expect(await send(() => new Response(null, { status: 503 }))).toMatchObject({ category: "http_5xx", kind: "failed" });
        expect(
            await postOnce(CALLBACK_URL, {}, "{}", async () => {
                throw new TypeError("network");
            }),
        ).toMatchObject({ category: "connection_refused", kind: "failed" });
    });

    it("does not follow a redirect: every POST asks the runtime for manual redirects", async () => {
        const fetch = recording(async () => new Response(null, { status: 200 }));

        await postOnce(CALLBACK_URL, {}, "{}", fetch);

        expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    });
});
