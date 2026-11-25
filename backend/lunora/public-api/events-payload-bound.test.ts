import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { runInShard } from "../lib/shard-context";
import { schemaWithShardedTables } from "../lib/test-schema";
import { MAX_EVENT_PAYLOAD_BYTES, recordMcpEvent } from "./events-log";

const NOW = 1_700_000_000_000;

describe("a recorded event's payload", () => {
    it("is kept as its thread and an omitted mark past the bound, and whole within it", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await runInShard("user", async () => {
                await harness.run(async (context: any) => {
                    await recordMcpEvent(
                        { db: context.db, now: NOW, scheduler: context.scheduler },
                        {
                            data: { blob: "x".repeat(MAX_EVENT_PAYLOAD_BYTES * 2), threadId: "thread-a" },
                            eventId: "run:big",
                            name: "run.completed",
                            timestamp: NOW,
                            userId: "user",
                        },
                    );
                    await recordMcpEvent(
                        { db: context.db, now: NOW, scheduler: context.scheduler },
                        { data: { threadId: "thread-b" }, eventId: "run:small", name: "run.completed", timestamp: NOW, userId: "user" },
                    );
                });
            });

            const stored = (await harness.run(async (context: any) => {
                const { page } = await context.db.mcpEvents.findMany({ where: { userId: "user" } });

                return page.map((row: { data: string; eventId: string }) => {
                    return { data: JSON.parse(row.data), eventId: row.eventId };
                });
            })) as { data: unknown; eventId: string }[];

            expect(stored.find((row) => row.eventId === "run:big")?.data).toStrictEqual({ omitted: true, threadId: "thread-a" });
            expect(stored.find((row) => row.eventId === "run:small")?.data).toStrictEqual({ threadId: "thread-b" });
        } finally {
            harness.close();
        }
    });
});
