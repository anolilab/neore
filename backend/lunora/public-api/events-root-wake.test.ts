import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../lib/test-schema";
import { RETENTION_MS, recordMcpEvent } from "./events-log";

const NOW = 1_700_000_000_000;

describe("an event recorded from the root shard", () => {
    it("arms the owner's shard for the event's expiry, though no shard is current", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => {
                await recordMcpEvent(
                    { db: context.db, now: NOW, scheduler: context.scheduler },
                    { data: {}, eventId: "run:root", name: "run.completed", timestamp: NOW, userId: "user" },
                );
            });

            const census = (await harness.run(async (context: any) => {
                const rows = await context.db.query("shardActivity").take(10);

                return rows.find((row: { shardKey: string }) => row.shardKey === "user");
            })) as { nextDueAt?: number; retentionDueAt?: number } | undefined;

            expect(census?.retentionDueAt).toBe(NOW + RETENTION_MS);
            expect(census?.nextDueAt).toBe(NOW + RETENTION_MS);
        } finally {
            harness.close();
        }
    });
});
