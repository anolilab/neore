import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { registerModule } from "../../test/registered-api";
import { runInShard } from "../lib/shard-context";
import { schemaWithShardedTables } from "../lib/test-schema";
import { deleteTrashedThreadEvents } from "./events";
import { recordMcpEvent } from "./events-log";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/internal", async (importOriginal) => {
    const { registeredApi: wire } = await import("../../test/registered-api");

    return wire(await importOriginal(), registry);
});

registerModule(registry, "public_api_events", { deleteTrashedThreadEvents });

const NOW = 1_700_000_000_000;
/** Events one thread's removal deletes per batch (`THREAD_EVENT_BATCH`). */
const BATCH = 200;

describe("a trashed chat's events", () => {
    it("are removed a batch at a time, and only that chat's", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await runInShard("user", async () => {
                await harness.run(async (context: any) => {
                    for (let index = 0; index < BATCH + 5; index += 1) {
                        await recordMcpEvent(
                            { db: context.db, now: NOW, scheduler: context.scheduler },
                            { data: { threadId: "trashed" }, eventId: `run:t${String(index)}`, name: "run.completed", timestamp: NOW, userId: "user" },
                        );
                    }

                    await recordMcpEvent(
                        { db: context.db, now: NOW, scheduler: context.scheduler },
                        { data: { threadId: "live" }, eventId: "run:live", name: "run.completed", timestamp: NOW, userId: "user" },
                    );
                });

                await harness.run(async (context: any) => await context.runMutation(deleteTrashedThreadEvents, { threadId: "trashed", userId: "user" }));
            });

            const left = (await harness.run(async (context: any) => {
                const { page } = await context.db.mcpEvents.findMany({ limit: 1000, where: { userId: "user" } });

                return page.map((row: { threadId?: string }) => row.threadId);
            })) as string[];

            // The first batch removed 200 of the trashed chat's 205 events; the live chat's event stays.
            expect(left.filter((threadId) => threadId === "trashed")).toHaveLength(5);
            expect(left.filter((threadId) => threadId === "live")).toHaveLength(1);
        } finally {
            harness.close();
        }
    });
});
