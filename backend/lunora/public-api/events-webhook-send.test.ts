/**
 * One attempt at one delivery: one signed POST through the callback request, classed by its answer. The address check is the
 * request's (`requestCheckedHttps` checks it at connect time), so these tests fake the request and check what it is given.
 */
import { describe, expect, it, vi } from "vitest";

import { bytesToBase64 } from "../lib/crypto";
import { EgressError } from "../lib/egress";
import { attemptDelivery } from "./events-webhook-send";
import type { CallbackRequest } from "./events-webhook-wire";

const SECRET = `whsec_${bytesToBase64(new Uint8Array(24).fill(9))}`;
const CALLBACK_URL = "https://hooks.example.com/neore";
const SIGNATURE_SHAPE = /^v1,/;

const attempt = (request: CallbackRequest) =>
    attemptDelivery({
        body: "{}",
        id: "msg_1",
        now: 1_000_000,
        request,
        secret: SECRET,
        subscriptionId: "sub_1",
        url: CALLBACK_URL,
    });

describe("attemptDelivery", () => {
    it("refuses a callback whose address is not public, and records no delivery", async () => {
        const request = vi.fn<CallbackRequest>(async () => {
            throw new EgressError("blocked_address", "The host name resolves to a private or reserved address.");
        });

        expect(await attempt(request)).toStrictEqual({ category: "address_not_public", kind: "refused" });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("fails, retryably, when the host has no address", async () => {
        const request = vi.fn<CallbackRequest>(async () => {
            throw new EgressError("dns_failed", "The host name has no address.");
        });

        expect(await attempt(request)).toMatchObject({ category: "connection_refused", kind: "failed" });
    });

    it("POSTs once with the signed headers, and classes a 2xx as delivered", async () => {
        const request = vi.fn<CallbackRequest>(async () => {
            return { body: "", status: 200 };
        });

        expect(await attempt(request)).toStrictEqual({ category: "", kind: "delivered" });
        expect(request).toHaveBeenCalledTimes(1);

        const [url, input] = request.mock.calls[0] ?? [];

        expect(url).toBe(CALLBACK_URL);
        expect(input?.headers["webhook-id"]).toBe("msg_1");
        expect(input?.headers["webhook-signature"]).toMatch(SIGNATURE_SHAPE);
        expect(input?.headers["webhook-timestamp"]).toBe("1000");
    });
});
