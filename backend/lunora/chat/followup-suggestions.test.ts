/**
 * The next-prompt suggestion after a reply: the setting, guests, locked and host-run threads gate the paid call, and a reply
 * is paid for once. The job calls `getAgent` (the model) only after every gate has passed, so "no call" is `getAgent` not
 * being called.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import {
    activePathIds,
    admitFollowupSuggestions,
    beginFollowupDispatch,
    cacheFollowupSuggestions,
    endFollowupDispatch,
    followupDispatchInFlight,
    holdFollowupClaim,
    followupInFlight,
    followupModelRows,
    getCachedFollowupSuggestionsHandler,
    releaseFollowupSuggestions,
    replyAnchorRow,
    withDeadline,
} from "../agent/followup-suggestions";
import schema from "../schema";
import { generateFollowupSuggestionsForThread } from "./functions";

const OWNER = "owner-user";
const COLLAB = "collaborator-user";

const registry = vi.hoisted(() => new Map<string, unknown>());
const getAgent = vi.hoisted(() => vi.fn());
// Every shard-routed call the job makes: the shard key it names, and the run that answers it on the test database.
const routed = vi.hoisted(() => {
    return { keys: [] as string[], run: async (_ref: unknown, _args: unknown): Promise<unknown> => null };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("./lib/get-agent", () => {
    return { default: getAgent };
});
vi.mock("../lib/cross-shard", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/cross-shard")>()),
        callOnShard: async (ref: unknown, args: unknown, options?: { shardKey?: string }) => {
            routed.keys.push(options?.shardKey ?? "");

            return await routed.run(ref, args);
        },
    };
});

const REACHED = "getAgent reached";

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "agent_sharing", await import("../agent/sharing"));
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "agent_followup_suggestions", await import("../agent/followup-suggestions"));
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    getAgent.mockReset();
    getAgent.mockRejectedValue(new Error(REACHED));
    routed.keys.length = 0;
    routed.run = async (ref, args) => await harness.run(async (ctx: any) => await ctx.runQuery(ref, args));
    threadId = await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, status: "active", title: "T", updatedAt: 1, userId: OWNER }),
    );
});

afterEach(() => {
    harness.close();
});

const runJob = async (id = threadId, userId = OWNER) =>
    await harness.action(async (context: any) => await context.runAction(generateFollowupSuggestionsForThread, { threadId: id, userId }));

describe("the setting", () => {
    // A row lives on its owner's shard: the collaborator's own setting is read on their shard, not the owner's where the job runs.
    it("a collaborator's own setting is read on the collaborator's shard", async () => {
        await runJob(threadId, COLLAB);

        expect(routed.keys).toContain(COLLAB);
    });

    it("off: the job picks no model and makes no call", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { enableFollowupSuggestions: false, userId: OWNER }));

        await runJob();

        expect(getAgent).not.toHaveBeenCalled();
    });

    it("on, or never set: the job reaches the model", async () => {
        await runJob();

        expect(getAgent).toHaveBeenCalledTimes(1);
    });
});

describe("threads that never get a suggestion", () => {
    // A branched thread is read along its active path (`activePathIds`), not its raw rows: a leaf that is not a stored message has no path.
    it("a branched thread whose leaf is not a stored message reads no path rows, so no reply is keyed", async () => {
        const branched = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threads", { activeLeafMessageId: "leaf-1", createdAt: 1, status: "active", title: "B", updatedAt: 1, userId: OWNER }),
        );

        await expect(harness.run(async (ctx: any) => await ctx.runQuery(activePathIds, { leafId: "leaf-1", threadId: branched }))).resolves.toEqual([]);
    });

    it("a locked thread gets no model call", async () => {
        const locked = await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, lockedAt: 1000, status: "active", title: "L", updatedAt: 1, userId: OWNER }),
        );

        await runJob(locked);

        expect(getAgent).not.toHaveBeenCalled();
    });

    it("a host-run thread gets no cloud model call", async () => {
        const host = await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, runner: "host", status: "active", title: "H", updatedAt: 1, userId: OWNER }),
        );

        await runJob(host);

        expect(getAgent).not.toHaveBeenCalled();
    });
});

describe("one paid call per reply", () => {
    const admit = async (lastMessageId: string, id = threadId) =>
        await harness.action(async (context: any) => await context.runMutation(admitFollowupSuggestions, { lastMessageId, threadId: id, userId: OWNER }));

    it("the first run of a reply is admitted, a second run of the same reply is not", async () => {
        await expect(admit("reply-1")).resolves.toEqual(expect.any(Number));
        await expect(admit("reply-1")).resolves.toBeNull();
    });

    // The cache retry renews the claim that took the reply, and only that one: another claim time renews nothing.
    it("renews the claim that took a reply, and not any other", async () => {
        const claimedAt = (await admit("reply-renew")) as number;
        const hold = async (at: number) =>
            await harness.action(
                async (context: any) => await context.runMutation(holdFollowupClaim, { claimedAt: at, lastMessageId: "reply-renew", threadId, userId: OWNER }),
            );

        await expect(hold(claimedAt)).resolves.toBe(true);
        await expect(hold(claimedAt + 1)).resolves.toBe(false);
    });

    it("the next reply is admitted on its own claim", async () => {
        await admit("reply-1");

        await expect(admit("reply-2")).resolves.toEqual(expect.any(Number));
    });

    it("a locked thread is not admitted", async () => {
        const locked = await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, lockedAt: 1000, status: "active", title: "L", updatedAt: 1, userId: OWNER }),
        );

        await expect(admit("reply-1", locked)).resolves.toBeNull();
    });
});

describe("a late run cannot free a later run's claim", () => {
    const admitRun = async (lastMessageId: string) =>
        await harness.action(async (context: any) => await context.runMutation(admitFollowupSuggestions, { lastMessageId, threadId, userId: OWNER }));

    const releaseRun = async (claimedAt: number, lastMessageId: string) =>
        await harness.action(
            async (context: any) => await context.runMutation(releaseFollowupSuggestions, { claimedAt, lastMessageId, threadId, userId: OWNER }),
        );

    it("a release with another run's claimedAt leaves the claim held; the right one frees it", async () => {
        const claimedAt = await admitRun("reply-1");

        expect(claimedAt).toEqual(expect.any(Number));

        await releaseRun((claimedAt as number) + 1, "reply-1");

        await expect(admitRun("reply-1")).resolves.toBeNull();

        await releaseRun(claimedAt as number, "reply-1");

        await expect(admitRun("reply-1")).resolves.toEqual(expect.any(Number));
    });
});

describe("a late run cannot replace a newer cache", () => {
    // `replyAt` defaults to the turn's order: a plain turn's replies are told apart by their turn alone.
    const cache = async (lastMessageId: string, order: number, suggestions: string[], replyAt = order) =>
        await harness.action(
            async (context: any) => await context.runMutation(cacheFollowupSuggestions, { lastMessageId, order, replyAt, suggestions, threadId }),
        );

    const cached = async () => await harness.run(async (ctx: any) => await getCachedFollowupSuggestionsHandler(ctx, { threadId }));

    it("an older turn that finishes after a newer one is refused", async () => {
        await cache("reply-new", 5, ["newer?"]);
        await cache("reply-old", 3, ["older?"]);

        await expect(cached()).resolves.toEqual({ lastMessageId: "reply-new", suggestions: ["newer?"] });
    });

    it("a newer turn replaces an older cache", async () => {
        await cache("reply-old", 3, ["older?"]);
        await cache("reply-new", 5, ["newer?"]);

        await expect(cached()).resolves.toEqual({ lastMessageId: "reply-new", suggestions: ["newer?"] });
    });

    it("an earlier sibling of the same turn that finishes after a later one is refused", async () => {
        await cache("sibling-later", 5, ["later?"], 2000);
        await cache("sibling-earlier", 5, ["earlier?"], 1000);

        await expect(cached()).resolves.toEqual({ lastMessageId: "sibling-later", suggestions: ["later?"] });
    });

    it("a later sibling of the same turn replaces an earlier one", async () => {
        await cache("sibling-earlier", 5, ["earlier?"], 1000);
        await cache("sibling-later", 5, ["later?"], 2000);

        await expect(cached()).resolves.toEqual({ lastMessageId: "sibling-later", suggestions: ["later?"] });
    });

    // A refused charge clears the reply's suggestions with an empty write under the same guard, so nothing shows without its unit.
    it("an empty write clears the reply's suggestions, and an older run's clear does not clear a newer reply's", async () => {
        await cache("reply-new", 5, ["newer?"]);
        await cache("reply-new", 5, []);

        await expect(cached()).resolves.toEqual({ lastMessageId: "reply-new", suggestions: [] });

        await cache("reply-newer", 7, ["newest?"]);
        await cache("reply-new", 5, []);

        await expect(cached()).resolves.toEqual({ lastMessageId: "reply-newer", suggestions: ["newest?"] });
    });

    // The write reports whether it landed: the unit is taken for a written reply only, so a refused one is charged nothing.
    it("reports true for a written reply and false for a refused one", async () => {
        await expect(
            harness.action(
                async (context: any) =>
                    await context.runMutation(cacheFollowupSuggestions, {
                        lastMessageId: "reply-new",
                        order: 5,
                        replyAt: 5,
                        suggestions: ["newer?"],
                        threadId,
                    }),
            ),
        ).resolves.toBe(true);
        await expect(
            harness.action(
                async (context: any) =>
                    await context.runMutation(cacheFollowupSuggestions, {
                        lastMessageId: "reply-old",
                        order: 3,
                        replyAt: 3,
                        suggestions: ["older?"],
                        threadId,
                    }),
            ),
        ).resolves.toBe(false);
    });
});

describe("a model request in flight holds the chat's lock", () => {
    const begin = async (requestId: string, id = threadId) =>
        await harness.action(async (context: any) => await context.runMutation(beginFollowupDispatch, { requestId, threadId: id }));

    const end = async (requestId: string, claimedAt: number) =>
        await harness.action(async (context: any) => await context.runMutation(endFollowupDispatch, { claimedAt, requestId, threadId }));

    const inFlight = async () => await harness.run(async (ctx: any) => await followupDispatchInFlight(ctx, threadId));

    it("is taken for an open thread, and holds until the request settles", async () => {
        const claimedAt = await begin("reply-1");

        expect(typeof claimedAt).toBe("number");
        await expect(inFlight()).resolves.toBe(true);

        await end("reply-1", claimedAt as number);

        await expect(inFlight()).resolves.toBe(false);
    });

    it("the delete actions read it through the internal query, which answers the same", async () => {
        const claimedAt = await begin("reply-2");

        await expect(harness.run(async (ctx: any) => await ctx.runQuery(followupInFlight, { threadId }))).resolves.toBe(true);

        await end("reply-2", claimedAt as number);

        await expect(harness.run(async (ctx: any) => await ctx.runQuery(followupInFlight, { threadId }))).resolves.toBe(false);
    });

    it("is not taken for a locked thread, so nothing is sent", async () => {
        const locked = await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, lockedAt: 1000, status: "active", title: "L", updatedAt: 1, userId: OWNER }),
        );

        await expect(begin("reply-1", locked)).resolves.toBeNull();
    });
});

describe("the row a reply is keyed by", () => {
    type Row = { _id: string; message: { role: string } | null; order: number; stepOrder: number };
    const row = (_id: string, role: string, stepOrder: number, order = 2): Row => {
        return { _id, message: { role }, order, stepOrder };
    };

    it("a turn that starts with an agent-switch divider is keyed by the reply after it, not the divider", () => {
        const turn = [row("switch", "system", 0), row("text", "assistant", 1), row("tool", "tool", 2), row("final", "assistant", 3)];

        expect(replyAnchorRow(turn, turn[3]!)._id).toBe("text");
    });

    it("a divider in the middle of a turn keys the reply after it, the composer's last group", () => {
        const turn = [row("first", "assistant", 1), row("switch", "system", 2), row("second", "assistant", 3)];

        expect(replyAnchorRow(turn, turn[2]!)._id).toBe("second");
    });

    it("a plain turn is keyed by its first assistant row, not a row from an older turn", () => {
        const turn = [row("user", "user", 0, 1), row("text", "assistant", 1), row("final", "assistant", 2)];
        const older = row("older", "assistant", 5, 0);

        expect(replyAnchorRow([...turn, older], turn[2]!)._id).toBe("text");
    });

    it("a task divider appended after a multi-row reply does not move its key to the final row", () => {
        const turn = [row("user", "user", 0, 1), row("text", "assistant", 1, 1), row("tool", "tool", 2, 1), row("final", "assistant", 3, 1)];
        const divider = row("divider", "system", 4, 1);

        expect(replyAnchorRow([...turn, divider], turn[3]!)._id).toBe("text");
    });
});

describe("the rows the suggestion model reads", () => {
    type Row = { _id: string };
    const ids = (rows: Row[]) => rows.map((row) => row._id);

    it("a tool turn longer than one page is read whole, its user prompt included, then the older rows of the page", () => {
        // Newest first: the reply's rows, the user prompt that began it (on the second page), then an older turn on the first page.
        const turnRows = [{ _id: "final" }, { _id: "tool" }, { _id: "text" }, { _id: "prompt" }];
        const pageRows = [{ _id: "final" }, { _id: "tool" }, { _id: "text" }, { _id: "older" }];

        expect(ids(followupModelRows(turnRows, pageRows))).toEqual(["final", "tool", "text", "prompt", "older"]);
    });

    it("a turn that fits in one page is read as that page", () => {
        const page = [{ _id: "final" }, { _id: "text" }, { _id: "prompt" }];

        expect(ids(followupModelRows(page, page))).toEqual(["final", "text", "prompt"]);
    });
});

describe("withDeadline", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("aborts the call once its deadline passes, and nothing before it", async () => {
        let seen: AbortSignal | undefined;

        const outcome = withDeadline(1000, (signal) => {
            seen = signal;

            return new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new Error("aborted")));
            });
        })
            .then(() => "resolved")
            .catch((error: Error) => error.message);

        vi.advanceTimersByTime(999);
        expect(seen?.aborted).toBe(false);

        vi.advanceTimersByTime(1);
        expect(seen?.aborted).toBe(true);
        await expect(outcome).resolves.toBe("aborted");
    });

    it("clears its deadline once a call succeeds, so no timer is left behind", async () => {
        await expect(withDeadline(1000, async () => "done")).resolves.toBe("done");
        expect(vi.getTimerCount()).toBe(0);
    });

    it("clears its deadline once a call fails, and the failure is the call's own", async () => {
        await expect(
            withDeadline(1000, async () => {
                throw new Error("provider failed");
            }),
        ).rejects.toThrow("provider failed");
        expect(vi.getTimerCount()).toBe(0);
    });
});
