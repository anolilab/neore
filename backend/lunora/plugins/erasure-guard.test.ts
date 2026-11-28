/** The steps that create plugin rows refuse while the account is being erased, and the uninstall action refuses an organization session. */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { createInstallRow } from "./install-steps";
import { uninstallPlugin } from "./uninstall-action";

const sessionFrom = vi.hoisted(() => async (context: { auth: { userId?: string | null } }) => {
    const { userId } = context.auth;

    return userId ? { activeOrganization: "org-1", email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, plan: "premium", userId } : null;
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
        getSessionUserWithAnonymous: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

const OWNER = "owner-a";
const start = { contentHash: "b".repeat(64), pluginSlug: "daily-brief", userId: OWNER, version: "1.0.0" };

describe("plugin steps while the account is erased", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        const { loadAllFunctions } = await import("../_generated/functions");

        await loadAllFunctions();
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("refuses to create an install row once an erasure of the account is marked", async () => {
        await harness.run(async (context: any) => await context.db.insert("accountMoves", { createdAt: Date.now(), kind: "erasing", userId: OWNER }));

        await expect(harness.run(async (context: any) => await context.runMutation(createInstallRow, start))).rejects.toThrow("being deleted");
        const { page } = await harness.run(async (context: any) => await context.db.pluginInstalls.findMany({}));

        expect(page).toHaveLength(0);
    });

    it("creates it when no erasure is marked", async () => {
        const created = await harness.run(async (context: any) => await context.runMutation(createInstallRow, start));

        expect(created.installId).toBeTruthy();
    });
});

describe("uninstallPlugin in an organization session", () => {
    it("refuses before it touches anything", async () => {
        const { handler } = uninstallPlugin as unknown as { handler: (ctx: unknown, args: unknown) => Promise<unknown> };
        const runMutation = async () => {
            throw new Error("must not be reached");
        };

        await expect(handler({ auth: { userId: OWNER }, runMutation }, { pluginSlug: "daily-brief" })).rejects.toThrow("Organization plugin installs");
    });
});
