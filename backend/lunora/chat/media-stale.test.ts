/**
 * An agent tool or workflow that starts a media generation leaves an unstamped
 * pending row; if the action dies nothing fails it. The sweep fails such rows
 * once they are older than any generation can run, and leaves fresh rows,
 * queue-stamped rows (the claim reaper's) and locked chats alone.
 */
import { MODEL_REGISTRY } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { addMessages } from "../agent/messages";
import { ABANDONED_MEDIA_TEXT, mediaJobStamp } from "./media-abandon";
import { failStaleMediaRows, MEDIA_STALE_AFTER_MS } from "./media-stale";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 1), toFake: ["Date"] });
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

const insertThread = async (extra: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "t", userId: "u1", ...extra }));

/** Saved through the agent's own writer, so `text` is whatever production rows carry. */
const pendingRow = async (threadId: string, marker: string, jobId?: string): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const { messages } = await ctx.runMutation(addMessages, {
            messages: [
                {
                    message: { content: [{ text: marker, type: "text" }], role: "assistant" },
                    model: "m",
                    status: "pending",
                    ...(jobId !== undefined && { providerMetadata: mediaJobStamp(jobId) }),
                },
            ],
            threadId,
            userId: "u1",
        });

        return messages[0]._id;
    });

const read = async (id: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(id));

const sweep = async (): Promise<{ failed: number }> => await harness.run(async (ctx: any) => await ctx.runMutation(failStaleMediaRows, {}));

const ageBy = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("failStaleMediaRows", () => {
    it("fails an old unstamped media row for every media marker", async () => {
        const threadId = await insertThread();
        const rows = [];

        for (const marker of ["__IMAGE_GENERATING__", "__AUDIO_GENERATING__", "__VIDEO_GENERATING__", "__MUSIC_GENERATING__"]) {
            rows.push(await pendingRow(threadId, marker));
        }

        ageBy(MEDIA_STALE_AFTER_MS + 1000);

        await expect(sweep()).resolves.toStrictEqual({ failed: 4 });

        for (const id of rows) {
            expect(await read(id)).toMatchObject({ status: "failed", text: ABANDONED_MEDIA_TEXT });
        }
    });

    it("leaves a fresh row, a stamped row, a non-media pending row and a locked chat's row alone", async () => {
        const threadId = await insertThread();
        const lockedId = await insertThread({ lockedAt: Date.now() });
        const stamped = await pendingRow(threadId, "__IMAGE_GENERATING__", "job-1");
        const plain = await pendingRow(threadId, "partial reply");
        const locked = await pendingRow(lockedId, "__IMAGE_GENERATING__");

        ageBy(MEDIA_STALE_AFTER_MS + 1000);

        const fresh = await pendingRow(threadId, "__VIDEO_GENERATING__");

        await expect(sweep()).resolves.toStrictEqual({ failed: 0 });

        for (const id of [stamped, plain, locked, fresh]) {
            expect(await read(id)).toMatchObject({ status: "pending" });
        }
    });
});

describe("MEDIA_STALE_AFTER_MS", () => {
    it("outlasts every media model's typical render", () => {
        for (const model of MODEL_REGISTRY) {
            if (model.mode && ["image", "music", "text-to-speech", "video"].includes(model.mode)) {
                expect(MEDIA_STALE_AFTER_MS).toBeGreaterThan(model.avgLatencyMs ?? 0);
            }
        }
    });
});
