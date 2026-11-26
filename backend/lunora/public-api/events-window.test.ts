import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../lib/test-schema";
import { pollEvents } from "./events";

describe("the poll window of the internal events/poll", () => {
    it("never returns an event older than the seven-day retention, even one housekeeping has not pruned yet", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => {
                // An event of a dormant shard's backlog: expired, and not pruned because no housekeeping ran for this shard.
                await context.db.insert("mcpEvents", {
                    createdAt: 1,
                    data: "{}",
                    eventId: "run:expired",
                    name: "run.completed",
                    seq: 1,
                    timestamp: 1,
                    userId: "user",
                });
                await context.db.insert("mcpEvents", {
                    createdAt: Date.now(),
                    data: "{}",
                    eventId: "run:fresh",
                    name: "run.completed",
                    seq: 2,
                    timestamp: Date.now(),
                    userId: "user",
                });
                await context.db.insert("mcpEventWatermarks", { seq: 2, userId: "user" });
            });

            const outcome = (await harness.run(
                async (context: any) => await context.runQuery(pollEvents, { fromSeq: 0, maxEvents: 50, name: "run.completed", userId: "user" }),
            )) as { events: { eventId: string }[]; truncated: boolean };

            expect(outcome.events.map((event) => event.eventId)).toStrictEqual(["run:fresh"]);
            expect(outcome.truncated).toBe(true);
        } finally {
            harness.close();
        }
    });
});
