import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../lib/test-schema";
import { collectMcpEventsForExport, EXPORT_EVENT_BYTES } from "./gdpr";

describe("the Events section of the export, measured as it is written", () => {
    it("counts a payload's escaped size, so one that doubles when written is cut even though its raw bytes fit", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            // Each quote is one byte raw but two once JSON escapes it: 300 K raw, about 600 K written, over the budget.
            const payload = '"'.repeat(300 * 1024);

            await harness.run(async (context: any) => {
                await context.db.insert("mcpEvents", {
                    createdAt: 1,
                    data: payload,
                    eventId: "run:quoted",
                    name: "run.completed",
                    seq: 1,
                    timestamp: 1,
                    userId: "user",
                });
            });

            const { events, truncated } = (await harness.run(
                async (context: any) => await context.runQuery(collectMcpEventsForExport, { userId: "user" }),
            )) as { events: { seq: number }[]; truncated: boolean };

            expect(payload.length).toBeLessThan(EXPORT_EVENT_BYTES);
            expect(events).toStrictEqual([]);
            expect(truncated).toBe(true);
        } finally {
            harness.close();
        }
    });
});
