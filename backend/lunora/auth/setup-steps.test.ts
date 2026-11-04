/**
 * Skipping and resuming a first-run setup step is applied to the list as stored, one step per call.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getUserSettings, updateUserSettings } from "./functions";
import { setSetupStepSkipped } from "./setup-steps";
import { schemaWithShardedTables } from "../lib/test-schema";

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
        await asUser().mutation(updateUserSettings as never, { setupStepsSkipped: ["a", "b", "c", "d", "e", "f", "g", "h"] } as never);
        await toggle("ssh", true);

        expect(await stored()).toEqual(["b", "c", "d", "e", "f", "g", "h", "ssh"]);
    });

    it("refuses an unknown step", async () => {
        await expect(toggle("nope", true)).rejects.toThrow();
    });
});
