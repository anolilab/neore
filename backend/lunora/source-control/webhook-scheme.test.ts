/** A host whose driver declares no webhook scheme has no webhook: nothing is issued and a delivery is a 404. */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { githubDriver } from "./drivers/github";
import { enableWatchWebhook } from "./freshness";
import { handleWatchWebhook } from "./webhook";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("./develop-driver", async () => {
    const { githubDriver: github } = await import("./drivers/github");

    return { DEVELOP_DRIVER: { ...github, webhookScheme: null } };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("a driver without a webhook scheme", () => {
    it("issues no secret", async () => {
        expect(githubDriver.webhookScheme).toBe("native"); // the real driver does; the mock above removes it

        const row = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("watchedRepositories", {
                    checkedAt: 0,
                    createdAt: 1,
                    dirtyAt: 0,
                    etag: null,
                    hostOrigin: "https://github.com",
                    lastStatus: "ok",
                    leasedAt: 0,
                    login: null,
                    nextPollAt: 1,
                    repository: "octo/hello",
                    requested: [],
                    seeded: false,
                    userId: "user-a",
                    webhookSeenAt: 0,
                }),
        );
        const issued = await harness.withIdentity({ userId: "user-a" }).mutation(enableWatchWebhook as never, { repository: "octo/hello" } as never);

        expect(issued).toEqual({ status: "unsupported" });
        const stored = await harness.run(async (ctx: any) => await ctx.db.get(row));

        expect(stored.webhookSecret).toBeUndefined();
    });

    it("answers a delivery with a 404 before it reads anything", async () => {
        const context = {
            runMutation: async () => {
                throw new Error("nothing is written");
            },
            runQuery: async () => {
                throw new Error("nothing is read");
            },
        };
        const response = await handleWatchWebhook(
            context as never,
            new Request("https://x/source-control/webhook/w", { body: "{}", headers: { "x-hub-signature-256": `sha256=${"a".repeat(64)}` }, method: "POST" }),
            "w",
        );

        expect(response.status).toBe(404);
    });
});
