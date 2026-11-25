import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { registerModule } from "../../test/registered-api";
import { runInShard } from "../lib/shard-context";
import { schemaWithShardedTables } from "../lib/test-schema";
import { drainTrashedThreadEvents, deleteTrashedThreadEvents } from "./events";
import { hasMcpEventsOfThread, recordMcpEvent } from "./events-log";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/internal", async (importOriginal) => {
    const { registeredApi: wire } = await import("../../test/registered-api");

    return wire(await importOriginal(), registry);
});

registerModule(registry, "public_api_events", { deleteTrashedThreadEvents, drainTrashedThreadEvents });

const NOW = 1_700_000_000_000;
/** Events one thread's removal deletes per batch (`THREAD_EVENT_BATCH`). */
const BATCH = 200;

/** A chat row, and `count` of its events recorded for `userId`. */
const chatWithEvents = async (context: any, deleted: boolean, count: number): Promise<string> => {
    const threadId = (await context.db.insert("threads", { deleted, status: "active", title: "Chat", userId: "user" })) as string;

    for (let index = 0; index < count; index += 1) {
        await recordMcpEvent(
            { db: context.db, now: NOW, scheduler: context.scheduler },
            { data: { threadId }, eventId: `run:${threadId}:${String(index)}`, name: "run.completed", timestamp: NOW, userId: "user" },
        );
    }

    return threadId;
};

const eventsOf = async (context: any, threadId: string): Promise<number> => {
    const { page } = await context.db.mcpEvents.findMany({ limit: 1000, where: { threadId, userId: "user" } });

    return page.length;
};

describe("a trashed chat's events", () => {
    it("are removed a batch at a time", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const { left, threadId } = (await runInShard(
                "user",
                async () =>
                    await harness.run(async (context: any) => {
                        const id = await chatWithEvents(context, true, BATCH + 5);

                        await context.runMutation(deleteTrashedThreadEvents, { threadId: id, userId: "user" });

                        return { left: await eventsOf(context, id), threadId: id };
                    }),
            )) as { left: number; threadId: string };

            expect(threadId).toBeDefined();
            // The first batch removed 200 of the chat's 205 events.
            expect(left).toBe(5);
        } finally {
            harness.close();
        }
    });

    it("are not removed once the chat is restored, so its events recorded since stay", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const left = (await runInShard(
                "user",
                async () =>
                    await harness.run(async (context: any) => {
                        const id = await chatWithEvents(context, false, 3);

                        await context.runMutation(deleteTrashedThreadEvents, { threadId: id, userId: "user" });

                        return await eventsOf(context, id);
                    }),
            )) as number;

            expect(left).toBe(3);
        } finally {
            harness.close();
        }
    });

    it("refuses a restore while the trashed chat still has events, and allows it once they are drained", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const outcome = (await runInShard(
                "user",
                async () =>
                    await harness.run(async (context: any) => {
                        const id = await chatWithEvents(context, true, BATCH + 5);

                        expect(await hasMcpEventsOfThread(context, "user", id)).toBe(true);

                        // The drain is one transaction per batch; the restore's refusal rests on the events being gone.
                        while (!(await context.runMutation(drainTrashedThreadEvents, { threadId: id, userId: "user" }))) {
                            // Each call removes one batch.
                        }

                        return { left: await eventsOf(context, id) };
                    }),
            )) as { left: number };

            expect(outcome.left).toBe(0);
        } finally {
            harness.close();
        }
    });
});
