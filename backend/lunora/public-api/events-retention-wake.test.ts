import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { runInShard } from "../lib/shard-context";
import { schemaWithShardedTables } from "../lib/test-schema";
import { pruneRetainedActivity } from "../gdpr/retention";
import { pruneMcpEvents } from "./events";
import { RETENTION_MS, recordMcpEvent } from "./events-log";

/** The shard's census row, read from the test database (the one row a test shard holds). */
const censusOf = async (harness: ReturnType<typeof lunoraTest>): Promise<{ nextDueAt?: number; retentionDueAt?: number } | undefined> =>
    (await harness.run(async (context: any) => {
        const rows = await context.db.query("shardActivity").take(10);

        return rows[0];
    })) as { nextDueAt?: number; retentionDueAt?: number } | undefined;

describe("the Events log's retention wake", () => {
    it("wakes the shard for an event's expiry when the event is recorded, with no other retained rows", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            // An injected clock: the event is recorded at `now`, so its expiry is exactly one retention window later.
            const now = 1_700_000_000_000;

            await runInShard("user", async () => {
                await harness.run(async (context: any) => {
                    await recordMcpEvent(
                        { db: context.db, now },
                        {
                            data: {},
                            eventId: "run:new",
                            name: "run.completed",
                            timestamp: now,
                            userId: "user",
                        },
                    );
                });
            });

            const census = await censusOf(harness);

            expect(census?.retentionDueAt).toBe(now + RETENTION_MS);
            expect(census?.nextDueAt).toBe(now + RETENTION_MS);
        } finally {
            harness.close();
        }
    });

    it("sets the shard's retention time to the oldest event left, once the retention sweep has run", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const now = Date.now();
            const freshCreatedAt = now - 60 * 60 * 1000;

            await runInShard("user", async () => {
                await harness.run(async (context: any) => {
                    await context.db.insert("mcpEvents", {
                        createdAt: 1,
                        data: "{}",
                        eventId: "run:old",
                        name: "run.completed",
                        seq: 1,
                        timestamp: 1,
                        userId: "user",
                    });
                    await context.db.insert("mcpEvents", {
                        createdAt: freshCreatedAt,
                        data: "{}",
                        eventId: "run:fresh",
                        name: "run.completed",
                        seq: 2,
                        timestamp: freshCreatedAt,
                        userId: "user",
                    });
                });

                const outcome = (await harness.run(async (context: any) => await context.runMutation(pruneMcpEvents, {}))) as {
                    hasMore: boolean;
                    removed: number;
                };

                expect(outcome).toStrictEqual({ hasMore: false, removed: 1 });

                // The Events sweep alone never writes the shard's retention time (`gdpr/retention.ts` does, from all retained rows).
                expect(await censusOf(harness)).toBeUndefined();

                await harness.run(async (context: any) => await context.runMutation(pruneRetainedActivity, {}));
            });

            const census = await censusOf(harness);

            expect(census?.retentionDueAt).toBe(freshCreatedAt + RETENTION_MS);
        } finally {
            harness.close();
        }
    });
});
