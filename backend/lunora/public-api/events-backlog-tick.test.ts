import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { registerModule } from "../../test/registered-api";
import { runInShard } from "../lib/shard-context";
import { runShardTick } from "../lib/shard-housekeeping";
import { schemaWithShardedTables } from "../lib/test-schema";
import { pruneMcpEvents, pruneMcpEventsBacklog } from "./events";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/internal", async (importOriginal) => {
    const { registeredApi: wire } = await import("../../test/registered-api");

    return wire(await importOriginal(), registry);
});

registerModule(registry, "public_api_events", { pruneMcpEvents, pruneMcpEventsBacklog });

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows one tick prunes: a single batch of 200, in its own transaction; the rest is a tick of its own. */
const TICK_ROWS = 200;

describe("a tick facing an Events backlog larger than its rounds", () => {
    it("leaves its shard armed for the rows the rounds did not reach", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const now = Date.now();
            const backlog = TICK_ROWS + 5;

            await runInShard("user", async () => {
                await harness.run(async (context: any) => {
                    await context.db.insert("shardActivity", {
                        lastActiveAt: now,
                        nextDueAt: now - 1000,
                        retentionDueAt: now - 1000,
                        shardKey: "user",
                    });

                    for (let index = 0; index < backlog; index += 1) {
                        await context.db.insert("mcpEvents", {
                            createdAt: now - 10 * DAY_MS,
                            data: "{}",
                            eventId: `run:old${String(index)}`,
                            name: "run.completed",
                            seq: index + 1,
                            timestamp: now - 10 * DAY_MS,
                            userId: "user",
                        });
                    }
                });

                await harness.run(async (context: any) => await context.runMutation(runShardTick, {}));
            });

            const remaining = (await harness.run(async (context: any) => {
                const { page } = await context.db.mcpEvents.findMany({ limit: 10_000, where: { userId: "user" } });

                return page.length;
            })) as number;
            const census = (await harness.run(async (context: any) => {
                const rows = await context.db.query("shardActivity").take(10);

                return rows[0];
            })) as { nextDueAt?: number } | undefined;

            expect(remaining).toBe(backlog - TICK_ROWS);
            expect(census?.nextDueAt).toBeDefined();
        } finally {
            harness.close();
        }
    });

    it("prunes one batch per call of its own job, leaving the rest for the next", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const now = Date.now();
            const backlog = 2 * TICK_ROWS + 5;

            await runInShard("user", async () => {
                await harness.run(async (context: any) => {
                    for (let index = 0; index < backlog; index += 1) {
                        await context.db.insert("mcpEvents", {
                            createdAt: now - 10 * DAY_MS,
                            data: "{}",
                            eventId: `run:old${String(index)}`,
                            name: "run.completed",
                            seq: index + 1,
                            timestamp: now - 10 * DAY_MS,
                            userId: "user",
                        });
                    }
                });

                await harness.run(async (context: any) => await context.runMutation(pruneMcpEventsBacklog, {}));
            });

            const remaining = (await harness.run(async (context: any) => {
                const { page } = await context.db.mcpEvents.findMany({ limit: 10_000, where: { userId: "user" } });

                return page.length;
            })) as number;

            expect(remaining).toBe(backlog - TICK_ROWS);
        } finally {
            harness.close();
        }
    });
});

describe("the retention sweep's record of what it expired", () => {
    it("records the highest seq it expired for each user, and leaves a newer row's seq out of it", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const now = Date.now();

            await runInShard("user", async () => {
                await harness.run(async (context: any) => {
                    await context.db.insert("mcpEventWatermarks", { seq: 4, userId: "user" });

                    for (let seq = 1; seq <= 4; seq += 1) {
                        await context.db.insert("mcpEvents", {
                            createdAt: seq <= 3 ? now - 10 * DAY_MS : now,
                            data: "{}",
                            eventId: `run:w${String(seq)}`,
                            name: "run.completed",
                            seq,
                            timestamp: now,
                            userId: "user",
                        });
                    }
                });

                await harness.run(async (context: any) => await context.runMutation(pruneMcpEvents, {}));
            });

            const watermark = (await harness.run(async (context: any) => await context.db.mcpEventWatermarks.findFirst({ where: { userId: "user" } }))) as {
                prunedThrough?: number;
            } | null;

            expect(watermark?.prunedThrough).toBe(3);
        } finally {
            harness.close();
        }
    });
});
