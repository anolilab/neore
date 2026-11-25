import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../lib/test-schema";
import { collectMcpEventsForExport, EXPORT_EVENT_BYTES } from "./gdpr";

describe("the Events section of the export, by bytes", () => {
    it("keeps the newest events that fit the byte budget, and says the rest was cut", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            // Each payload is about 300 KB, so only the newest one fits the budget.
            const payload = "x".repeat(300 * 1024);

            await harness.run(async (context: any) => {
                for (let seq = 1; seq <= 3; seq += 1) {
                    await context.db.insert("mcpEvents", {
                        createdAt: 1,
                        data: payload,
                        eventId: `run:${String(seq)}`,
                        name: "run.completed",
                        seq,
                        timestamp: 1,
                        userId: "user",
                    });
                }
            });

            const { events, truncated } = (await harness.run(
                async (context: any) => await context.runQuery(collectMcpEventsForExport, { userId: "user" }),
            )) as { events: { seq: number }[]; truncated: boolean };

            expect(events.map((event) => event.seq)).toStrictEqual([3]);
            expect(truncated).toBe(true);
            expect(payload.length * 3).toBeGreaterThan(EXPORT_EVENT_BYTES);
        } finally {
            harness.close();
        }
    });
});
