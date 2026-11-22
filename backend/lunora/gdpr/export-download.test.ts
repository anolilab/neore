/**
 * An export is handed out as a SIGNED url (`ctx.storage.getUrl` is unsigned and nothing serves it), and a
 * generation failure maps to a fixed, user-safe message. An admin acting as the owner neither starts nor downloads one.
 */
import { lunoraTest } from "@lunora/testing";
import { LunoraError } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { getExportDownloadUrl, requestDataExport } from "./functions";
import { exportFailureMessage } from "./workflows/export-workflow";

const { registry, sessionFrom, signedReadUrl, state } = vi.hoisted(() => {
    const impersonation = { by: null as string | null };

    return {
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? {
                      activeOrganization: null,
                      id: context.auth.userId,
                      impersonatedBy: impersonation.by,
                      isAdmin: false,
                      plan: null,
                      role: null,
                      userId: context.auth.userId,
                  }
                : null,
        signedReadUrl: vi.fn(async (_storage: unknown, key: string, _ttlSeconds: number) => `https://files.example/${key}?sig=abc`),
        state: impersonation,
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

// The harness has no `ctx.storage`; the signer is the seam, and its arguments are what is under test.
vi.mock("../lib/storage-read", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/storage-read")>()), signedReadUrl };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

const USER = "user-1";
const KEY = "exports/user-1/export.json";

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "gdpr_functions", await import("./functions"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    state.by = null;
    signedReadUrl.mockClear();
    harness.close();
});

const insertCompletedExport = async (): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("gdprRequests", {
            requestedAt: Date.now(),
            requestType: "export",
            status: "completed",
            storageId: KEY,
            userEmail: "a@example.com",
            userId: USER,
        });
    });
};

const exportRequests = async (): Promise<unknown[]> => await harness.run(async (ctx: any) => await ctx.db.query("gdprRequests").collect());

describe("requestDataExport", () => {
    it("starts an export for the owner", async () => {
        await harness.withIdentity({ userId: USER } as never).mutation(requestDataExport as never, {} as never);

        expect(await exportRequests()).toHaveLength(1);
    });

    it("refuses an admin acting as the owner, and records no request", async () => {
        state.by = "admin-1";

        await expect(harness.withIdentity({ userId: USER } as never).mutation(requestDataExport as never, {} as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: "A data export cannot be requested while impersonating",
        });
        expect(await exportRequests()).toHaveLength(0);
    });
});

describe("getExportDownloadUrl", () => {
    it("refuses an admin acting as the owner, and signs no link", async () => {
        await insertCompletedExport();
        state.by = "admin-1";

        await expect(harness.withIdentity({ userId: USER } as never).action(getExportDownloadUrl as never, {} as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: "A data export cannot be downloaded while impersonating",
        });
        expect(signedReadUrl).not.toHaveBeenCalled();
    });

    it("returns a signed url for the stored export key", async () => {
        await insertCompletedExport();

        const result = (await harness.withIdentity({ userId: USER } as never).action(getExportDownloadUrl as never, {} as never)) as { url: string };

        expect(result.url).toContain("sig=");
        expect(signedReadUrl).toHaveBeenCalledWith(expect.anything(), KEY, 3600);
    });

    it("never signs a link that outlives the export's expiry", async () => {
        const expiresAt = Date.now() + 5 * 60_000;

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("gdprRequests", {
                expiresAt,
                requestedAt: Date.now(),
                requestType: "export",
                status: "completed",
                storageId: KEY,
                userEmail: "a@example.com",
                userId: USER,
            });
        });

        await harness.withIdentity({ userId: USER } as never).action(getExportDownloadUrl as never, {} as never);

        const ttl = signedReadUrl.mock.lastCall?.[2];

        expect(ttl).toBeLessThanOrEqual(300);
        expect(ttl).toBeGreaterThan(0);
    });
});

describe("exportFailureMessage", () => {
    it("names the size limit for PAYLOAD_TOO_LARGE", () => {
        expect(exportFailureMessage(new LunoraError("PAYLOAD_TOO_LARGE", "x"))).toContain("32 MB");
    });

    it("hides anything else behind a generic message", () => {
        expect(exportFailureMessage(new LunoraError("SERVICE_UNAVAILABLE", "r2 down"))).toBe("Failed to generate export file");
        expect(exportFailureMessage(new Error("secret detail"))).toBe("Failed to generate export file");
    });
});
