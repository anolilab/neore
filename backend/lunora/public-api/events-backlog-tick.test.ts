import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { registerModule } from "../../test/registered-api";
import { runInShard } from "../lib/shard-context";
import { runShardTick } from "../lib/shard-housekeeping";
import { schemaWithShardedTables } from "../lib/test-schema";
import { pruneMcpEvents } from "./events";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/internal", async (importOriginal) => {
    const { registeredApi: wire } = await import("../../test/registered-api");

    return wire(await importOriginal(), registry);
});

registerModule(registry, "public_api_events", { pruneMcpEvents });

const DAY_MS = 24 * 60 * 60 * 1000;
/** Prune batches one tick runs (`MCP_EVENT_PRUNE_ROUNDS`), each of 200 rows. */
const TICK_ROWS = 10 * 200;

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
});
