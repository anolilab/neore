/**
 * Schedule ideas are opt-in, and switching the setting off erases the suggestions waiting to be accepted: saving
 * `scheduleIdeasEnabled` as anything but `true` queues the erasure on the user's shard; switching it on or saving
 * another setting queues nothing, and the setting is absent until it is saved. Turning memory off (the ideas need it)
 * queues the same erasure in that save.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { updateUserSettings } from "./functions";
import { schemaWithShardedTables } from "../lib/test-schema";

const USER = "user-schedule-ideas";

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
const erasures = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("eraseUserTaskSuggestions") === true);
const storedSetting = async (): Promise<unknown> =>
    await harness.run(async (ctx: any) => {
        const [row] = await ctx.db.query("userSettings").collect();

        return row?.scheduleIdeasEnabled;
    });

beforeEach(() => {
    harness = lunoraTest(schemaWithShardedTables([]) as never);
});

afterEach(() => {
    harness.close();
});

describe("the schedule ideas setting", () => {
    it("is absent until it is saved, and a save of another setting leaves it absent and queues nothing", async () => {
        await save({ language: "de-DE" });

        expect(await storedSetting()).toBeUndefined();
        expect(erasures()).toHaveLength(0);
    });

    it("queues nothing when it is switched on, then the erasure of the user's suggestions when it is switched off", async () => {
        await save({ scheduleIdeasEnabled: true });

        expect(await storedSetting()).toBe(true);
        expect(erasures()).toHaveLength(0);

        await save({ scheduleIdeasEnabled: false });

        expect(await storedSetting()).toBe(false);
        expect(erasures()).toHaveLength(1);
        expect(JSON.stringify(erasures()[0])).toContain(USER);
        expect(JSON.stringify(erasures()[0])).toContain("before");
    });

    it("queues the erasure when memory is turned off, and not when memory is turned on", async () => {
        await save({ memoryEnabled: true });

        expect(erasures()).toHaveLength(0);

        await save({ memoryEnabled: false });

        expect(erasures()).toHaveLength(1);
        expect(JSON.stringify(erasures()[0])).toContain(USER);
    });
});
