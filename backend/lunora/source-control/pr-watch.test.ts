/**
 * A watch is started and stopped on the caller's own link to a thread, through the table: a link of someone else, a
 * deleted thread or a missing link is refused, a repeat is `already`, a restart keeps the wake count, and a person
 * holds at most a fixed number of active watches.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertThread } from "../agent/table-writes";
import schema from "../schema";
import { MAX_ACTIVE_PULL_REQUEST_WATCHES, setPullRequestWatch } from "./pr-watch";

const OWNER = "user-a";
const OTHER = "user-b";
const REPOSITORY = "octo/hello";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

/** A thread of `userId` with one link to pull request `number`. Returns the thread and the link's row id. */
const seedLink = async (userId: string, number: number, extra: Record<string, unknown> = {}): Promise<{ linkId: string; threadId: string }> =>
    await harness.run(async (ctx: any) => {
        const threadId = await insertThread(ctx.db, {
            createdBy: userId,
            mode: "text",
            status: "active",
            tags: ["chat"],
            title: `work on ${String(number)}`,
            updatedAt: Date.now(),
            userId,
        });
        const linkId = await ctx.db.insert("pullRequestThreads", {
            createdAt: Date.now(),
            kind: "linked",
            number,
            repository: REPOSITORY,
            threadId,
            title: `pull ${String(number)}`,
            url: `https://github.com/${REPOSITORY}/pull/${String(number)}`,
            userId,
            ...extra,
        });

        return { linkId: String(linkId), threadId: String(threadId) };
    });

const watchOf = async (linkId: string): Promise<any> =>
    await harness.run(async (ctx: any) => {
        const row = await ctx.db.get("pullRequestThreads", linkId);

        return row?.watch;
    });

// An internal mutation is reached through `ctx.runMutation` from another function, as the agent host does.
const call = async (args: { number: number; threadId: string; userId: string; watching: boolean }): Promise<{ status: string }> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(setPullRequestWatch, { repository: REPOSITORY, ...args }));

describe("setPullRequestWatch", () => {
    it("starts a watch on the caller's own linked thread, with a fresh start time and no stop", async () => {
        const { linkId, threadId } = await seedLink(OWNER, 7);

        expect(await call({ number: 7, threadId, userId: OWNER, watching: true })).toStrictEqual({ status: "ok" });

        const watch = await watchOf(linkId);

        expect(watch).toBeDefined();
        expect(watch.stoppedAt).toBeUndefined();
        expect(typeof watch.startedAt).toBe("number");
    });

    it("refuses a link that belongs to someone else, and writes nothing", async () => {
        const { linkId, threadId } = await seedLink(OTHER, 7);

        expect(await call({ number: 7, threadId, userId: OWNER, watching: true })).toStrictEqual({ status: "not_linked" });
        expect(await watchOf(linkId)).toBeUndefined();
    });

    it("refuses a deleted thread's link", async () => {
        const { threadId } = await seedLink(OWNER, 7, { threadDeleted: true });

        expect(await call({ number: 7, threadId, userId: OWNER, watching: true })).toStrictEqual({ status: "not_linked" });
    });

    it("answers already for a start on a watch that is running, and for a stop on one that is not", async () => {
        const { linkId, threadId } = await seedLink(OWNER, 7);

        expect(await call({ number: 7, threadId, userId: OWNER, watching: false })).toStrictEqual({ status: "already" });
        expect(await call({ number: 7, threadId, userId: OWNER, watching: true })).toStrictEqual({ status: "ok" });
        expect(await call({ number: 7, threadId, userId: OWNER, watching: true })).toStrictEqual({ status: "already" });
        expect(await watchOf(linkId)).toMatchObject({ startedAt: expect.any(Number) });
    });

    it("stops a running watch by recording when it stopped, and keeps the row", async () => {
        const { linkId, threadId } = await seedLink(OWNER, 7);

        await call({ number: 7, threadId, userId: OWNER, watching: true });
        expect(await call({ number: 7, threadId, userId: OWNER, watching: false })).toStrictEqual({ status: "ok" });

        expect(await watchOf(linkId)).toMatchObject({ startedAt: expect.any(Number), stoppedAt: expect.any(Number) });
    });

    it("a restart keeps the wake count, so stopping and starting again cannot reset the cap", async () => {
        const { linkId, threadId } = await seedLink(OWNER, 7, { watch: { startedAt: 1, stoppedAt: 2, wakes: 3 } });

        expect(await call({ number: 7, threadId, userId: OWNER, watching: true })).toStrictEqual({ status: "ok" });

        const watch = await watchOf(linkId);

        expect(watch.wakes).toBe(3);
        expect(watch.stoppedAt).toBeUndefined();
        expect(watch.startedAt).not.toBe(1);
    });

    it("does not count a watch whose thread was deleted against the person's limit", async () => {
        for (let number = 100; number < 100 + MAX_ACTIVE_PULL_REQUEST_WATCHES - 1; number += 1) {
            await seedLink(OWNER, number, { watch: { startedAt: 1 } });
        }

        await seedLink(OWNER, 200, { threadDeleted: true, watch: { startedAt: 1 } });

        const { linkId, threadId } = await seedLink(OWNER, 7);

        expect(await call({ number: 7, threadId, userId: OWNER, watching: true })).toStrictEqual({ status: "ok" });
        expect(await watchOf(linkId)).toMatchObject({ startedAt: expect.any(Number) });
    });

    it("finds the live link of a thread even when other deleted links point at the same pull request", async () => {
        const { linkId, threadId } = await seedLink(OWNER, 7);

        for (let index = 0; index < 3; index += 1) {
            await seedLink(OWNER, 7, { threadDeleted: true });
        }

        expect(await call({ number: 7, threadId, userId: OWNER, watching: true })).toStrictEqual({ status: "ok" });
        expect(await watchOf(linkId)).toMatchObject({ startedAt: expect.any(Number) });
    });

    it("refuses a start once the person has the most active watches, and lets a stopped one through", async () => {
        for (let number = 100; number < 100 + MAX_ACTIVE_PULL_REQUEST_WATCHES; number += 1) {
            const seeded = await seedLink(OWNER, number, { watch: { startedAt: 1 } });

            expect(seeded.linkId).toBeTruthy();
        }

        const { linkId, threadId } = await seedLink(OWNER, 7);

        expect(await call({ number: 7, threadId, userId: OWNER, watching: true })).toStrictEqual({ status: "too_many" });
        expect(await watchOf(linkId)).toBeUndefined();
    });
});
