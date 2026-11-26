import { describe, expect, it, vi } from "vitest";

import type { Id } from "../_generated/dataModel";
import type { EmailCanonicalCheckResult, EmailCanonicalFillResult } from "./email-canonical-backfill";
import { createEmailCanonicalBackfillHandler } from "./email-canonical-backfill-http";

const TOKEN = "admin-token-for-tests";
const CHECK_TOKEN = "check-token-for-tests";

const handlerWith = (options: { check?: EmailCanonicalCheckResult; fill?: EmailCanonicalFillResult; token?: string; underLimit?: boolean } = {}) => {
    const check = vi.fn(async (_input: { token?: string }) => options.check ?? { status: "done" as const });
    const fill = vi.fn(
        async (_input: { ids: string[]; token: string }) => options.fill ?? { conflicts: 0, filled: 1, processed: 1, skipped: 0, status: "progress" as const },
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

    it("starts a check, which never writes, for a call without a body", async () => {
        const { check, fill, handler } = handlerWith();
        const response = await handler(post(`Bearer ${TOKEN}`));

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toStrictEqual({ status: "done" });
        expect(check).toHaveBeenCalledWith({});
        expect(fill).not.toHaveBeenCalled();
    });

    it("passes a check's token, and a fill's token and ids, through", async () => {
        const checking = { scanned: 1, status: "checking" as const, token: CHECK_TOKEN, unfilledIds: ["u1" as Id<"user">] };
        const { check, fill, handler } = handlerWith({ check: checking });

        const started = await handler(post(`Bearer ${TOKEN}`, { phase: "check" }));
        const checked = await handler(post(`Bearer ${TOKEN}`, { phase: "check", token: CHECK_TOKEN }));
        const filled = await handler(post(`Bearer ${TOKEN}`, { ids: ["u1"], phase: "fill", token: CHECK_TOKEN }));

        expect(await started.json()).toStrictEqual(checking);
        expect(await checked.json()).toStrictEqual(checking);
        expect(check.mock.calls).toStrictEqual([[{}], [{ token: CHECK_TOKEN }]]);
        expect(await filled.json()).toStrictEqual({ conflicts: 0, filled: 1, processed: 1, skipped: 0, status: "progress" });
        expect(fill).toHaveBeenCalledWith({ ids: ["u1"], token: CHECK_TOKEN });
    });

    it("refuses a fill that names its own check time or cursor, so only the server's check binds it", async () => {
        const { check, fill, handler } = handlerWith();
        const bodies = [
            { checkedAt: 5, ids: ["u1"], phase: "fill" },
            { checkedAt: 5, ids: ["u1"], phase: "fill", token: CHECK_TOKEN },
            { cursor: "c", ids: ["u1"], phase: "fill", token: CHECK_TOKEN },
            { cursor: "c", phase: "check", token: CHECK_TOKEN },
            { phase: "check", salt: "s" },
        ];

        const responses = await Promise.all(bodies.map(async (body) => await handler(post(`Bearer ${TOKEN}`, body))));

        expect(responses.map((response) => response.status)).toStrictEqual(bodies.map(() => 400));
        expect(check).not.toHaveBeenCalled();
        expect(fill).not.toHaveBeenCalled();
    });

    it("answers 400 to a call it cannot read, and runs nothing", async () => {
        const { check, fill, handler } = handlerWith();
        const bodies = [
            "{",
            "[]",
            { phase: "fill" },
            { ids: ["u1"], phase: "fill" },
            { phase: "fill", token: CHECK_TOKEN },
            { ids: ["u1", "u2"], phase: "fill", token: CHECK_TOKEN },
            { ids: [7], phase: "fill", token: CHECK_TOKEN },
            { ids: ["u1"], phase: "fill", token: "t".repeat(129) },
            { phase: "check", token: 3 },
            { phase: "check", token: "" },
            { phase: "drop" },
        ];

        const responses = await Promise.all(bodies.map(async (body) => await handler(post(`Bearer ${TOKEN}`, body))));

        expect(responses.map((response) => response.status)).toStrictEqual(bodies.map(() => 400));
        expect(check).not.toHaveBeenCalled();
        expect(fill).not.toHaveBeenCalled();
    });

    it("answers 409 on a conflict", async () => {
        const { handler } = handlerWith({ fill: { conflicts: 2, filled: 0, processed: 0, skipped: 0, status: "conflict" } });
        const response = await handler(post(`Bearer ${TOKEN}`, { ids: ["u1"], phase: "fill", token: CHECK_TOKEN }));

        expect(response.status).toBe(409);
        expect(await response.json()).toStrictEqual({ conflicts: 2, filled: 0, processed: 0, skipped: 0, status: "conflict" });
    });
});
