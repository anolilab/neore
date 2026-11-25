/**
 * Only the thread's owner's status read writes the chat's link rows. A collaborator's read writes nothing (it names a pull request
 * the owner's chats may link to), and a failed grant lookup counts as "not the owner", so the host answer still returns and nothing
 * is written.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import schema from "../schema";
import { ownsThread, stampStatusRead } from "./pr-status";
import { recordStatusRead } from "./pr-threads";

const mocks = vi.hoisted(() => {
    return {
        fail: false,
        owner: "",
    };
});

vi.mock("../lib/thread-shard", () => {
    return {
        threadShardFor: async () => {
            if (mocks.fail) {
                throw new Error("the grant lookup failed");
            }

            return mocks.owner;
        },
    };
});

const REPOSITORY = "octo/hello";
const NUMBER = 7;
const OWNER = "owner-1";
const CALLER = "caller-2";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
    mocks.fail = false;
});

afterEach(() => {
    harness.close();
});

/** A chat of the owner with one link to the pull request (only the owner attaches one, so the row is the owner's). */
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
const queryRunner = { runQuery: async () => null } as never;

describe("ownsThread", () => {
    it("is true for the owner of the thread", async () => {
        mocks.owner = OWNER;

        expect(await ownsThread(queryRunner, OWNER, "thread-1")).toBe(true);
    });

    it("is false for a collaborator, whose grant names another owner", async () => {
        mocks.owner = OWNER;

        expect(await ownsThread(queryRunner, CALLER, "thread-1")).toBe(false);
    });

    it("is false when the grant lookup fails, so nothing is written", async () => {
        mocks.fail = true;

        expect(await ownsThread(queryRunner, OWNER, "thread-1")).toBe(false);
    });

    it("is false with no thread to read", async () => {
        expect(await ownsThread(queryRunner, OWNER, undefined)).toBe(false);
    });
});

describe("the owner's status stamp", () => {
    it("stamps the owner's own link on the caller's shard", async () => {
        const { linkId, threadId } = await setUpSharedChat();
        const ctx = {
            runMutation: (reference: unknown, args: unknown) =>
                harness.run((runCtx: any) =>
                    runCtx.runMutation(reference === internal.source_control.pr_threads.recordStatusRead ? recordStatusRead : reference, args),
                ),
        };

        await stampStatusRead(ctx as never, OWNER, ref, threadId, Date.now() + 1000);

        const link = await harness.run(async (runCtx: any) => await runCtx.db.get("pullRequestThreads", linkId));

        expect(link?.statusReadAt).toBeTypeOf("number");
    });
});
