import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { runInShard } from "../lib/shard-context";
import { schemaWithShardedTables } from "../lib/test-schema";
import { retryEventWake } from "./events";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the retry of a failed Events wake", () => {
    it("writes the shard's wake and retention time for the event's expiry", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const dueAt = Date.now() + 7 * DAY_MS;

            await runInShard("user", async () => {
                await harness.run(async (context: any) => await context.runMutation(retryEventWake, { attempt: 1, dueAt, userId: "user" }));
            });

            const census = (await harness.run(async (context: any) => {
                const rows = await context.db.query("shardActivity").take(10);

                return rows[0];
            })) as { nextDueAt?: number; retentionDueAt?: number } | undefined;

            expect(census?.nextDueAt).toBe(dueAt);
            expect(census?.retentionDueAt).toBe(dueAt);
        } finally {
            harness.close();
        }
    });
});
