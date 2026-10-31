/**
 * Context summaries are opt-in, and switching the setting off erases what was made: saving
 * `threadSummariesEnabled` as anything but `true` queues the erasure on the user's shard; switching it on
 * or saving another setting queues nothing.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { updateUserSettings } from "./functions";
import { schemaWithShardedTables } from "../lib/test-schema";

const USER = "user-shortcuts";

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
const save = async (fields: Record<string, unknown>) => await asUser().mutation(updateUserSettings as never, fields as never);
const erasures = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("eraseUserThreadSummaries") === true);

beforeEach(() => {
    harness = lunoraTest(schemaWithShardedTables([]) as never);
});

afterEach(() => {
    harness.close();
});

describe("the thread summaries setting", () => {
    it("queues the erasure of the user's summaries when it is switched off", async () => {
        await save({ threadSummariesEnabled: true });

        expect(erasures()).toHaveLength(0);

        await save({ threadSummariesEnabled: false });

        expect(erasures()).toHaveLength(1);
        expect(JSON.stringify(erasures()[0])).toContain(USER);
    });

    it("queues nothing for a save that does not touch it", async () => {
        await save({ language: "de-DE" });

        expect(erasures()).toHaveLength(0);
    });
});
