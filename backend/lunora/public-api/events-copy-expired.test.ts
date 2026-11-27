import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { runInShard } from "../lib/shard-context";
import { schemaWithShardedTables } from "../lib/test-schema";
import { copyMergedMcpEvents, RETENTION_MS } from "./events-log";

const NOW = 1_700_000_000_000;

const guestRow = (eventId: string, seq: number, createdAt: number) => {
    return { createdAt, data: "{}", eventId, name: "run.completed", seq, timestamp: createdAt, userId: "guest" };
};

describe("a merged guest's expired Events", () => {
    it("are not copied, so they do not become readable again, while the fresh ones are", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const appended = (await runInShard(
                "to",
                async () =>
                    await harness.run(
                        async (context: any) =>
                            await copyMergedMcpEvents(
                                { db: context.db, now: NOW, scheduler: context.scheduler },
                                [guestRow("run:expired", 1, NOW - RETENTION_MS - 1), guestRow("run:fresh", 2, NOW - 1000)],
                                "to",
                            ),
                    ),
            )) as number;

            const copied = (await harness.run(async (context: any) => {
                const { page } = await context.db.mcpEvents.findMany({ where: { userId: "to" } });

                return page.map((row: { eventId: string }) => row.eventId);
            })) as string[];

            expect(appended).toBe(1);
            expect(copied).toStrictEqual(["run:fresh"]);
        } finally {
            harness.close();
        }
    });
});
