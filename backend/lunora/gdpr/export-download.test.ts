/**
 * An export is handed out as a SIGNED url (`ctx.storage.getUrl` is unsigned and nothing serves it), and a
 * generation failure maps to a fixed, user-safe message.
 */
import { lunoraTest } from "@lunora/testing";
import { LunoraError } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { getExportDownloadUrl } from "./functions";
import { exportFailureMessage } from "./workflows/export-workflow";

const { registry, sessionFrom, signedReadUrl } = vi.hoisted(() => {
    return {
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, plan: null, role: null, userId: context.auth.userId }
                : null,
        signedReadUrl: vi.fn(async (_storage: unknown, key: string, _ttlSeconds: number) => `https://files.example/${key}?sig=abc`),
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
    harness.close();
});

describe("getExportDownloadUrl", () => {
    it("returns a signed url for the stored export key", async () => {
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
