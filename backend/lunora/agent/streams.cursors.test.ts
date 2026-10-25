/**
 * `listDeltas` reads one stream row per cursor, so the cursor list is capped:
 * the validator refuses an oversized list, and the exported handler (which
 * hot-path callers use without validation) stops at the cap on its own — a
 * cursor naming no stream pushes no deltas, so the delta budget never ends it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { listDeltas, listDeltasHandler, MAX_CURSORS_PER_REQUEST } from "./streams";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
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

const OWNER = "owner-user";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;
let missingStreamId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);

    await harness.run((async (ctx: any) => {
        threadId = await ctx.db.insert("threads", { createdAt: 1, status: "active", title: "T", updatedAt: 1, userId: OWNER });
        // An id that was valid and is gone: `db.get` answers null for it.
        missingStreamId = await ctx.db.insert("streamingMessages", {
            order: 0,
            state: { kind: "streaming", lastHeartbeat: 1 },
            stateKind: "streaming",
            stepOrder: 0,
            threadId,
            userId: OWNER,
        });
        await ctx.db.delete(missingStreamId);
    }) as never);
});

afterEach(() => {
    harness.close();
});

const cursorsOf = (count: number) => Array.from({ length: count }, () => ({ cursor: 0, streamId: missingStreamId }));

describe("listDeltas cursor cap", () => {
    it("refuses a cursor list over the cap", async () => {
        await expect(
            harness
                .withIdentity({ userId: OWNER } as never)
                .query(listDeltas as never, { cursors: cursorsOf(MAX_CURSORS_PER_REQUEST + 1), threadId } as never),
        ).rejects.toThrow(/At most \d+ stream cursors/);
    });

    it("accepts a list at the cap", async () => {
        const result = await harness
            .withIdentity({ userId: OWNER } as never)
            .query(listDeltas as never, { cursors: cursorsOf(MAX_CURSORS_PER_REQUEST), threadId } as never);

        expect(result).toEqual([]);
    });

    it("reads at most the cap's worth of streams when cursors yield no deltas", async () => {
        const reads = await harness.run((async (ctx: any) => {
            const get = vi.spyOn(ctx.db, "get");

            await listDeltasHandler(ctx, { cursors: cursorsOf(MAX_CURSORS_PER_REQUEST * 3) as never, threadId: threadId as never });

            return get.mock.calls.filter(([id]) => id === missingStreamId).length;
        }) as never);

        expect(reads).toBe(MAX_CURSORS_PER_REQUEST);
    });
});
