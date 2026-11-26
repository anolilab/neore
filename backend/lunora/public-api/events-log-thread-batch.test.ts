import { describe, expect, it } from "vitest";

import { deleteMcpEventsOfThread } from "./events-log";

describe("deleteMcpEventsOfThread", () => {
    it("reads its batch from the primary, so a lagging replica cannot end a thread's cleanup early", async () => {
        const reads: Record<string, unknown>[] = [];
        const ctx = {
            db: {
                delete: async () => undefined,
                mcpEvents: {
                    findMany: async (options: Record<string, unknown>) => {
                        reads.push(options);

                        return { page: [] };
                    },
                },
            },
        };

        expect(await deleteMcpEventsOfThread(ctx as never, "user", "thread-1")).toBe(true);
        expect(reads).toHaveLength(1);
        expect(reads[0]).toMatchObject({ consistency: "primary", where: { threadId: "thread-1", userId: "user" } });
    });
});
