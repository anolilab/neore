/**
 * The owner's default for new chats is set only from their own live web session. A still-valid token whose session row is gone
 * (an impersonation that ended, or an expired one) is refused, as are a session row that is not the owner's, an admin acting as
 * the owner, and a grant session. Other settings are not affected by the guard.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { updateUserSettings } from "./functions";

const OWNER = "user-owner";
const DAY_MS = 86_400_000;

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const state = vi.hoisted(() => {
    return { by: undefined as string | undefined };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const sessionFrom = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { activeOrganization: null, id: context.auth.userId, impersonatedBy: state.by, userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "auth_functions", await import("./functions"));
}, 30_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    state.by = undefined;
    harness.close();
});

/** Inserts a session row and returns its id, as a sign-in's `sessionId` names it. */
const insertSession = async (userId: string, expiresAt: number): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("session", {
                createdAt: 1,
                expiresAt,
                token: `token-${userId}-${expiresAt}`,
                updatedAt: 1,
                userId,
            }),
    );

const storedDefault = async (): Promise<string | undefined> =>
    await harness.run(async (ctx: any) => {
        const row = await ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q: any) => q.eq("userId", OWNER))
            .unique();

        return row?.defaultPermissionMode;
    });

describe("the owner's default for new chats is set only from their own live session", () => {
    it("a live web session of the owner's may set it", async () => {
        const sessionId = await insertSession(OWNER, Date.now() + DAY_MS);

        await harness.withIdentity({ sessionId, userId: OWNER }).mutation(updateUserSettings as never, { defaultPermissionMode: "supervised" } as never);

        expect(await storedDefault()).toBe("supervised");
    });

    it("a still-valid token whose impersonation session row is gone is refused", async () => {
        await expect(
            harness
                .withIdentity({ sessionId: "ended-session", userId: OWNER })
                .mutation(updateUserSettings as never, { defaultPermissionMode: "full" } as never),
        ).rejects.toThrow();

        expect(await storedDefault()).toBeUndefined();
    });

    it("a still-valid token whose session row has expired is refused", async () => {
        const sessionId = await insertSession(OWNER, Date.now() - 1);

        await expect(
            harness.withIdentity({ sessionId, userId: OWNER }).mutation(updateUserSettings as never, { defaultPermissionMode: "full" } as never),
        ).rejects.toThrow();

        expect(await storedDefault()).toBeUndefined();
    });

    it("a session row that is not the owner's is refused", async () => {
        const sessionId = await insertSession("user-stranger", Date.now() + DAY_MS);

        await expect(
            harness.withIdentity({ sessionId, userId: OWNER }).mutation(updateUserSettings as never, { defaultPermissionMode: "full" } as never),
        ).rejects.toThrow();

        expect(await storedDefault()).toBeUndefined();
    });

    it("an admin acting as the owner is refused, even with the owner's live session", async () => {
        const sessionId = await insertSession(OWNER, Date.now() + DAY_MS);

        state.by = "admin-1";

        await expect(
            harness.withIdentity({ sessionId, userId: OWNER }).mutation(updateUserSettings as never, { defaultPermissionMode: "full" } as never),
        ).rejects.toThrow();

        expect(await storedDefault()).toBeUndefined();
    });

    it("a grant session is refused", async () => {
        await expect(
            harness
                .withIdentity({ grantSessionId: "grant-1", userId: OWNER })
                .mutation(updateUserSettings as never, { defaultPermissionMode: "full" } as never),
        ).rejects.toThrow();

        expect(await storedDefault()).toBeUndefined();
    });

    it("a grant session cannot turn merged-chat archiving on, since that would archive the owner's chats", async () => {
        await expect(
            harness.withIdentity({ grantSessionId: "grant-1", userId: OWNER }).mutation(updateUserSettings as never, { autoArchiveMergedChats: true } as never),
        ).rejects.toThrow();

        const row = await harness.run(
            async (ctx: any) =>
                await ctx.db
                    .query("userSettings")
                    .withIndex("by_userId", (q: any) => q.eq("userId", OWNER))
                    .unique(),
        );

        expect(row?.autoArchiveMergedChats).toBeUndefined();
    });

    it("the guard does not block other settings from the ended-session token, and changes no default", async () => {
        // Resolves: the guard applies only when the default mode is sent.
        await harness
            .withIdentity({ sessionId: "ended-session", userId: OWNER })
            .mutation(updateUserSettings as never, { customInstructions: "Answer in German." } as never);

        expect(await storedDefault()).toBeUndefined();
    });
});
