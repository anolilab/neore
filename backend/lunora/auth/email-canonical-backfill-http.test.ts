import { describe, expect, it, vi } from "vitest";

import type { EmailCanonicalBackfillResult } from "./email-canonical-backfill";
import { createEmailCanonicalBackfillHandler } from "./email-canonical-backfill-http";

const TOKEN = "admin-token-for-tests";

const handlerWith = (options: { result?: EmailCanonicalBackfillResult; token?: string; underLimit?: boolean } = {}) => {
    const backfill = vi.fn(async () => options.result ?? { conflicts: 0, filled: 3, remaining: 2, status: "progress" as const });
    const rateLimit = vi.fn(async () => (options.underLimit === false ? { ok: false, retryAfter: 90_000 } : { ok: true }));
    const handler = createEmailCanonicalBackfillHandler({ adminToken: () => options.token ?? TOKEN, backfill, rateLimit });

    return { backfill, handler, rateLimit };
};

const post = (authorization?: string): Request =>
    new Request("https://backend.example.invalid/admin/backfill-email-canonical", {
        headers: authorization === undefined ? {} : { authorization },
        method: "POST",
    });

describe("POST /admin/backfill-email-canonical", () => {
    it("answers 401 without the admin token, and runs nothing", async () => {
        const { backfill, handler } = handlerWith();

        const responses = await Promise.all([handler(post()), handler(post("Bearer wrong")), handler(post(TOKEN))]);

        expect(responses.map((response) => response.status)).toStrictEqual([401, 401, 401]);
        expect(backfill).not.toHaveBeenCalled();
    });

    it("fails closed with 503 when LUNORA_ADMIN_TOKEN is unset", async () => {
        const { backfill, handler } = handlerWith({ token: "" });

        const response = await handler(post("Bearer "));

        expect(response.status).toBe(503);
        expect(backfill).not.toHaveBeenCalled();
    });

    it("charges the rate limit before the token check, and says when to come back", async () => {
        const { backfill, handler, rateLimit } = handlerWith({ underLimit: false });
        const response = await handler(post(`Bearer ${TOKEN}`));

        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("90");
        expect(rateLimit).toHaveBeenCalledOnce();
        expect(backfill).not.toHaveBeenCalled();
    });

    it("answers one batch's counts, and nothing else", async () => {
        const { handler } = handlerWith();
        const response = await handler(post(`Bearer ${TOKEN}`));

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toStrictEqual({ conflicts: 0, filled: 3, remaining: 2, status: "progress" });
    });

    it("answers 409 on a conflict", async () => {
        const { handler } = handlerWith({ result: { conflicts: 2, filled: 0, remaining: 9, status: "conflict" } });
        const response = await handler(post(`Bearer ${TOKEN}`));

        expect(response.status).toBe(409);
        expect(await response.json()).toStrictEqual({ conflicts: 2, filled: 0, remaining: 9, status: "conflict" });
    });
});
