/**
 * The owner's unread / snooze / "needs you" state on a thread: who may write it, what clears it, and who may read it.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { patchThread } from "../agent/table-writes";
import { getThread, updateThread } from "../agent/threads";
import schema from "../schema";
import { isSnoozeInRange, SNOOZE_MAX_MS } from "./lib/thread-state-logic";
import { markThreadViewed, snoozeThread, unsnoozeThread } from "./thread-state";

const OWNER = "user-owner";
const GRANTEE = "user-grantee";
const STRANGER = "user-stranger";
const NOT_FOUND_PATTERN = /Thread not found/;
const DAY = 24 * 60 * 60 * 1000;

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const as = (userId: string) => harness.withIdentity({ userId });
const read = async (): Promise<any> => await harness.run(async (context: any) => await context.db.get(threadId));

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(
        async (context: any) =>
            await context.db.insert("threads", {
                awaitingInput: "approval",
                lastReplyAt: 2000,
                status: "active",
                title: "Shared",
                updatedAt: 111,
                userId: OWNER,
            }),
    );
});

describe("snooze range", () => {
    it("accepts a future time up to 366 days out and nothing else", () => {
        expect(isSnoozeInRange(1001, 1000)).toBe(true);
        expect(isSnoozeInRange(1000 + SNOOZE_MAX_MS, 1000)).toBe(true);
        expect(isSnoozeInRange(1000, 1000)).toBe(false);
        expect(isSnoozeInRange(500, 1000)).toBe(false);
        expect(isSnoozeInRange(1001 + SNOOZE_MAX_MS, 1000)).toBe(false);
        expect(isSnoozeInRange(NaN, 1000)).toBe(false);
    });
});

describe("awaitingInput leaves with the pause", () => {
    it("is removed by patchThread when the thread goes back to running, and kept for other writes", async () => {
        await harness.run(async (context: any) => {
            await patchThread(context.db, threadId as never, { updatedAt: 5 });
        });
        const rowAfter83 = await read();

        expect(rowAfter83.awaitingInput).toBe("approval");

        await harness.run(async (context: any) => {
            await patchThread(context.db, threadId as never, { status: "running", updatedAt: 6 });
        });

        const row = await read();

        expect(row.status).toBe("running");
        expect(row.updatedAt).toBe(6);
        expect(row.awaitingInput).toBeUndefined();
        expect(row.lastReplyAt).toBe(2000);
    });

    it("is removed by updateThread going to running, and set by a run that pauses", async () => {
        await harness.run(
            async (context: any) => await context.runMutation(updateThread as never, { patch: { status: "running", updatedAt: 7 }, threadId } as never),
        );
        const rowAfter100 = await read();

        expect(rowAfter100.awaitingInput).toBeUndefined();

        await harness.run(
            async (context: any) =>
                await context.runMutation(updateThread as never, { patch: { awaitingInput: "question", status: "active", updatedAt: 8 }, threadId } as never),
        );

        const row = await read();

        expect(row).toMatchObject({ awaitingInput: "question", status: "active" });
    });
});

describe("markThreadViewed", () => {
    it("stamps lastViewedAt for the owner without touching updatedAt, and only while a reply is unseen", async () => {
        const first: any = await as(OWNER).mutation(markThreadViewed as never, { threadId } as never);
        const viewed = await read();

        expect(first).toStrictEqual({ updated: true });
        expect(viewed.lastViewedAt).toBeGreaterThanOrEqual(2000);
        expect(viewed.updatedAt).toBe(111);

        const again: any = await as(OWNER).mutation(markThreadViewed as never, { threadId } as never);

        expect(again).toStrictEqual({ updated: false });
        const rowAfter126 = await read();

        expect(rowAfter126.lastViewedAt).toBe(viewed.lastViewedAt);
    });

    it("is a no-op for a thread that never replied", async () => {
        await harness.run(async (context: any) => {
            await context.db.replace(threadId, { status: "active", userId: OWNER });
        });

        expect(await as(OWNER).mutation(markThreadViewed as never, { threadId } as never)).toStrictEqual({ updated: false });
        const rowAfter136 = await read();

        expect(rowAfter136.lastViewedAt).toBeUndefined();
    });

    it("refuses anyone but the owner", async () => {
        await expect(as(STRANGER).mutation(markThreadViewed as never, { threadId } as never)).rejects.toThrow(NOT_FOUND_PATTERN);
        const rowAfter142 = await read();

        expect(rowAfter142.lastViewedAt).toBeUndefined();
    });
});

describe("snooze and unsnooze", () => {
    it("snoozes for the owner, then removes the column, leaving updatedAt alone", async () => {
        const until = Date.now() + DAY;

        await as(OWNER).mutation(snoozeThread as never, { threadId, until } as never);
        expect(await read()).toMatchObject({ snoozedUntil: until, updatedAt: 111 });

        await as(OWNER).mutation(unsnoozeThread as never, { threadId } as never);

        const row = await read();

        expect("snoozedUntil" in row).toBe(false);
        expect(row.updatedAt).toBe(111);
        // Removing it again is quiet.
        await as(OWNER).mutation(unsnoozeThread as never, { threadId } as never);
    });

    it("rejects a past time or one beyond 366 days, and any non-owner", async () => {
        await expect(as(OWNER).mutation(snoozeThread as never, { threadId, until: Date.now() - 1000 } as never)).rejects.toThrow();
        await expect(as(OWNER).mutation(snoozeThread as never, { threadId, until: Date.now() + 400 * DAY } as never)).rejects.toThrow();
        await expect(as(STRANGER).mutation(snoozeThread as never, { threadId, until: Date.now() + DAY } as never)).rejects.toThrow(NOT_FOUND_PATTERN);
        await expect(as(STRANGER).mutation(unsnoozeThread as never, { threadId } as never)).rejects.toThrow(NOT_FOUND_PATTERN);
        const rowAfter169 = await read();

        expect(rowAfter169.snoozedUntil).toBeUndefined();
    });
});

describe("who can read the state", () => {
    it("shows it to the owner and strips it for a grantee", async () => {
        await harness.run(async (context: any) => {
            await context.db.patch(threadId, { lastViewedAt: 3000, snoozedUntil: Date.now() + DAY });
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId, userId: GRANTEE });
        });

        const asOwner: any = await as(OWNER).query(getThread as never, { threadId } as never);
        const asGrantee: any = await as(GRANTEE).query(getThread as never, { threadId } as never);

        expect(asOwner).toMatchObject({ awaitingInput: "approval", lastReplyAt: 2000, lastViewedAt: 3000 });
        expect(asOwner.snoozedUntil).toBeDefined();
        expect(asGrantee).toMatchObject({ title: "Shared", userId: OWNER });

        for (const key of ["awaitingInput", "lastReplyAt", "lastViewedAt", "snoozedUntil"]) {
            expect(key in asGrantee).toBe(false);
        }
    });
});
