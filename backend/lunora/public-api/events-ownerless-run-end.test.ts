import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { runInShard } from "../lib/shard-context";
import { schemaWithShardedTables } from "../lib/test-schema";
import { recordRunEnd } from "./events-log";

const NOW = 1_700_000_000_000;

describe("a run's end in a chat with no owner", () => {
    it("records no event, so nothing outlives the chat when it is deleted", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const threadId = (await runInShard(
                "user",
                async () =>
                    await harness.run(async (context: any) => {
                        const id = await context.db.insert("threads", {
                            createdAt: NOW,
                            status: "active",
                            title: "Ownerless",
                            updatedAt: NOW,
                        });

                        await recordRunEnd(
                            { db: context.db, now: NOW, scheduler: context.scheduler },
                            { outcome: "succeeded", starterId: "user", streamId: "stream-1", threadId: id },
                        );

                        return id;
                    }),
            )) as string;

            const recorded = (await harness.run(async (context: any) => {
                const { page } = await context.db.mcpEvents.findMany({ limit: 10, where: { userId: "user" } });

                return page.length;
            })) as number;

            expect(threadId).toBeDefined();
            expect(recorded).toBe(0);
        } finally {
            harness.close();
        }
    });
});
