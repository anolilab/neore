import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../lib/test-schema";
import { collectMcpEventsForExport, deleteUserMcpEvents, EXPORT_EVENT_BYTES, MAX_EXPORT_EVENTS } from "./gdpr";

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

    it("leaves out an event larger than the whole budget, and says the history was cut", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => {
                await context.db.insert("mcpEvents", {
                    createdAt: 1,
                    data: "x".repeat(EXPORT_EVENT_BYTES + 1024),
                    eventId: "run:huge",
                    name: "run.completed",
                    seq: 1,
                    timestamp: 1,
                    userId: "user",
                });
            });

            const { events, truncated } = (await harness.run(
                async (context: any) => await context.runQuery(collectMcpEventsForExport, { userId: "user" }),
            )) as { events: { seq: number }[]; truncated: boolean };

            expect(events).toStrictEqual([]);
            expect(truncated).toBe(true);
        } finally {
            harness.close();
        }
    });

    it("keeps the newest events that fit the byte budget, and says the rest was cut", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            // Each payload is about 300 KB, so only the newest one fits the budget.
            const payload = "x".repeat(300 * 1024);

            await harness.run(async (context: any) => {
                for (let seq = 1; seq <= 3; seq += 1) {
                    await context.db.insert("mcpEvents", {
                        createdAt: 1,
                        data: payload,
                        eventId: `run:${String(seq)}`,
                        name: "run.completed",
                        seq,
                        timestamp: 1,
                        userId: "user",
                    });
                }
            });

            const { events, truncated } = (await harness.run(
                async (context: any) => await context.runQuery(collectMcpEventsForExport, { userId: "user" }),
            )) as { events: { seq: number }[]; truncated: boolean };

            expect(events.map((event) => event.seq)).toStrictEqual([3]);
            expect(truncated).toBe(true);
            expect(payload.length * 3).toBeGreaterThan(EXPORT_EVENT_BYTES);
        } finally {
            harness.close();
        }
    });

    it("counts a payload's escaped size, so one that doubles when written is cut even though its raw bytes fit", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            // Each quote is one byte raw but two once JSON escapes it: 300 K raw, about 600 K written, over the budget.
            const payload = '"'.repeat(300 * 1024);

            await harness.run(async (context: any) => {
                await context.db.insert("mcpEvents", {
                    createdAt: 1,
                    data: payload,
                    eventId: "run:quoted",
                    name: "run.completed",
                    seq: 1,
                    timestamp: 1,
                    userId: "user",
                });
            });

            const { events, truncated } = (await harness.run(
                async (context: any) => await context.runQuery(collectMcpEventsForExport, { userId: "user" }),
            )) as { events: { seq: number }[]; truncated: boolean };

            expect(payload.length).toBeLessThan(EXPORT_EVENT_BYTES);
            expect(events).toStrictEqual([]);
            expect(truncated).toBe(true);
        } finally {
            harness.close();
        }
    });

    it("leaves out the oversized newest event and keeps the older ones that fit, saying the history was cut", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => {
                await context.db.insert("mcpEvents", {
                    createdAt: 1,
                    data: "{}",
                    eventId: "run:small",
                    name: "run.completed",
                    seq: 1,
                    timestamp: 1,
                    userId: "user",
                });
                await context.db.insert("mcpEvents", {
                    createdAt: 2,
                    data: "x".repeat(EXPORT_EVENT_BYTES + 1024),
                    eventId: "run:huge",
                    name: "run.completed",
                    seq: 2,
                    timestamp: 2,
                    userId: "user",
                });
            });

            const { events, truncated } = (await harness.run(
                async (context: any) => await context.runQuery(collectMcpEventsForExport, { userId: "user" }),
            )) as { events: { seq: number }[]; truncated: boolean };

            expect(events.map((event) => event.seq)).toStrictEqual([1]);
            expect(truncated).toBe(true);
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
