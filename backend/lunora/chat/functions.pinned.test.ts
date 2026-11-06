/**
 * The thread reads that answer owners' rows (`getPinnedThreads`, `getThreadOrders`, the thread list) answer every thread whole: the
 * owner's row carries fields a hand-listed output did not declare (its permission mode among them), and the output check must not
 * refuse the read for them.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { getPinnedThreads, getThreadOrders, getThreads } from "./functions";

const OWNER = "user-owner";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "chat_functions", await import("./functions"));
}, 30_000);

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

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("getPinnedThreads", () => {
    it("answers an unlocked pinned thread that has a saved permission mode", async () => {
        const threadId = await harness.run(
            async (context: any) =>
                await context.db.insert("threads", {
                    model: "m",
                    permissionMode: "supervised",
                    pinnedAt: 1,
                    status: "active",
                    title: "pinned with a mode",
                    userId: OWNER,
                }),
        );

        const pinned = (await harness.withIdentity({ userId: OWNER }).query(getPinnedThreads as never, {} as never)) as {
            _id: string;
            permissionMode?: string;
        }[];

        expect(pinned.map((thread) => thread._id)).toEqual([threadId]);
        expect(pinned[0]?.permissionMode).toBe("supervised");
    });
});

describe("the owner's ordered threads and thread list", () => {
    it("answers an ordered thread that has a saved permission mode", async () => {
        const threadId = await harness.run(
            async (context: any) =>
                await context.db.insert("threads", {
                    model: "m",
                    order: 1,
                    permissionMode: "supervised",
                    status: "active",
                    title: "ordered with a mode",
                    userId: OWNER,
                }),
        );

        const ordered = (await harness.withIdentity({ userId: OWNER }).query(getThreadOrders as never, {} as never)) as {
            _id: string;
            permissionMode?: string;
        }[];

        expect(ordered.map((thread) => thread._id)).toEqual([threadId]);
        expect(ordered[0]?.permissionMode).toBe("supervised");
    });

    it("lists a thread that has a saved permission mode on the first page", async () => {
        const threadId = await harness.run(
            async (context: any) =>
                await context.db.insert("threads", {
                    model: "m",
                    permissionMode: "full",
                    status: "active",
                    title: "listed with a mode",
                    updatedAt: 1,
                    userId: OWNER,
                }),
        );

        const page = (await harness
            .withIdentity({ userId: OWNER })
            .query(getThreads as never, { excludeTemporary: true, paginationOpts: { cursor: null, numItems: 25 } } as never)) as {
            page: { _id: string; permissionMode?: string }[];
        };

        expect(page.page.map((thread) => thread._id)).toContain(threadId);
        expect(page.page.find((thread) => thread._id === threadId)?.permissionMode).toBe("full");
    });
});
