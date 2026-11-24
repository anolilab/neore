import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../lib/test-schema";
import { collectMcpEventsForExport, deleteUserMcpEvents, MAX_EXPORT_EVENTS } from "./gdpr";

const BATCH = 200;

describe("collectMcpEventsForExport", () => {
    it("keeps the newest events, oldest first, and says the history was cut past the cap", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => {
                for (let index = 0; index < MAX_EXPORT_EVENTS + 1; index += 1) {
                    await context.db.insert("mcpEvents", {
                        createdAt: 1,
                        data: "{}",
                        eventId: `run:${index}`,
                        name: "run.completed",
                        seq: index + 1,
                        timestamp: 1,
                        userId: "user",
                    });
                }
            });

            const { events, truncated } = (await harness.run(
                async (context: any) => await context.runQuery(collectMcpEventsForExport, { userId: "user" }),
            )) as { events: { seq: number }[]; truncated: boolean };

            expect(truncated).toBe(true);
            expect(events).toHaveLength(MAX_EXPORT_EVENTS);
            // The oldest (seq 1) is the one left out; the kept run is seq 2 to the newest, in order.
            expect(events[0]?.seq).toBe(2);
            expect(events.at(-1)?.seq).toBe(MAX_EXPORT_EVENTS + 1);
        } finally {
            harness.close();
        }
    });

    it("returns every page of the user's events, and no other user's", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => {
                for (let index = 0; index < BATCH + 1; index += 1) {
                    await context.db.insert("mcpEvents", {
                        createdAt: 1,
                        data: "{}",
                        eventId: `run:${index}`,
                        name: "run.completed",
                        seq: index + 1,
                        timestamp: 1,
                        userId: "user",
                    });
                }

                await context.db.insert("mcpEvents", {
                    createdAt: 1,
                    data: "{}",
                    eventId: "run:stranger",
                    name: "run.completed",
                    seq: 1,
                    timestamp: 1,
                    userId: "stranger",
                });
            });

            const { events } = (await harness.run(async (context: any) => await context.runQuery(collectMcpEventsForExport, { userId: "user" }))) as {
                events: { eventId: string }[];
            };

            expect(events).toHaveLength(BATCH + 1);
            expect(events.some((event) => event.eventId === "run:stranger")).toBe(false);
        } finally {
            harness.close();
        }
    });
});

describe("deleteUserMcpEvents", () => {
    it.each([
        { events: BATCH, firstHasMore: false, remainingAfterFirst: 0, watermarksAfterFirst: 0 },
        { events: BATCH + 1, firstHasMore: true, remainingAfterFirst: 1, watermarksAfterFirst: 1 },
    ])("reports more only while rows remain, for a log of $events events", async ({ events, firstHasMore, remainingAfterFirst, watermarksAfterFirst }) => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => {
                for (let index = 0; index < events; index += 1) {
                    await context.db.insert("mcpEvents", {
                        createdAt: 1,
                        data: "{}",
                        eventId: `run:${index}`,
                        name: "run.completed",
                        seq: index + 1,
                        timestamp: 1,
                        userId: "user",
                    });
                }

                await context.db.insert("mcpEventWatermarks", { seq: events, userId: "user" });
            });

            const remaining = async (table: "mcpEvents" | "mcpEventWatermarks"): Promise<number> =>
                (await harness.run(async (context: any) => {
                    const { page } = await context.db[table].findMany({ limit: 1000, where: { userId: "user" } });

                    return page.length;
                })) as number;

            const first = (await harness.run(async (context: any) => await context.runMutation(deleteUserMcpEvents, { userId: "user" }))) as {
                hasMore: boolean;
            };

            expect(first.hasMore).toBe(firstHasMore);
            expect(await remaining("mcpEvents")).toBe(remainingAfterFirst);
            expect(await remaining("mcpEventWatermarks")).toBe(watermarksAfterFirst);

            if (firstHasMore) {
                const second = (await harness.run(async (context: any) => await context.runMutation(deleteUserMcpEvents, { userId: "user" }))) as {
                    hasMore: boolean;
                };

                expect(second.hasMore).toBe(false);
                expect(await remaining("mcpEvents")).toBe(0);
                expect(await remaining("mcpEventWatermarks")).toBe(0);
            }
        } finally {
            harness.close();
        }
    });
});
