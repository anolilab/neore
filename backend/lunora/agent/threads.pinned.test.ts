/**
 * A pinned thread that was never trashed has no `deleted` column at all: only
 * `restoreThread` writes `deleted: false`. The pinned reads must take an unset
 * column as "not deleted", or a freshly pinned thread never lists.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { getThreadListData } from "../chat/composite";
import { listPinnedThreads } from "./threads";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const OWNER = "user-owner";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const seed = async () =>
    await harness.run(async (context: any) => {
        const thread = { model: "m", status: "active", userId: OWNER };
        // Never trashed: no `deleted` field, as `createThread` writes it.
        const fresh = await context.db.insert("threads", { ...thread, pinnedAt: 2, title: "fresh" });
        const restored = await context.db.insert("threads", { ...thread, deleted: false, pinnedAt: 1, title: "restored" });

        await context.db.insert("threads", { ...thread, deleted: true, pinnedAt: 3, title: "trashed" });

        return { fresh, restored };
    });

describe("pinned threads", () => {
    it("lists a pinned thread whose deleted column was never written", async () => {
        const { fresh, restored } = await seed();
        const as = harness.withIdentity({ userId: OWNER } as never);

        const listData = (await as.query(getThreadListData as never, {} as never)) as any;

        expect(listData.pinnedThreads.map((thread: any) => thread._id)).toEqual([restored, fresh]);

        const pinned = (await as.query(listPinnedThreads as never, { userId: OWNER } as never)) as any[];

        expect(pinned.map((thread) => thread._id)).toEqual([restored, fresh]);
    });
});
