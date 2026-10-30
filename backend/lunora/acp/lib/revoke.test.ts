import { describe, expect, it } from "vitest";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { LIVE_STREAM_BATCH } from "./finish";
import { endHostSessionsOfDevice } from "./revoke";

describe("endHostSessionsOfDevice", () => {
    it("stops paging at isDone even when the last page still carries a cursor", async () => {
        let reads = 0;
        const patched: unknown[] = [];
        const db = {
            acpSessions: {
                findMany: async () => {
                    reads += 1;

                    return { continueCursor: "more", isDone: true, page: [{ _id: "s1", status: "idle", threadId: "t1" }] };
                },
            },
            patch: async (id: unknown, value: unknown) => {
                patched.push([id, value]);
            },
            persistentStreams: {
                findMany: async () => {
                    return { page: [] };
                },
            },
        };

        await endHostSessionsOfDevice({ db } as unknown as MutationCtx, "d1" as Id<"devices">, 10);

        expect(reads).toBe(1);
        expect(patched).toEqual([["s1", { status: "ended", updatedAt: 10 }]]);
    });

    it("reads a session's live streams in bounded batches", async () => {
        const limits: unknown[] = [];
        const db = {
            acpSessions: {
                findMany: async () => {
                    return { continueCursor: null, isDone: true, page: [{ _id: "s1", status: "ended", threadId: "t1" }] };
                },
            },
            patch: async () => {},
            persistentStreams: {
                findMany: async (query: { limit?: number }) => {
                    limits.push(query.limit);

                    return { page: [] };
                },
            },
        };

        await endHostSessionsOfDevice({ db } as unknown as MutationCtx, "d1" as Id<"devices">, 10);

        expect(limits).toEqual([LIVE_STREAM_BATCH]);
    });
});
