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

describe("a dormant shard's tick", () => {
    it("prunes the shard's expired Events when its retention time has passed, though the shard is idle beyond the housekeeping horizon", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const now = Date.now();

            await runInShard("user", async () => {
                await harness.run(async (context: any) => {
                    // A census row idle for 400 days (past the 30-day horizon), its retained rows due now, and one expired event.
                    await context.db.insert("shardActivity", {
                        lastActiveAt: now - 400 * DAY_MS,
                        nextDueAt: now - 1000,
                        retentionDueAt: now - 1000,
                        shardKey: "user",
                    });
                    await context.db.insert("mcpEvents", {
                        createdAt: now - 10 * DAY_MS,
                        data: "{}",
                        eventId: "run:expired",
                        name: "run.completed",
                        seq: 1,
                        timestamp: now - 10 * DAY_MS,
                        userId: "user",
                    });
                });

                await harness.run(async (context: any) => await context.runMutation(runShardTick, {}));
            });

            const left = (await harness.run(async (context: any) => {
                const { page } = await context.db.mcpEvents.findMany({ limit: 10, where: { userId: "user" } });

                return page.length;
            })) as number;

            expect(left).toBe(0);
        } finally {
            harness.close();
        }
    });
});
