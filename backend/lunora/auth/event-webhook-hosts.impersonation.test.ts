/**
 * The owner's callback host list while an admin is impersonating the owner: the approve and remove mutations refuse, and
 * nothing is written. The session is a hand-built one carrying the impersonation mark; the mutations run on the real harness.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { addEventWebhookHost, listEventWebhookHosts, removeEventWebhookHost } from "./event-webhook-hosts";

const session = vi.hoisted(() => {
    return { current: undefined as unknown };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const fake = async () => session.current;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: fake,
        getSessionUserForQuery: fake,
        getSessionUserForQueryLite: fake,
        getSessionUserWithAnonymous: fake,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

const USER = "owner-1";

describe("the owner's callback hosts while impersonated", () => {
    beforeEach(() => {
        session.current = {
            email: "owner@example.com",
            image: null,
            impersonatedBy: "admin-1",
            isAdmin: false,
            name: "Owner",
            plan: "free",
            userId: USER,
        };
    });

    it("refuses to approve a host, and writes nothing", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const as = harness.withIdentity({ sessionId: "impersonated", userId: USER } as never);

            await expect(as.mutation(addEventWebhookHost as never, { host: "hooks.example.com" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
            expect(await as.query(listEventWebhookHosts as never, {} as never)).toStrictEqual({ hosts: [] });
        } finally {
            harness.close();
        }
    });

    it("refuses to remove a host that is approved", async () => {
        session.current = { ...(session.current as object), impersonatedBy: null };
        const harness = lunoraTest(schema as never);

        try {
            const owner = harness.withIdentity({ sessionId: "owner", userId: USER } as never);

            await owner.mutation(addEventWebhookHost as never, { host: "hooks.example.com" } as never);
            session.current = { ...(session.current as object), impersonatedBy: "admin-1" };

            await expect(owner.mutation(removeEventWebhookHost as never, { host: "hooks.example.com" } as never)).rejects.toMatchObject({
                code: "FORBIDDEN",
            });
            expect(await owner.query(listEventWebhookHosts as never, {} as never)).toStrictEqual({
                hosts: [{ createdAt: expect.any(Number), host: "hooks.example.com" }],
            });
        } finally {
            harness.close();
        }
    });
});
