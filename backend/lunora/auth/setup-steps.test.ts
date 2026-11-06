/**
 * Skipping and resuming a first-run setup step is applied to the list as stored, one step per call.
 */
import { v } from "lunorash/server";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { userSettingsFields } from "./fields";
import { getUserSettings, updateUserSettings } from "./functions";
import { MAX_SKIPPED_SETUP_STEPS } from "./lib/setup-step-limits";
import { applyStepSkip, setSetupStepSkipped } from "./setup-steps";
import { schemaWithShardedTables } from "../lib/test-schema";
import { validate } from "../lib/validators";

const USER = "user-setup-steps";

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
const toggle = async (stepId: string, skipped: boolean) => await asUser().mutation(setSetupStepSkipped as never, { skipped, stepId } as never);
const stored = async () => ((await asUser().query(getUserSettings as never, {} as never)) as { setupStepsSkipped?: string[] } | null)?.setupStepsSkipped;

beforeEach(() => {
    harness = lunoraTest(schemaWithShardedTables([]) as never);
});

afterEach(() => {
    harness.close();
});

describe("setSetupStepSkipped", () => {
    it("keeps both steps when two writes start from the same empty state", async () => {
        await Promise.all([toggle("ssh", true), toggle("agent", true)]);

        expect([...((await stored()) ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(["agent", "ssh"]);
    });

    it("resumes one step without touching the others, and skipping twice stores it once", async () => {
        await toggle("pair", true);
        await toggle("ssh", true);
        await toggle("ssh", true);
        await toggle("pair", false);

        expect(await stored()).toEqual(["ssh"]);
    });

    it("never stores more than eight entries: a ninth drops the oldest", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("userSettings", { setupStepsSkipped: ["a", "b", "c", "d", "e", "f", "g", "h"], userId: USER });
        });
        await toggle("ssh", true);

        expect(await stored()).toEqual(["b", "c", "d", "e", "f", "g", "h", "ssh"]);
    });

    it("shares one limit between the column validator and the skip", () => {
        const settings = v.object(userSettingsFields);
        const ids = Array.from({ length: MAX_SKIPPED_SETUP_STEPS + 1 }, (_, index) => `id${index}`);

        expect(validate(settings, { setupStepsSkipped: ids.slice(0, MAX_SKIPPED_SETUP_STEPS), userId: USER })).toBe(true);
        expect(validate(settings, { setupStepsSkipped: ids, userId: USER })).toBe(false);
        expect(applyStepSkip(ids.slice(0, MAX_SKIPPED_SETUP_STEPS), "ssh", true)).toHaveLength(MAX_SKIPPED_SETUP_STEPS);
    });

    it("cannot be set or erased through the generic settings update", async () => {
        await toggle("ssh", true);
        await asUser().mutation(updateUserSettings as never, { language: "de-DE", setupStepsSkipped: [] } as never);

        expect(await stored()).toEqual(["ssh"]);

        await asUser().mutation(updateUserSettings as never, { setupStepsSkipped: ["pair"] } as never);

        expect(await stored()).toEqual(["ssh"]);
    });

    it("refuses an unknown step", async () => {
        await expect(toggle("nope", true)).rejects.toThrow();
    });
});
