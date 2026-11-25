import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../lib/test-schema";
import { collectMcpEventsForExport, EXPORT_EVENT_BYTES } from "./gdpr";

describe("the Events section of the export, past an event that is too large", () => {
    it("leaves out the oversized newest event and still keeps the older ones that fit, saying the history was cut", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => {
                await context.db.insert("mcpEvents", {
                    createdAt: 1,
                    data: "{}",
                    eventId: "run:small",
                    name: "run.completed",
                    seq: 1,
                    timestamp: 1,
                    userId: "user",
                });
                await context.db.insert("mcpEvents", {
                    createdAt: 2,
                    data: "x".repeat(EXPORT_EVENT_BYTES + 1024),
                    eventId: "run:huge",
                    name: "run.completed",
                    seq: 2,
                    timestamp: 2,
                    userId: "user",
                });
            });

            const { events, truncated } = (await harness.run(
                async (context: any) => await context.runQuery(collectMcpEventsForExport, { userId: "user" }),
            )) as { events: { seq: number }[]; truncated: boolean };

            expect(events.map((event) => event.seq)).toStrictEqual([1]);
            expect(truncated).toBe(true);
        } finally {
            harness.close();
        }
    });
});
