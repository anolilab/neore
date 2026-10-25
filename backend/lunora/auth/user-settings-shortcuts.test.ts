/**
 * The keyboard shortcuts a user saves come back on the next settings read, including the two
 * reasoning-effort commands (unbound by default) and a binding the user cleared.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getUserSettings, updateUserSettings } from "./functions";
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
const save = async (keyboardShortcuts: Record<string, string>) => await asUser().mutation(updateUserSettings as never, { keyboardShortcuts } as never);
const reload = async () => {
    const settings = (await asUser().query(getUserSettings as never, {} as never)) as { keyboardShortcuts?: Record<string, string> } | null;

    return settings?.keyboardShortcuts;
};

beforeEach(() => {
    harness = lunoraTest(schemaWithShardedTables([]) as never);
});

afterEach(() => {
    harness.close();
});

describe("saved keyboard shortcuts", () => {
    it("bring both effort bindings back on the next settings read", async () => {
        await save({ decreaseEffort: "ctrl+alt+arrowdown", increaseEffort: "ctrl+alt+arrowup" });

        expect(await reload()).toMatchObject({ decreaseEffort: "ctrl+alt+arrowdown", increaseEffort: "ctrl+alt+arrowup" });
    });

    it("keep a binding saved earlier when only the other effort command is rebound", async () => {
        await save({ decreaseEffort: "alt+arrowdown", increaseEffort: "alt+arrowup" });
        await save({ decreaseEffort: "alt+arrowdown", increaseEffort: "alt+shift+arrowup" });

        expect(await reload()).toMatchObject({ decreaseEffort: "alt+arrowdown", increaseEffort: "alt+shift+arrowup" });
    });

    it("read back a cleared effort binding as empty, which the app treats as unbound", async () => {
        await save({ decreaseEffort: "alt+arrowdown", increaseEffort: "alt+arrowup" });
        await save({ decreaseEffort: "alt+arrowdown", increaseEffort: "" });

        const shortcuts = await reload();

        expect(shortcuts?.increaseEffort).toBe("");
        expect(shortcuts?.decreaseEffort).toBe("alt+arrowdown");
    });

    it("save an effort binding next to the Help, Home and End defaults the settings form submits with it", async () => {
        await save({ firstItem: "home", help: "ctrl+/", increaseEffort: "alt+arrowup", lastItem: "end" });

        expect(await reload()).toMatchObject({ firstItem: "home", help: "ctrl+/", increaseEffort: "alt+arrowup", lastItem: "end" });
    });

    it("refuse a malformed effort binding and keep what was saved", async () => {
        await save({ increaseEffort: "alt+arrowup" });

        await expect(save({ increaseEffort: "ctrl+<script>" })).rejects.toThrow();

        expect(await reload()).toMatchObject({ increaseEffort: "alt+arrowup" });
    });
});
