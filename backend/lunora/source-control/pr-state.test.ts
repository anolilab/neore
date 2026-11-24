/**
 * The housekeeping sweep that keeps a linked pull request's stored state fresh (`pr-state.ts`). Only open links whose
 * state is stale are leased, and nothing is leased while the person keeps open-pull-request chats off.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInShard } from "../lib/shard-context";
import schema from "../schema";
import { PR_STATE_MAX_AGE_MS, dispatchLinkedPullRequestChecks, recordLinkState } from "./pr-state";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "user-owner";
const NOW_LINK = { createdAt: 0, kind: "attached", title: "Add the thing", url: "https://example.test/acme/app/pull/7" } as const;

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

/** Inserts a thread with one link per entry, then runs the sweep as the owner's shard. */
const sweepWith = (links: { state?: "open" | "closed" | "merged"; stateCheckedAt?: number; threadDeleted?: boolean }[], keepSetting?: boolean) =>
    harness.run(async (ctx: any) => {
        if (keepSetting !== undefined) {
            await ctx.db.insert("userSettings", { keepOpenPullRequestChats: keepSetting, userId: OWNER });
        }

        const linkIds: string[] = [];

        for (const [index, link] of links.entries()) {
            const threadId = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: `Thread ${index}`,
                updatedAt: 1,
                userId: OWNER,
            });

            linkIds.push(
                await ctx.db.insert("pullRequestThreads", {
                    ...NOW_LINK,
                    number: index + 1,
                    repository: "acme/app",
                    threadId,
                    userId: OWNER,
                    ...(link.state !== undefined && { state: link.state }),
                    ...(link.stateCheckedAt !== undefined && { stateCheckedAt: link.stateCheckedAt }),
                    ...(link.threadDeleted !== undefined && { threadDeleted: link.threadDeleted }),
                }),
            );
        }

        const result = await runInShard(OWNER, () => ctx.runMutation(dispatchLinkedPullRequestChecks, {}));
        const stamped = await Promise.all(linkIds.map((id) => ctx.db.get("pullRequestThreads", id)));

        return { dispatched: result.dispatched, stamped: stamped.map((row: any) => row?.stateCheckedAt) };
    });

describe("dispatchLinkedPullRequestChecks", () => {
    it("leases an open link whose state was never read, and stamps it", async () => {
        const { dispatched, stamped } = await sweepWith([{}]);

        expect(dispatched).toBe(1);
        expect(stamped[0]).toBeTypeOf("number");
    });

    it("leases nothing while the person keeps open-pull-request chats off", async () => {
        const { dispatched, stamped } = await sweepWith([{}], false);

        expect(dispatched).toBe(0);
        expect(stamped[0]).toBeUndefined();
    });

    it("skips a link whose state is closed or merged", async () => {
        const { dispatched } = await sweepWith([{ state: "closed" }, { state: "merged" }]);

        expect(dispatched).toBe(0);
    });

    it("skips a link whose state was read recently, and leases one read long ago", async () => {
        const recent = Date.now() - 1000;
        const old = Date.now() - PR_STATE_MAX_AGE_MS - 1000;
        const { dispatched } = await sweepWith([
            { state: "open", stateCheckedAt: recent },
            { state: "open", stateCheckedAt: old },
        ]);

        expect(dispatched).toBe(1);
    });

    it("skips a link whose thread is deleted", async () => {
        const { dispatched } = await sweepWith([{ threadDeleted: true }]);

        expect(dispatched).toBe(0);
    });
});

describe("recordLinkState", () => {
    it("writes the state the host gave, and stamps when it was read", async () => {
        const state = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Thread", updatedAt: 1, userId: OWNER });
            const linkId = await ctx.db.insert("pullRequestThreads", { ...NOW_LINK, number: 9, repository: "acme/app", threadId, userId: OWNER });

            await ctx.runMutation(recordLinkState, { linkId, state: "merged" });

            return await ctx.db.get("pullRequestThreads", linkId);
        });

        expect(state.state).toBe("merged");
        expect(state.stateCheckedAt).toBeTypeOf("number");
    });
});
