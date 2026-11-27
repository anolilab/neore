import { describe, expect, it } from "vitest";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { OPEN_CALL_STATUSES } from "../../devices/lib/state";
import { recordRemovedDeviceOptions } from "./calls";

describe("recordRemovedDeviceOptions", () => {
    it("reads every open call of the device, page by page, not only the first page", async () => {
        const reads: { cursor: unknown; status: unknown }[] = [];
        const db = {
            deviceCalls: {
                findMany: async ({ cursor, where }: { cursor?: string; where: { status: unknown } }) => {
                    reads.push({ cursor, status: where.status });

                    // Each status has a second page; the first carries a call that is not an option change.
                    return cursor === undefined
                        ? { continueCursor: "next", isDone: false, page: [{ _id: "c1", toolName: "acp_send" }] }
                        : { continueCursor: null, isDone: true, page: [] };
                },
            },
        };

        await recordRemovedDeviceOptions({ db } as unknown as MutationCtx, "d1" as Id<"devices">, 10);

        expect(reads).toHaveLength(OPEN_CALL_STATUSES.length * 2);

        for (const status of OPEN_CALL_STATUSES) {
            expect(reads.filter((read) => read.status === status).map((read) => read.cursor)).toEqual([undefined, "next"]);
        }
    });
});
