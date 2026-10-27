/**
 * The backup model is checked against the model registry when it is saved, and "" clears it.
 */
import { lunoraTest } from "@lunora/testing";
import { MODEL_REGISTRY, requiresPaidPlan } from "@neore/ai/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPaidModelAccess, getUserSettings, updateUserSettings } from "./functions";
import { schemaWithShardedTables } from "../lib/test-schema";

const USER = "user-backup-model";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, userId } : null;
        },
    };
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

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

// `userSettings` is audited; its trigger writes a `.global()` table the harness cannot hold.
vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const asUser = () => harness.withIdentity({ userId: USER } as never);
const save = async (backupModel: string) => await asUser().mutation(updateUserSettings as never, { backupModel } as never);
const reload = async () => {
    const settings = (await asUser().query(getUserSettings as never, {} as never)) as { backupModel?: string } | null;

    return settings?.backupModel;
};

const BACKUP = MODEL_REGISTRY.find((m) => m.enabled !== false && m.provider !== "external" && (m.mode ?? "text") === "text" && !requiresPaidPlan(m))!.id;

beforeEach(() => {
    harness = lunoraTest(schemaWithShardedTables([]) as never);
});

afterEach(() => {
    harness.close();
});

describe("getPaidModelAccess", () => {
    it("is false for a user whose plan opens no paid model", async () => {
        const access = await asUser().query(getPaidModelAccess as never, {} as never);

        expect(access).toEqual({ canRunPaidModels: false });
    });
});

describe("saved backup model", () => {
    it("comes back on the next settings read", async () => {
        await save(BACKUP);

        expect(await reload()).toBe(BACKUP);
    });

    it("refuses an id the registry does not know and keeps the stored one", async () => {
        await save(BACKUP);

        await expect(save("no-such-model")).rejects.toThrow("backup");

        expect(await reload()).toBe(BACKUP);
    });

    it("refuses a model that is not a text model", async () => {
        const image = MODEL_REGISTRY.find((m) => m.mode === "image" && m.enabled !== false)!;

        await expect(save(image.id)).rejects.toThrow("backup");
    });

    it("refuses a paid-plan model for a user who cannot run it, with the run gate's refusal", async () => {
        const paid = MODEL_REGISTRY.find((m) => m.enabled !== false && m.provider !== "external" && (m.mode ?? "text") === "text" && requiresPaidPlan(m))!;

        await save(BACKUP);

        await expect(save(paid.id)).rejects.toThrow("needs a Pro plan");

        expect(await reload()).toBe(BACKUP);
    });

    it("is cleared by an empty string", async () => {
        await save(BACKUP);
        await save("");

        expect(await reload()).toBe("");
    });
});
