/**
 * A shared chat's status read writes the OWNER's link rows: the stamp and the merge record go to the owner's shard, under the
 * owner's id, while the host read keeps the caller's token. The harness runs every shard in one database, so the shard hop is
 * replaced by a recorder that runs the target mutation in the harness; what is checked is which shard and which owner id are
 * asked for, and that the owner's rows are the ones written.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import schema from "../schema";
import { linkOwnerOf, stampStatusRead } from "./pr-status";
import { archiveMergedThread } from "../agent/auto-archive";
import { recordPullRequestMerged, recordStatusRead } from "./pr-threads";

const mocks = vi.hoisted(() => {
    return {
        calls: [] as { args: Record<string, unknown>; shardKey: string }[],
        owner: "",
        run: null as null | ((reference: unknown, args: unknown) => Promise<unknown>),
    };
});

vi.mock("../lib/cross-shard", () => {
    return {
        callOnShard: async (reference: unknown, args: Record<string, unknown>, options: { shardKey: string }) => {
            mocks.calls.push({ args, shardKey: options.shardKey });

            return await mocks.run?.(reference, args);
        },
    };
});

vi.mock("../lib/thread-shard", () => {
    return {
        threadShardFor: async () => mocks.owner,
    };
});

/** The mutations the routed calls name, mapped to the functions they stand for (the harness runs the functions themselves). */
const REGISTERED = new Map<unknown, unknown>([
    [internal.agent.auto_archive.archiveMergedThread, archiveMergedThread],
    [internal.source_control.pr_threads.recordPullRequestMerged, recordPullRequestMerged],
    [internal.source_control.pr_threads.recordStatusRead, recordStatusRead],
]);

const REPOSITORY = "octo/hello";
const NUMBER = 7;
const OWNER = "owner-1";
const CALLER = "caller-2";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
    mocks.calls.length = 0;
    mocks.run = (reference, args) => harness.run((ctx: any) => ctx.runMutation(REGISTERED.get(reference) ?? reference, args));
});

afterEach(() => {
    harness.close();
});

/** A chat of the owner with one link to the pull request (the owner's row, as only the owner attaches one). */
const setUpSharedChat = () =>
    harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", {
            mode: "text",
            model: "gpt-4o",
            status: "active",
            title: "Shared",
            updatedAt: Date.now(),
            userId: OWNER,
        });
        const linkId = await ctx.db.insert("pullRequestThreads", {
            createdAt: 1,
            kind: "attached",
            number: NUMBER,
            repository: REPOSITORY,
            threadId,
            title: "Shared",
            url: `https://github.com/${REPOSITORY}/pull/${String(NUMBER)}`,
            userId: OWNER,
        });

        return { linkId, threadId: String(threadId) };
    });

const ref = { number: NUMBER, repository: REPOSITORY };
const dummyQuery = { runQuery: async () => null } as never;

describe("linkOwnerOf", () => {
    it("resolves a shared chat to its owner, and an unshared one to the caller", async () => {
        mocks.owner = OWNER;
        expect(await linkOwnerOf(dummyQuery, CALLER, "thread-1")).toBe(OWNER);

        mocks.owner = CALLER;
        expect(await linkOwnerOf(dummyQuery, CALLER, "thread-1")).toBe(CALLER);

        expect(await linkOwnerOf(dummyQuery, CALLER, undefined)).toBe(CALLER);
    });
});

describe("routed status read", () => {
    it("stamps a shared chat's link on the owner's shard, as the owner", async () => {
        const { linkId, threadId } = await setUpSharedChat();

        mocks.owner = OWNER;

        await stampStatusRead(OWNER, ref, threadId, Date.now() + 1000);

        expect(mocks.calls).toHaveLength(1);
        expect(mocks.calls[0]?.shardKey).toBe(OWNER);
        expect(mocks.calls[0]?.args.userId).toBe(OWNER);

        const link = await harness.run(async (ctx: any) => await ctx.db.get("pullRequestThreads", linkId));

        expect(link?.statusReadAt).toBeTypeOf("number");
    });
});
