import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../lib/test-schema";
import { collectMcpEventsForExport, EXPORT_EVENT_BYTES } from "./gdpr";

describe("the Events section of the export, when one event is over the budget", () => {
    it("leaves an event larger than the whole budget out, and says the history was cut", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const payload = "x".repeat(EXPORT_EVENT_BYTES + 1024);

            await harness.run(async (context: any) => {
                await context.db.insert("mcpEvents", {
                    createdAt: 1,
                    data: payload,
                    eventId: "run:huge",
                    name: "run.completed",
                    seq: 1,
                    timestamp: 1,
                    userId: "user",
                });
            });

            const { events, truncated } = (await harness.run(
                async (context: any) => await context.runQuery(collectMcpEventsForExport, { userId: "user" }),
            )) as { events: { seq: number }[]; truncated: boolean };

            expect(events).toStrictEqual([]);
            expect(truncated).toBe(true);
        } finally {
            harness.close();
        }
    });
});
