/**
 * One attempt at one delivery: the callback host is checked again at send time, and a host that now resolves to a private address
 * is refused without a request. The resolver and the fetch are injected.
 */
import { describe, expect, it, vi } from "vitest";

import { bytesToBase64 } from "../lib/crypto";
import { attemptDelivery } from "./events-webhook-send";

const SECRET = `whsec_${bytesToBase64(new Uint8Array(24).fill(9))}`;
const CALLBACK_URL = "https://hooks.example.com/neore";
const SIGNATURE_SHAPE = /^v1,/;

const attempt = (
    resolve: "private" | "public" | "unresolved",
    fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response(null, { status: 200 })),
) =>
    attemptDelivery({
        body: "{}",
        deps: { fetch, resolve: async () => resolve },
        host: "hooks.example.com",
        id: "msg_1",
        now: 1_000_000,
        secret: SECRET,
        subscriptionId: "sub_1",
        url: CALLBACK_URL,
    }).then((outcome) => {
        return { fetch, outcome };
    });

describe("attemptDelivery", () => {
    it("refuses a host that now resolves to a private address, and makes no request", async () => {
        const { fetch, outcome } = await attempt("private");

        expect(outcome).toStrictEqual({ category: "address_not_public", kind: "refused" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("fails, retryably, when the host has no address, and makes no request", async () => {
        const { fetch, outcome } = await attempt("unresolved");

        expect(outcome).toMatchObject({ kind: "failed" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("POSTs a public host once, signed, without following a redirect", async () => {
        const { fetch, outcome } = await attempt("public");

        expect(outcome).toStrictEqual({ category: "", kind: "delivered" });
        expect(fetch).toHaveBeenCalledTimes(1);

        const init = fetch.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };

        expect(init.redirect).toBe("manual");
        expect(init.headers["webhook-id"]).toBe("msg_1");
        expect(init.headers["webhook-signature"]).toMatch(SIGNATURE_SHAPE);
        expect(init.headers["webhook-timestamp"]).toBe("1000");
    });
});
