/**
 * A thread that holds a permission mode is answered whole by every read that returns a thread row: the output check refuses a row
 * with a field the validator does not declare. One read per validator shape: the hand-listed ones (`getPinnedThreads`,
 * `getThreadOrders`, `getThreadsWithTemporaryFilter`), the shared document validator (`getThreads`, `getThread`; the
 * composite and sharing reads spread those same fields).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { getPinnedThreads, getThread, getThreadOrders, getThreads, getThreadsWithTemporaryFilter } from "./functions";

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
let threadId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(
        async (context: any) =>
            await context.db.insert("threads", {
                model: "m",
                order: 1,
                permissionMode: "supervised",
                pinnedAt: 1,
                status: "active",
                title: "with a mode",
                updatedAt: 1,
                userId: OWNER,
            }),
    );
});

afterEach(() => {
    harness.close();
});

describe("a thread that holds a permission mode", () => {
    const as = () => harness.withIdentity({ userId: OWNER });
    const page = { paginationOpts: { cursor: null, numItems: 25 } };

    it("is answered by the pinned, ordered and temporary-filter reads, which list their fields by hand", async () => {
        const pinned: any[] = (await as().query(getPinnedThreads as never, {} as never)) as never;
        const ordered: any[] = (await as().query(getThreadOrders as never, {} as never)) as never;
        const filtered: any = await as().run(
            async (context: any) => await context.runQuery(getThreadsWithTemporaryFilter as never, { excludeTemporary: true, ...page, userId: OWNER } as never),
        );

        expect(pinned.map((thread) => [thread._id, thread.permissionMode])).toStrictEqual([[threadId, "supervised"]]);
        expect(ordered.map((thread) => [thread._id, thread.permissionMode])).toStrictEqual([[threadId, "supervised"]]);
        expect(filtered.page.map((thread: any) => [thread._id, thread.permissionMode])).toStrictEqual([[threadId, "supervised"]]);
    });

    it("is answered by the list, and the single read, which share the document validator", async () => {
        const list: any = await as().query(getThreads as never, { excludeTemporary: true, ...page } as never);
        const one: any = await as().query(getThread as never, { threadId } as never);

        expect(list.page.find((thread: any) => thread._id === threadId)?.permissionMode).toBe("supervised");
        expect(one.permissionMode).toBe("supervised");
    });
});
