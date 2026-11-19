/**
 * Follow state on a thread: the default is off, a person sets follow, unfollow
 * or mute on their own row, and only someone who can read the thread may touch
 * it. Share and accept defaults are the sharer's and invitee's rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import {
    deleteFollowRowsOfThread,
    deleteFollowRowsOfUserBatch,
    deleteThreadFollowRow,
    ensureThreadFollowDefault,
    getThreadFollow,
    setThreadFollow,
    setThreadFollowState,
} from "./functions";

const OWNER = "user-owner";
const GRANTEE = "user-grantee";
const STRANGER = "user-stranger";
// The same answer as for a thread that does not exist, so the id is no oracle.
const NOT_FOUND_PATTERN = /Thread not found or you do not have access/;

vi.mock("../../lib/crpc-auth-helpers", async (importOriginal) => {
    const sessionFrom = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { activeOrganization: null, id: context.auth.userId, userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("../../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

vi.mock("../../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let threadId: Id<"threads">;

const as = (userId: string) => harness.withIdentity({ userId });

const followRowsFor = async (userId: string) =>
    await harness.run(async (context: any) => {
        const { page } = await context.db.threadFollows.findMany({ where: { threadId, userId } });

        return page;
    });

beforeEach(async () => {
    harness = lunoraTest(schema as never);

    threadId = await harness.run(async (context: any) => {
        const id = await context.db.insert("threads", {
            mode: "text",
            model: "gpt-4o",
            status: "active",
            title: "Shared plan",
            userId: OWNER,
        });

        await context.db.insert("threadAccess", {
            grantedAt: 1,
            grantedBy: OWNER,
            ownerId: OWNER,
            permission: "write",
            threadId: id,
            userId: GRANTEE,
        });

        return id;
    });
});

describe("thread follow state", () => {
    it("is off for a person with no row", async () => {
        expect(await as(OWNER).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "off" });
    });

    it("sets follow, mute and unfollow on the caller's own row, one row only", async () => {
        await as(OWNER).mutation(setThreadFollow as never, { state: "on", threadId } as never);
        expect(await as(OWNER).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "on" });

        await as(OWNER).mutation(setThreadFollow as never, { state: "muted", threadId } as never);
        expect(await as(OWNER).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "muted" });

        await as(OWNER).mutation(setThreadFollow as never, { state: "off", threadId } as never);
        expect(await as(OWNER).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "off" });

        expect(await followRowsFor(OWNER)).toHaveLength(1);
    });

    it("lets a grantee with read access set their own state, not the owner's", async () => {
        await as(GRANTEE).mutation(setThreadFollow as never, { state: "on", threadId } as never);

        expect(await as(GRANTEE).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "on" });
        expect(await as(OWNER).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "off" });
    });

    it("refuses a person with no access to the thread, as if it did not exist", async () => {
        await expect(as(STRANGER).query(getThreadFollow as never, { threadId } as never)).rejects.toThrow(NOT_FOUND_PATTERN);
        await expect(as(STRANGER).mutation(setThreadFollow as never, { state: "on", threadId } as never)).rejects.toThrow(NOT_FOUND_PATTERN);

        expect(await followRowsFor(STRANGER)).toHaveLength(0);
    });

    it("the default write never overwrites a state the person already chose", async () => {
        await harness.run(async (context: any) => {
            await setThreadFollowState(context, { now: 1, state: "muted", threadId, userId: OWNER });
            await ensureThreadFollowDefault(context, { now: 2, state: "on", threadId, userId: OWNER });
        });

        expect(await as(OWNER).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "muted" });
    });

    it("writing the same person and thread twice leaves one row with the last state", async () => {
        await harness.run(async (context: any) => {
            await setThreadFollowState(context, { now: 1, state: "on", threadId, userId: OWNER });
            await setThreadFollowState(context, { now: 2, state: "muted", threadId, userId: OWNER });
        });

        const rows = await followRowsFor(OWNER);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ state: "muted", updatedAt: 2 });
    });

    it("the default write creates the row when there is none", async () => {
        await harness.run(async (context: any) => {
            await ensureThreadFollowDefault(context, { now: 1, state: "on", threadId, userId: OWNER });
        });

        expect(await as(OWNER).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "on" });
    });
});

describe("thread follow rows across people and threads", () => {
    it("an accepted default is still there when the menu reads it, and an explicit mute survives a later accept", async () => {
        await harness.run(async (context: any) => {
            await ensureThreadFollowDefault(context, { now: 1, state: "on", threadId, userId: GRANTEE });
        });
        expect(await as(GRANTEE).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "on" });

        await as(GRANTEE).mutation(setThreadFollow as never, { state: "muted", threadId } as never);
        await harness.run(async (context: any) => {
            await ensureThreadFollowDefault(context, { now: 2, state: "on", threadId, userId: GRANTEE });
        });

        expect(await as(GRANTEE).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "muted" });
        expect(await followRowsFor(GRANTEE)).toHaveLength(1);
    });

    it("deleting a person's follow row removes it", async () => {
        await harness.run(async (context: any) => {
            await setThreadFollowState(context, { now: 1, state: "on", threadId, userId: GRANTEE });
        });

        await harness.run(async (context: any) => {
            await deleteThreadFollowRow(context, { threadId, userId: GRANTEE });
        });

        expect(await followRowsFor(GRANTEE)).toHaveLength(0);
    });

    it("deleting a thread removes every follower's row, in batches", async () => {
        await harness.run(async (context: any) => {
            await setThreadFollowState(context, { now: 1, state: "on", threadId, userId: OWNER });
            await setThreadFollowState(context, { now: 1, state: "muted", threadId, userId: GRANTEE });
            await setThreadFollowState(context, { now: 1, state: "on", threadId, userId: STRANGER });
        });

        const done = await harness.run(async (context: any) => await deleteFollowRowsOfThread(context, threadId));

        expect(done).toBe(true);
        expect(await followRowsFor(GRANTEE)).toHaveLength(0);
        expect(await followRowsFor(OWNER)).toHaveLength(0);
    });

    it("erasing a person removes their rows on every thread they follow", async () => {
        const otherThreadId = await harness.run(
            async (context: any) => await context.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Other", userId: OWNER }),
        );

        await harness.run(async (context: any) => {
            await setThreadFollowState(context, { now: 1, state: "on", threadId, userId: GRANTEE });
            await setThreadFollowState(context, { now: 1, state: "muted", threadId: otherThreadId, userId: GRANTEE });
            await setThreadFollowState(context, { now: 1, state: "on", threadId, userId: OWNER });
        });

        let done = false;

        while (!done) {
            done = await harness.run(async (context: any) => await deleteFollowRowsOfUserBatch(context, GRANTEE));
        }

        expect(await followRowsFor(GRANTEE)).toHaveLength(0);
        expect(await followRowsFor(OWNER)).toHaveLength(1);
    });
});

/**
 * A `ctx` whose first `threadFollows.findFirst` misses, as a read does when another write for the same person and
 * thread inserts right after it; every insert goes through `insert` (the real one unless given).
 */
