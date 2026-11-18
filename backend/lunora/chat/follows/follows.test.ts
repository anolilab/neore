/**
 * Follow state on a thread: the default is off, a person sets follow, unfollow
 * or mute on their own row, and only someone who can read the thread may touch
 * it. Share and accept defaults are the sharer's and invitee's rows.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { ensureThreadFollowDefault, getThreadFollow, setThreadFollow, setThreadFollowState } from "./functions";

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
    await harness.run(
        async (context: any) =>
            await context.db
                .query("threadFollows")
                .withIndex("by_user_and_thread", (q: any) => q.eq("userId", userId).eq("threadId", threadId))
                .collect(),
    );

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

    it("the default write creates the row when there is none", async () => {
        await harness.run(async (context: any) => {
            await ensureThreadFollowDefault(context, { now: 1, state: "on", threadId, userId: OWNER });
        });

        expect(await as(OWNER).query(getThreadFollow as never, { threadId } as never)).toEqual({ state: "on" });
    });
});
