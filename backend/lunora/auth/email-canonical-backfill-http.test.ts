import { describe, expect, it, vi } from "vitest";

import type { EmailCanonicalCheckResult, EmailCanonicalFillResult } from "./email-canonical-backfill";
import { createEmailCanonicalBackfillHandler } from "./email-canonical-backfill-http";

const TOKEN = "admin-token-for-tests";
const HEX_SALT = /^[0-9a-f]{32}$/u;

const handlerWith = (options: { check?: EmailCanonicalCheckResult; fill?: EmailCanonicalFillResult; token?: string; underLimit?: boolean } = {}) => {
    const check = vi.fn(async (_input: { cursor?: string; salt: string }) => options.check ?? { status: "done" as const });
    const fill = vi.fn(
        async (_input: { checkedAt: number; cursor?: string }) =>
            options.fill ?? { conflicts: 0, cursor: "next", filled: 3, skipped: 0, status: "progress" as const },
    );
    const rateLimit = vi.fn(async () => (options.underLimit === false ? { ok: false, retryAfter: 90_000 } : { ok: true }));
    const handler = createEmailCanonicalBackfillHandler({ adminToken: () => options.token ?? TOKEN, check, fillBatch: fill, rateLimit });

    return { check, fill, handler, rateLimit };
};

const post = (authorization?: string, body?: unknown): Request =>
    new Request("https://backend.example.invalid/admin/backfill-email-canonical", {
        ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
        headers: authorization === undefined ? {} : { authorization },
        method: "POST",
    });

describe("POST /admin/backfill-email-canonical", () => {
    it("answers 401 without the admin token, and runs nothing", async () => {
        const { check, handler } = handlerWith();

        const responses = await Promise.all([handler(post()), handler(post("Bearer wrong")), handler(post(TOKEN))]);

        expect(responses.map((response) => response.status)).toStrictEqual([401, 401, 401]);
        expect(check).not.toHaveBeenCalled();
    });

    it("fails closed with 503 when LUNORA_ADMIN_TOKEN is unset", async () => {
        const { check, handler } = handlerWith({ token: "" });

        const response = await handler(post("Bearer "));

        expect(response.status).toBe(503);
        expect(check).not.toHaveBeenCalled();
    });

    it("charges the rate limit before the token check, and says when to come back", async () => {
        const { check, handler, rateLimit } = handlerWith({ underLimit: false });
        const response = await handler(post(`Bearer ${TOKEN}`));

        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("90");
        expect(rateLimit).toHaveBeenCalledOnce();
        expect(check).not.toHaveBeenCalled();
    });

    it("runs a check from the start, which never writes, for a call without a body", async () => {
        const { check, fill, handler } = handlerWith();
        const response = await handler(post(`Bearer ${TOKEN}`));

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toStrictEqual({ status: "done" });
        expect(check).toHaveBeenCalledWith({ cursor: undefined, salt: expect.stringMatching(HEX_SALT) });
        expect(fill).not.toHaveBeenCalled();
    });

    it("passes a check's cursor and salt, and a fill's cursor and start, through", async () => {
        const checking = { checkedAt: 5, cursor: "c2", digests: ["ab"], scanned: 1, status: "checking" as const, unfilled: 1 };
        const { check, fill, handler } = handlerWith({ check: checking });

        const checked = await handler(post(`Bearer ${TOKEN}`, { cursor: "c1", phase: "check", salt: "s" }));
        const filled = await handler(post(`Bearer ${TOKEN}`, { checkedAt: 5, cursor: "f1", phase: "fill" }));

        expect(await checked.json()).toStrictEqual(checking);
        expect(check).toHaveBeenCalledWith({ cursor: "c1", salt: "s" });
        expect(await filled.json()).toStrictEqual({ conflicts: 0, cursor: "next", filled: 3, skipped: 0, status: "progress" });
        expect(fill).toHaveBeenCalledWith({ checkedAt: 5, cursor: "f1" });
    });

    it("answers 400 to a call it cannot read, and runs nothing", async () => {
        const { check, fill, handler } = handlerWith();
        const bodies = [
            "{",
            { phase: "fill" },
            { phase: "check" },
            { checkedAt: "5", phase: "fill" },
            { cursor: 3, phase: "check", salt: "s" },
            { phase: "drop" },
        ];

        const responses = await Promise.all(bodies.map(async (body) => await handler(post(`Bearer ${TOKEN}`, body))));

        expect(responses.map((response) => response.status)).toStrictEqual(bodies.map(() => 400));
        expect(check).not.toHaveBeenCalled();
        expect(fill).not.toHaveBeenCalled();
    });

    it("answers 409 on a conflict", async () => {
        const { handler } = handlerWith({ fill: { conflicts: 2, filled: 0, skipped: 0, status: "conflict" } });
        const response = await handler(post(`Bearer ${TOKEN}`, { checkedAt: 5, phase: "fill" }));

        expect(response.status).toBe(409);
        expect(await response.json()).toStrictEqual({ conflicts: 2, filled: 0, skipped: 0, status: "conflict" });
    });
});