const racingContext = (context: any, insert?: (...arguments_: unknown[]) => Promise<unknown>) => {
    let missed = false;
    const insertErrors: unknown[] = [];
    const bound = (target: object, property: string | symbol) => {
        const value = Reflect.get(target, property) as unknown;

        return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
    };
    const threadFollows = new Proxy(context.db.threadFollows, {
        get: (target, property) => {
            if (property === "findFirst" && !missed) {
                missed = true;

                return async () => null;
            }

            return bound(target, property);
        },
    });
    const realInsert = bound(context.db, "insert") as (...arguments_: unknown[]) => Promise<unknown>;
    const db = new Proxy(context.db, {
        get: (target, property) => {
            if (property === "threadFollows") {
                return threadFollows;
            }

            if (property === "insert") {
                return async (...arguments_: unknown[]) => {
                    try {
                        return await (insert ?? realInsert)(...arguments_);
                    } catch (error) {
                        insertErrors.push(error);

                        throw error;
                    }
                };
            }

            return bound(target, property);
        },
    });

    return { context: { db }, insertErrors };
};

describe("thread follow writes that race", () => {
    beforeEach(async () => {
        await harness.run(async (context: any) => {
            await setThreadFollowState(context, { now: 1, state: "muted", threadId, userId: OWNER });
        });
    });

    it("a second row for one person and thread is refused by the unique index", async () => {
        await expect(
            harness.run(async (context: any) => await context.db.insert("threadFollows", { createdAt: 2, state: "on", threadId, updatedAt: 2, userId: OWNER })),
        ).rejects.toMatchObject({ kind: "unique" });
    });

    it("a set that loses the insert patches the row the other write made", async () => {
        const insertErrors = await harness.run(async (context: any) => {
            const racing = racingContext(context);

            await setThreadFollowState(racing.context as never, { now: 2, state: "on", threadId, userId: OWNER });

            return racing.insertErrors;
        });

        expect(insertErrors).toHaveLength(1);
        expect(insertErrors[0]).toMatchObject({ kind: "unique" });

        const rows = await followRowsFor(OWNER);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ state: "on", updatedAt: 2 });
    });

    it("a default that loses the insert leaves the row the other write made", async () => {
        const insertErrors = await harness.run(async (context: any) => {
            const racing = racingContext(context);

            await ensureThreadFollowDefault(racing.context as never, { now: 2, state: "on", threadId, userId: OWNER });

            return racing.insertErrors;
        });

        expect(insertErrors).toHaveLength(1);
        expect(insertErrors[0]).toMatchObject({ kind: "unique" });

        const rows = await followRowsFor(OWNER);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ state: "muted", updatedAt: 1 });
    });

    it("rethrows any other insert failure from both writes", async () => {
        const failure = Object.assign(new Error("optimistic concurrency conflict"), { kind: "occ" });
        const failing = async () => {
            throw failure;
        };

        await harness.run(async (context: any) => {
            await expect(setThreadFollowState(racingContext(context, failing).context as never, { now: 2, state: "on", threadId, userId: OWNER })).rejects.toBe(
                failure,
            );
            await expect(
                ensureThreadFollowDefault(racingContext(context, failing).context as never, { now: 2, state: "on", threadId, userId: OWNER }),
            ).rejects.toBe(failure);
        });

        expect(await followRowsFor(OWNER)).toMatchObject([{ state: "muted" }]);
    });
});

describe("the account export", () => {
    // Read from source: the export action needs storage and a workflow to run.
    it("counts the follow rows it read before the trigger history's budget", () => {
        const source = readFileSync(join(import.meta.dirname, "../../gdpr/steps.ts"), "utf8");

        expect(source.indexOf("const threadFollows = await collectAllThreadFollows(")).toBeLessThan(
            source.indexOf("const triggerReadBytes = triggerReadBudget("),
        );
        expect(source).toContain("+ readBytes(threadFollows)");
        expect(source).toContain("            threadFollows,\n");
    });
});
