/**
 * The next-prompt suggestion after a reply: the setting, guests, locked and host-run threads gate the paid call, and a reply
 * is paid for once. The job calls `getAgent` (the model) only after every gate has passed, so "no call" is `getAgent` not
 * being called.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import {
    admitFollowupSuggestions,
    beginFollowupDispatch,
    cacheFollowupSuggestions,
    endFollowupDispatch,
    followupDispatchInFlight,
    getCachedFollowupSuggestionsHandler,
    replyAnchorRow,
} from "../agent/followup-suggestions";
import schema from "../schema";
import { generateFollowupSuggestionsForThread } from "./functions";

const OWNER = "owner-user";

const registry = vi.hoisted(() => new Map<string, unknown>());
const getAgent = vi.hoisted(() => vi.fn());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("./lib/get-agent", () => {
    return { default: getAgent };
});

const REACHED = "getAgent reached";

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "agent_followup_suggestions", await import("../agent/followup-suggestions"));
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    getAgent.mockReset();
    getAgent.mockRejectedValue(new Error(REACHED));
    threadId = await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, status: "active", title: "T", updatedAt: 1, userId: OWNER }),
    );
});

afterEach(() => {
    harness.close();
});

const runJob = async (id = threadId) =>
    await harness.action(async (context: any) => await context.runAction(generateFollowupSuggestionsForThread, { threadId: id, userId: OWNER }));

describe("the setting", () => {
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
        await expect(admit("reply-1")).resolves.toBe(true);
        await expect(admit("reply-1")).resolves.toBe(false);
    });

    it("the next reply is admitted on its own claim", async () => {
        await admit("reply-1");

        await expect(admit("reply-2")).resolves.toBe(true);
    });

    it("a locked thread is not admitted", async () => {
        const locked = await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, lockedAt: 1000, status: "active", title: "L", updatedAt: 1, userId: OWNER }),
        );

        await expect(admit("reply-1", locked)).resolves.toBe(false);
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
});
