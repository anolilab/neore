/**
 * The owner's unread / snooze / "needs you" state on a thread: who may write it, what clears it, and who may read it.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { timeoutStream } from "../agent/streams";
import { patchThread } from "../agent/table-writes";
import { getThread, updateThread } from "../agent/threads";
import schema from "../schema";
import { isSnoozeInRange, SNOOZE_MAX_MS } from "./lib/thread-state-logic";
import { releaseThread } from "./streaming/persistent/host";
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
const read = async (): Promise<any> => await harness.run(async (context: any) => await context.db.get("threads", threadId));

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

describe("a snoozed thread wakes early", () => {
    const SNOOZED_UNTIL = 9_000_000_000_000;

    const insertSnoozed = async (): Promise<string> =>
        await harness.run(
            async (context: any) =>
                await context.db.insert("threads", {
                    lastReplyAt: 2000,
                    snoozedUntil: SNOOZED_UNTIL,
                    status: "active",
                    title: "Snoozed",
                    updatedAt: 111,
                    userId: OWNER,
                }),
        );

    const readThread = async (id: string): Promise<any> => await harness.run(async (context: any) => await context.db.get("threads", id as never));

    it("un-snoozes on a pending approval, in the same write that records it", async () => {
        const id = await insertSnoozed();

        await harness.run(async (context: any) => {
            await patchThread(context.db, id as never, { awaitingInput: "approval", status: "active", updatedAt: 9 });
        });

        const row = await readThread(id);

        expect(row).toMatchObject({ awaitingInput: "approval", status: "active" });
        expect(row.snoozedUntil).toBeUndefined();
    });

    it("un-snoozes on a question through updateThread, the path a run's pause takes", async () => {
        const id = await insertSnoozed();

        await harness.run(
            async (context: any) =>
                await context.runMutation(
                    updateThread as never,
                    { patch: { awaitingInput: "question", status: "active", updatedAt: 9 }, threadId: id } as never,
                ),
        );

        const row = await readThread(id);

        expect(row.awaitingInput).toBe("question");
        expect(row.snoozedUntil).toBeUndefined();
    });

    it("un-snoozes on a failed run", async () => {
        const id = await insertSnoozed();

        await harness.run(async (context: any) => {
            await patchThread(context.db, id as never, { status: "error", updatedAt: 9 });
        });

        const row = await readThread(id);

        expect(row.status).toBe("error");
        expect(row.snoozedUntil).toBeUndefined();
    });

    it("un-snoozes when a run fails in place, even when the thread goes back to active", async () => {
        const id = await insertSnoozed();

        await harness.run(
            async (context: any) =>
                await context.runMutation(updateThread as never, { failed: true, patch: { status: "active", updatedAt: 9 }, threadId: id } as never),
        );

        const row = await readThread(id);

        expect(row.snoozedUntil).toBeUndefined();
    });

    it("un-snoozes when a host turn fails, and keeps the snooze when the owner stopped it", async () => {
        const insertRunning = async (): Promise<string> =>
            await harness.run(
                async (context: any) =>
                    await context.db.insert("threads", {
                        snoozedUntil: SNOOZED_UNTIL,
                        status: "running",
                        title: "Host",
                        updatedAt: 111,
                        userId: OWNER,
                    }),
            );
        const failed = await insertRunning();
        const stopped = await insertRunning();

        await harness.run(async (context: any) => {
            await releaseThread(context, failed as never, 10, { failed: true });
        });
        await harness.run(async (context: any) => {
            await releaseThread(context, stopped as never, 10);
        });

        const failedRow = await readThread(failed);
        const stoppedRow = await readThread(stopped);

        expect(failedRow.snoozedUntil).toBeUndefined();
        expect(stoppedRow).toMatchObject({ snoozedUntil: SNOOZED_UNTIL, status: "active" });
    });

    it("un-snoozes when a stream fails while another stream of the thread still runs", async () => {
        const id = await insertSnoozed();
        const streaming = (order: number): Record<string, unknown> => {
            return { order, state: { kind: "streaming", lastHeartbeat: 1 }, stateKind: "streaming", stepOrder: 0, threadId: id };
        };
        const failing = await harness.run(async (context: any) => await context.db.insert("streamingMessages", streaming(1)));

        await harness.run(async (context: any) => await context.db.insert("streamingMessages", streaming(2)));
        await harness.run(async (context: any) => await context.runMutation(timeoutStream as never, { streamId: failing } as never));

        const row = await readThread(id);

        expect(row.status).toBe("active");
        expect(row.snoozedUntil).toBeUndefined();
    });

    it("stays snoozed for an ordinary write", async () => {
        const id = await insertSnoozed();

        await harness.run(async (context: any) => {
            await patchThread(context.db, id as never, { updatedAt: 9 });
        });

        const row = await readThread(id);

        expect(row.snoozedUntil).toBe(SNOOZED_UNTIL);
    });

    it("stays snoozed for a finished reply", async () => {
        const id = await insertSnoozed();

        await harness.run(async (context: any) => {
            await patchThread(context.db, id as never, { lastReplyAt: 3000, status: "active", updatedAt: 9 });
        });

        const row = await readThread(id);

        expect(row.snoozedUntil).toBe(SNOOZED_UNTIL);
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
            await context.db.replace("threads", threadId, { status: "active", userId: OWNER });
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
            await context.db.patch("threads", threadId, { lastViewedAt: 3000, snoozedUntil: Date.now() + DAY });
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
