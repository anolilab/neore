import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../lib/test-schema";
import { pollEvents } from "./events";

const poll = (context: any) =>
    context.runQuery(pollEvents, { fromSeq: 0, maxEvents: 50, name: "run.completed", userId: "user" }) as Promise<{
        events: { eventId: string }[];
    }>;

describe("a poll and a chat in the trash", () => {
    it("leaves out the events of a trashed chat, and returns the live chat's", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const events = (await harness.run(async (context: any) => {
                const trashed = await context.db.insert("threads", {
                    deleted: true,
                    deletedAt: Date.now(),
                    status: "active",
                    title: "Trashed",
                    userId: "user",
                });
                const live = await context.db.insert("threads", { deleted: false, status: "active", title: "Live", userId: "user" });

                for (const [threadId, seq] of [
                    [trashed, 1],
                    [live, 2],
                ] as const) {
                    await context.db.insert("mcpEvents", {
                        createdAt: Date.now(),
                        data: JSON.stringify({ threadId }),
                        eventId: `run:${String(seq)}`,
                        name: "run.completed",
                        seq,
                        timestamp: Date.now(),
                        userId: "user",
                    });
                }

                await context.db.insert("mcpEventWatermarks", { seq: 2, userId: "user" });

                return await poll(context);
            })) as { events: { eventId: string }[] };

            expect(events.events.map((event) => event.eventId)).toStrictEqual(["run:2"]);
        } finally {
            harness.close();
        }
    });

    it("shows a chat's events once it is no longer trashed, as the poll's trash check reads it", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const events = (await harness.run(async (context: any) => {
                const thread = await context.db.insert("threads", {
                    deleted: true,
                    deletedAt: Date.now(),
                    status: "active",
                    title: "Restored",
                    userId: "user",
                });

                await context.db.insert("mcpEvents", {
                    createdAt: Date.now(),
                    data: JSON.stringify({ threadId: thread }),
                    eventId: "run:1",
                    name: "run.completed",
                    seq: 1,
                    timestamp: Date.now(),
                    userId: "user",
                });
                await context.db.insert("mcpEventWatermarks", { seq: 1, userId: "user" });
                await context.db.patch("threads", thread, { deleted: false });

                return await poll(context);
            })) as { events: { eventId: string }[] };

            expect(events.events.map((event) => event.eventId)).toStrictEqual(["run:1"]);
        } finally {
            harness.close();
        }
    });
});
