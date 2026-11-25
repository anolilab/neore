import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { runInShard } from "../lib/shard-context";
import { schemaWithShardedTables } from "../lib/test-schema";
import { deleteMcpEventsOfThread, recordMcpEvent } from "./events-log";

const NOW = 1_700_000_000_000;

describe("a deleted thread's Events", () => {
    it("are removed with the thread, the other threads' events stay, and the sequence does not restart", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await runInShard("user", async () => {
                await harness.run(async (context: any) => {
                    for (const eventId of ["run:a1", "run:a2"]) {
                        await recordMcpEvent(
                            { db: context.db, now: NOW },
                            { data: { threadId: "thread-a" }, eventId, name: "run.completed", timestamp: NOW, userId: "user" },
                        );
                    }

                    await recordMcpEvent(
                        { db: context.db, now: NOW },
                        { data: { threadId: "thread-b" }, eventId: "run:b1", name: "run.completed", timestamp: NOW, userId: "user" },
                    );
                });

                const drained = (await harness.run(async (context: any) => await deleteMcpEventsOfThread(context, "user", "thread-a"))) as boolean;

                expect(drained).toBe(true);
            });

            const remaining = (await harness.run(async (context: any) => {
                const { page } = await context.db.mcpEvents.findMany({ where: { userId: "user" } });

                return page.map((row: { eventId: string }) => row.eventId);
            })) as string[];
            const watermark = (await harness.run(async (context: any) => await context.db.mcpEventWatermarks.findFirst({ where: { userId: "user" } }))) as {
                seq: number;
            };

            expect(remaining).toStrictEqual(["run:b1"]);
            expect(watermark.seq).toBe(3);
        } finally {
            harness.close();
        }
    });

    it("removes a large thread one batch per call, reporting more until none are left", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const total = 201;

            await runInShard("user", async () => {
                await harness.run(async (context: any) => {
                    for (let index = 0; index < total; index += 1) {
                        await recordMcpEvent(
                            { db: context.db, now: NOW },
                            { data: { threadId: "thread-a" }, eventId: `run:a${index}`, name: "run.completed", timestamp: NOW, userId: "user" },
                        );
                    }
                });

                const first = (await harness.run(async (context: any) => await deleteMcpEventsOfThread(context, "user", "thread-a"))) as boolean;
                const second = (await harness.run(async (context: any) => await deleteMcpEventsOfThread(context, "user", "thread-a"))) as boolean;

                expect(first).toBe(false);
                expect(second).toBe(true);
            });
        } finally {
            harness.close();
        }
    });
});
