/**
 * A switch with a handoff (plans/harness-switch.md, S2), driven against the real schema: the mode a switch
 * defaults to, the summary charged once, a failed write that leaves nothing behind, a handoff that cannot fit,
 * and a switch back that sends only what the model missed.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentSwitchOf } from "../agent/agent-switch-logic";
import { handoffAboveOf, handoffBeforeDeltaOf } from "../agent/agent-switch";
import { collectHandoffSource } from "../agent/handoff-source";
import { HANDOFF_REFUSED_TOO_LARGE, HANDOFF_BUDGET_TOKENS, HANDOFF_SUMMARY_MAX_TOKENS, handoffLimitsFor, handoffTokens } from "../agent/handoff";
import { assembleHandoffContext } from "../agent/handoff-context";
import { hasClaim, releaseClaim } from "../lib/claim-once";
import { createRatelimit } from "../lib/rate-limiter";
import schema from "../schema";
import {
    beginSwitchSummaryHandler,
    previewAgentSwitchHandler,
    planAgentSwitchHandler,
    runAgentSwitch,
    switchThreadAgentHandler,
    type Summarise,
} from "./agent-switch";

// A model whose window a test sets: the registry's models all have 128k or more, which no handoff budget has to shrink for.
const { windows } = vi.hoisted(() => {
    return { windows: new Map<string, number>() };
});

vi.mock(import("./lib/auto-continue"), async (importOriginal) => {
    const original = await importOriginal();

    return { ...original, getModelContextWindow: (modelId: string) => windows.get(modelId) ?? original.getModelContextWindow(modelId) };
});

type Harness = ReturnType<typeof lunoraTest>;

// Three text models on the free tier, so no plan lookup runs.
const A = "openai/gpt-4.1-mini";
const B = "google/gemini-2.0-flash-001";
const C = "openai/gpt-4.1-nano";

const QUOTA = "chat/dailyText:free";
const TASK_QUOTA = "tasks/dailyRuns:free";
const PAIR = 2000;

let harness: Harness;
let owner: string;
let threadId: string;
let order = 0;

const run = async <T>(body: (ctx: any) => Promise<T>): Promise<T> => await harness.run(body);

const addRow = async (role: "assistant" | "user", value: string) => {
    const message = role === "user" ? { content: value, role } : { content: [{ text: value, type: "text" as const }], role };
    const index = order;

    order += role === "user" ? 0 : 1;

    return await run(
        async (ctx) =>
            await ctx.db.insert("messages", {
                message,
                order: index,
                status: "success",
                stepOrder: role === "user" ? 0 : 1,
                text: value,
                threadId,
                tool: false,
                userId: owner,
            }),
    );
};

const addTurn = async (user: string, assistant: string) => {
    await addRow("user", user);
    await addRow("assistant", assistant);
};

/** `pairs` question/answer turns of `PAIR` characters each way. */
const longThread = async (pairs: number) => {
    for (let index = 0; index < pairs; index += 1) {
        await addTurn(`question ${index} ${"q".repeat(PAIR)}`, `answer ${index} ${"a".repeat(PAIR)}`);
    }
};

const remaining = async (key = QUOTA): Promise<number> =>
    await run(async (ctx) => {
        const { remaining: left } = await createRatelimit(key, ctx.db as never).getRemaining(owner);

        return left;
    });

const summaryCalls = vi.fn<Summarise>();

const runner = {
    runMutation: async (reference: any, args: any) =>
        await run(async (ctx) => {
            switch (reference.__lunoraRef) {
                case "chat_agent_switch:beginSwitchSummary": {
                    return await beginSwitchSummaryHandler(ctx, args);
                }
                case "lib_claim_once:releaseKey": {
                    return await releaseClaim(ctx, args.scope, args.key, args.claimedAt);
                }
                default: {
                    return await switchThreadAgentHandler(ctx, args);
                }
            }
        }),
    runQuery: async (reference: any, args: any) =>
        // Not a coding-agent thread: the routing question `runAgentSwitch` asks first (`acp/switch.ts`).
        reference.__lunoraRef === "acp_switch:isHostSwitchSource" ? false : await run(async (ctx) => await planAgentSwitchHandler(ctx, args)),
};

const summaryClaim = async (): Promise<boolean> => await run(async (ctx) => await hasClaim(ctx, "switch-summary", threadId));

const switchTo = async (model: string, clientId: string, mode?: "full" | "portable") => {
    const result = await runAgentSwitch(
        runner,
        { clientId, ...(mode && { mode }), target: { kind: "model", model }, threadId: threadId as never, userId: owner },
        summaryCalls,
    );

    // The divider takes the next order; the rows that follow come after it.
    order += result.switched ? 1 : 0;

    return result;
};

const rows = async (): Promise<any[]> => {
    const all: any[] = await run(async (ctx) => await ctx.db.query("messages").collect());

    return all.toSorted((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);
};
const dividers = async () => {
    const all = await rows();

    return all.map((row) => agentSwitchOf(row)).filter((part) => part !== undefined);
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    owner = await run(
        async (ctx) => await ctx.db.insert("user", { createdAt: 1, email: "owner@example.com", emailVerified: true, name: "Owner", updatedAt: 1 }),
    );
    threadId = await run(async (ctx) => await ctx.db.insert("threads", { model: A, status: "active", title: "T", userId: owner }));
    order = 0;
    summaryCalls.mockReset();
    summaryCalls.mockResolvedValue("The user and the assistant went through a long run of questions and answers.");
});

afterEach(() => {
    harness.close();
    windows.clear();
});

describe("a switch above the cold-start threshold", () => {
    beforeEach(async () => {
        // 30 turns of 4,000 characters: 30k tokens, past the 20k threshold.
        await longThread(30);
        await addTurn("the last question, verbatim", "the last answer, verbatim");
    });

    it("defaults to a portable handoff: a summary of the older turns and the recent ones verbatim, inside the budget", async () => {
        const before = await remaining();
        const result = await switchTo(B, "click-1");
        const [part] = await dividers();

        expect(result).toMatchObject({ agent: { kind: "model", model: B }, coldStartCostly: true, switched: true });
        expect(part).toMatchObject({ mode: "portable", summarized: true, to: { kind: "model", model: B } });
        expect(summaryCalls).toHaveBeenCalledTimes(1);
        expect(summaryCalls.mock.calls[0]![0].length).toBeGreaterThan(0);
        expect(handoffTokens(part!.handoff!)).toBeLessThanOrEqual(HANDOFF_BUDGET_TOKENS);
        expect(part!.handoff).toContain("> the last question, verbatim");
        expect(part!.handoff).toContain("> The user and the assistant went through");
        expect(await remaining()).toBe(before - 1);
    });

    it("spends the chat allowance only, never a daily task run", async () => {
        const tasksBefore = await remaining(TASK_QUOTA);

        await switchTo(B, "click-1");

        expect(await remaining(TASK_QUOTA)).toBe(tasksBefore);
    });

    it("is charged once: a repeat of the click neither summarises nor charges again", async () => {
        const before = await remaining();

        await switchTo(B, "click-1");
        const replay = await switchTo(B, "click-1");

        expect(replay).toMatchObject({ messageId: null, switched: false });
        expect(summaryCalls).toHaveBeenCalledTimes(1);
        expect(await dividers()).toHaveLength(1);
        expect(await remaining()).toBe(before - 1);
    });

    it("does not undo a later switch when an old click is replayed: no summary, no charge, no divider", async () => {
        await switchTo(B, "click-1");
        await addTurn("question for model B", "answer from model B");
        await switchTo(C, "click-2", "full");

        const before = await remaining();
        // The thread is on C now: only the claim of click-1 stops this one from switching back to B.
        const replay = await switchTo(B, "click-1");

        expect(replay).toMatchObject({ agent: { model: C }, messageId: null, switched: false });
        expect(summaryCalls).toHaveBeenCalledTimes(1);
        expect(await dividers()).toHaveLength(2);
        expect(await remaining()).toBe(before);
    });

    it("leaves no claim and no charge behind when the write fails, so the retry goes through", async () => {
        const before = await remaining();
        const plan = await run(
            async (ctx) =>
                await planAgentSwitchHandler(ctx, { clientId: "click-1", target: { kind: "model", model: B }, threadId: threadId as never, userId: owner }),
        );
        const key = `${owner}:${threadId}:click-1`;

        // A divider can store 80,000 characters at most: the write fails AFTER the claim and the charge.
        await expect(
            run(
                async (ctx) =>
                    await switchThreadAgentHandler(ctx, {
                        clientId: "click-1",
                        expectedLeafId: plan.leafId,
                        handoff: { mode: "portable", summarized: true, text: "x".repeat(80_001) },
                        target: { kind: "model", model: B },
                        threadId: threadId as never,
                        userId: owner,
                    }),
            ),
        ).rejects.toThrow();

        expect(await run(async (ctx) => await hasClaim(ctx, "switch", key))).toBe(false);
        expect(await remaining()).toBe(before);
        expect(await dividers()).toHaveLength(0);

        expect(await switchTo(B, "click-1")).toMatchObject({ switched: true });
        expect(await remaining()).toBe(before - 1);
    });

    it("refuses a daily limit that is spent without writing, and leaves the claim free", async () => {
        await run(async (ctx) => {
            const limiter = createRatelimit(QUOTA, ctx.db as never);

            let { remaining: left } = await limiter.getRemaining(owner);

            while (left > 0) {
                await limiter.limit(owner);
                ({ remaining: left } = await limiter.getRemaining(owner));
            }
        });

        await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: "AGENT_SWITCH_LIMIT" } });
        // Refused before the summary is paid for, not only at the write.
        expect(summaryCalls).not.toHaveBeenCalled();
        expect(await summaryClaim()).toBe(false);
        expect(await dividers()).toHaveLength(0);
        expect(await run(async (ctx) => await hasClaim(ctx, "switch", `${owner}:${threadId}:click-1`))).toBe(false);
    });

    it("keeps the full history when asked to, and charges nothing", async () => {
        const before = await remaining();

        expect(await switchTo(B, "click-1", "full")).toMatchObject({ switched: true });
        expect(summaryCalls).not.toHaveBeenCalled();
        const [part] = await dividers();

        expect(part).toMatchObject({ mode: "full" });
        expect(part!.handoff).toBeUndefined();
        expect(await remaining()).toBe(before);
    });

    it("fails with a message and charges nothing when the latest message alone cannot fit the handoff", async () => {
        await addRow("user", "short question");
        await addRow("assistant", "y".repeat(HANDOFF_BUDGET_TOKENS * 4 + 500));

        const before = await remaining();

        await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: HANDOFF_REFUSED_TOO_LARGE } });
        expect(summaryCalls).not.toHaveBeenCalled();
        expect(await remaining()).toBe(before);
        expect(await dividers()).toHaveLength(0);
    });

    it("cuts a summary that outgrows what it was given, instead of failing the switch", async () => {
        summaryCalls.mockResolvedValue(Array.from({ length: 4000 }, (_, index) => `point ${index}`).join("\n"));

        expect(await switchTo(B, "click-1")).toMatchObject({ switched: true });

        const [part] = await dividers();

        expect(handoffTokens(part!.handoff!)).toBeLessThanOrEqual(HANDOFF_BUDGET_TOKENS);
        expect(part!.handoff).toContain("> point 0");
        expect(part!.handoff).not.toContain("> point 3999");
        expect(HANDOFF_SUMMARY_MAX_TOKENS).toBeLessThan(HANDOFF_BUDGET_TOKENS);
    });

    it("summarises once when two clicks with different ids arrive together: the second is told one is under way", async () => {
        const gates: ((text: string) => void)[] = [];

        summaryCalls.mockImplementationOnce(
            async () =>
                await new Promise<string>((resolve) => {
                    gates.push(resolve);
                }),
        );

        const before = await remaining();
        const first = switchTo(B, "click-1");

        await vi.waitFor(() => expect(summaryCalls).toHaveBeenCalledTimes(1));
        expect(await summaryClaim()).toBe(true);

        await expect(switchTo(B, "click-2")).rejects.toMatchObject({ data: { code: "AGENT_SWITCH_BUSY" } });

        gates[0]!("The summary of the older turns.");

        expect(await first).toMatchObject({ switched: true });
        expect(summaryCalls).toHaveBeenCalledTimes(1);
        expect(await dividers()).toHaveLength(1);
        expect(await remaining()).toBe(before - 1);
        // Given back after the commit, so the thread is free for the next switch.
        expect(await summaryClaim()).toBe(false);
    });

    it("frees the thread when the summary call fails, so the retry summarises", async () => {
        summaryCalls.mockRejectedValueOnce(new Error("gateway down"));

        await expect(switchTo(B, "click-1")).rejects.toThrow("gateway down");
        expect(await summaryClaim()).toBe(false);
        expect(await switchTo(B, "click-2")).toMatchObject({ switched: true });
        expect(summaryCalls).toHaveBeenCalledTimes(2);
    });

    it("counts each summary against its own rate limit, and refuses past it before calling the model", async () => {
        await run(async (ctx) => {
            const limiter = createRatelimit("chat/agentSwitchSummary:free", ctx.db as never);

            for (let index = 0; index < 5; index += 1) {
                await limiter.limit(owner);
            }
        });

        await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: "AGENT_SWITCH_RATE_LIMITED" } });
        expect(summaryCalls).not.toHaveBeenCalled();
        expect(await summaryClaim()).toBe(false);
        expect(await dividers()).toHaveLength(0);
    });

    it("refuses a path that moved between the plan and the write, instead of describing the wrong one", async () => {
        const plan = await run(
            async (ctx) =>
                await planAgentSwitchHandler(ctx, { clientId: "click-1", target: { kind: "model", model: B }, threadId: threadId as never, userId: owner }),
        );

        await addTurn("a newer question", "a newer answer");

        await expect(
            run(
                async (ctx) =>
                    await switchThreadAgentHandler(ctx, {
                        clientId: "click-1",
                        expectedLeafId: plan.leafId,
                        target: { kind: "model", model: B },
                        threadId: threadId as never,
                        userId: owner,
                    }),
            ),
        ).rejects.toMatchObject({ data: { code: "AGENT_SWITCH_STALE" } });
    });

    it("previews the cost before anything is written: the whole history against the handoff", async () => {
        const preview = await run(async (ctx) => await previewAgentSwitchHandler(ctx, { model: B, threadId: threadId as never, userId: owner }));

        expect(preview).toMatchObject({ alreadyThere: false, coldStartCostly: true, defaultMode: "portable" });
        expect(preview.contextTokens).toBeGreaterThan(30_000);
        expect(preview.handoffTokens).toBeLessThanOrEqual(HANDOFF_BUDGET_TOKENS);
        expect(await dividers()).toHaveLength(0);
    });
});

describe("the source of a handoff", () => {
    it("stops at its limit inside a page of large messages instead of taking the whole page", async () => {
        // Five turns of 100,000 characters each way sit in one page, against a limit of 240,000.
        for (let index = 0; index < 5; index += 1) {
            await addTurn(`q${index} ${"q".repeat(100_000)}`, `a${index} ${"a".repeat(100_000)}`);
        }

        const source = await run(async (ctx) => {
            const thread = await ctx.db.get("threads", threadId);
            const all: any[] = await ctx.db.query("messages").collect();
            const [leaf] = all.toSorted((a, b) => b.order - a.order || b.stepOrder - a.stepOrder);

            return await collectHandoffSource(ctx, thread._id, leaf);
        });
        const characters = source.turns.reduce((sum, turn) => sum + turn.text.length, 0);

        expect(characters).toBeLessThan(400_000);
        expect(source.omittedEarlier).toBe(true);
    });
});

describe("the cost preview of a long thread", () => {
    it("prices keeping the history from the rows a reply reads, not the whole path", async () => {
        // 150 rows of about 500 tokens: the whole path is 75k tokens, the last 100 rows 50k.
        await longThread(75);

        const preview = await run(async (ctx) => await previewAgentSwitchHandler(ctx, { model: B, threadId: threadId as never, userId: owner }));

        expect(preview.coldStartCostly).toBe(true);
        expect(preview.contextTokens).toBeLessThan(55_000);
        expect(preview.contextTokens).toBeGreaterThan(45_000);
    });
});

describe("a switch below the cold-start threshold", () => {
    beforeEach(async () => {
        await addTurn("hello", "hi");
    });

    it("gives the new model the whole history, as in S1, with no summary and no charge", async () => {
        const before = await remaining();

        await switchTo(B, "click-1");
        const [part] = await dividers();

        expect(part).toMatchObject({ mode: "full" });
        expect(summaryCalls).not.toHaveBeenCalled();
        expect(await remaining()).toBe(before);
    });

    it("hands over without a summary call when the user asks for it and the thread fits whole", async () => {
        const before = await remaining();

        await switchTo(B, "click-1", "portable");
        const [part] = await dividers();

        expect(part).toMatchObject({ mode: "portable", summarized: false });
        expect(part!.handoff).toContain("> hello");
        expect(summaryCalls).not.toHaveBeenCalled();
        expect(await remaining()).toBe(before);
    });

    it("previews a short thread as costing the same either way, and not costly", async () => {
        const preview = await run(async (ctx) => await previewAgentSwitchHandler(ctx, { model: B, threadId: threadId as never, userId: owner }));

        expect(preview).toMatchObject({ coldStartCostly: false, defaultMode: "full" });
        expect(preview.handoffTokens).toBe(preview.contextTokens);
    });
});

describe("switching back", () => {
    it("hands over only what the model missed, and the context keeps what it saw", async () => {
        await addTurn("first question of the model A era", "first answer of the model A era");
        await switchTo(B, "click-1", "portable");
        await addTurn("question for model B", "answer from model B");
        await switchTo(A, "click-2", "portable");

        const [toB, back] = await dividers();

        expect(toB).toMatchObject({ mode: "portable", to: { model: B } });
        expect(back).toMatchObject({ mode: "delta", to: { model: A } });
        // Only what came after the last message A saw.
        expect(back!.handoff).toContain("> question for model B");
        expect(back!.handoff).toContain("> answer from model B");
        expect(back!.handoff).not.toContain("first question of the model A era");
        expect(back!.handoff).toContain("You worked on this conversation earlier");

        await addTurn("and now back on A", "reply");

        const { blocks, docs } = assembleHandoffContext(await rows());
        const seen = docs.map((doc: any) => (typeof doc.message.content === "string" ? doc.message.content : doc.message.content[0].text));

        expect(seen).toStrictEqual(["first question of the model A era", "first answer of the model A era", "and now back on A", "reply"]);
        expect(blocks).toStrictEqual([{ before: 2, text: back!.handoff }]);
    });

    it("hands over portably when the model's earlier context has left the context window", async () => {
        await addTurn("first question of the model A era", "first answer of the model A era");
        await switchTo(B, "click-1", "portable");

        for (let index = 0; index < 60; index += 1) {
            await addTurn(`question ${index} for model B`, `answer ${index} from model B`);
        }

        await switchTo(A, "click-2", "portable");

        const [, back] = await dividers();

        expect(back).toMatchObject({ mode: "portable", to: { model: A } });
        expect(back!.handoff).toContain("You are taking over a conversation part-way");
    });

    it("restores what the model saw, with no handoff message, when nothing happened since it left", async () => {
        await addTurn("first question of the model A era", "first answer of the model A era");
        await switchTo(B, "click-1", "portable");
        await switchTo(A, "click-2", "portable");

        const [, back] = await dividers();

        expect(back).toMatchObject({ mode: "delta", to: { model: A } });
        expect(back!.handoff).toBeUndefined();

        await addTurn("and now back on A", "reply");

        const { blocks, docs } = assembleHandoffContext(await rows());

        expect(blocks).toStrictEqual([]);
        expect(docs.map((doc: any) => doc.text).filter(Boolean)).toStrictEqual([
            "first question of the model A era",
            "first answer of the model A era",
            "and now back on A",
            "reply",
        ]);
    });

    it("keeps the first half for the model that left, after the divider it left through has slid out of the window", async () => {
        await addTurn("first question of the model A era", "first answer of the model A era");
        await switchTo(B, "click-1", "portable");
        await addTurn("question for model B", "answer from model B");
        await switchTo(A, "click-2", "portable");

        const [toB, back] = await dividers();

        expect(back).toMatchObject({ mode: "delta" });

        for (let index = 0; index < 60; index += 1) {
            await addTurn(`question ${index} for model A`, `answer ${index} from model A`);
        }

        const all = await rows();
        const late = all.at(-3)!;
        const dividerRow = all.find((row) => agentSwitchOf(row)?.mode === "delta")!;
        const above = await run(async (ctx) => await handoffAboveOf(ctx, { belowMessageId: late._id, threadId: threadId as never }));
        const before = await run(async (ctx) => await handoffBeforeDeltaOf(ctx, { dividerMessageId: dividerRow._id, threadId: threadId as never }));

        // A's first half stands in as the handoff of the divider it left through, then what it missed.
        expect(before).toStrictEqual([toB!.handoff]);
        expect(above).toStrictEqual([toB!.handoff, back!.handoff]);
    });

    it("previews a switch back as the old context plus the handoff of what came since", async () => {
        await longThread(30);
        await switchTo(B, "click-1");
        await addTurn("question for model B", "answer from model B");

        const preview = await run(async (ctx) => await previewAgentSwitchHandler(ctx, { model: A, threadId: threadId as never, userId: owner }));

        // A saw everything up to the switch (30k tokens); B's turn is the only delta.
        expect(preview.handoffTokens).toBeLessThan(preview.contextTokens + 1);
        expect(preview.coldStartCostly).toBe(true);
    });
});

describe("a window that starts below the divider", () => {
    it("finds the newest stored handoff above it, and nothing for a thread that was never switched", async () => {
        await addTurn("hello", "hi");
        const [, answer] = await rows();
        const answered = answer._id;
        const never = await run(async (ctx) => await handoffAboveOf(ctx, { belowMessageId: answered, threadId: threadId as never }));

        expect(never).toStrictEqual([]);

        await switchTo(B, "click-1", "portable");
        await addTurn("later question", "later answer");

        const all = await rows();
        const above = await run(
            async (ctx) => await handoffAboveOf(ctx, { belowMessageId: all.find((row) => row.text === "later question")!._id, threadId: threadId as never }),
        );

        expect(above).toStrictEqual([all.map((row) => agentSwitchOf(row)).find(Boolean)!.handoff]);
    });
    it("marks only a thread a switch stored a handoff on, so one switched with its full history walks nothing", async () => {
        const handoffFlag = async () =>
            await run(async (ctx) => ((await ctx.db.get("threads", threadId as never)) as { hasHandoff?: boolean } | null)?.hasHandoff);

        await addTurn("hello", "hi");
        await switchTo(B, "click-1", "full");
        await addTurn("later question", "later answer");

        const all = await rows();
        const below = all.find((row) => row.text === "later question")!._id;

        expect(await handoffFlag()).toBeUndefined();
        expect(await run(async (ctx) => await handoffAboveOf(ctx, { belowMessageId: below, threadId: threadId as never }))).toStrictEqual([]);

        await switchTo(A, "click-2", "portable");

        expect(await handoffFlag()).toBe(true);
    });
});

describe("a switch to a model with a small context window", () => {
    const SMALL_WINDOW = 6000;

    beforeEach(async () => {
        windows.set(C, SMALL_WINDOW);

        // 12 turns of 2,000 characters: 6k tokens. Well under the cold-start threshold, so the history would go whole
        // to a big model, but it does not fit the small one beside a reply.
        for (let index = 0; index < 12; index += 1) {
            await addTurn(`question ${index} ${"q".repeat(900)}`, `answer ${index} ${"a".repeat(900)}`);
        }
    });

    it("hands over a summary inside a budget derived from the window, instead of the whole history", async () => {
        const limits = handoffLimitsFor(SMALL_WINDOW);
        const result = await switchTo(C, "click-1");
        const [part] = await dividers();

        expect(result).toMatchObject({ agent: { model: C }, switched: true });
        expect(part).toMatchObject({ mode: "portable", summarized: true });
        expect(limits.budgetTokens).toBeLessThan(HANDOFF_BUDGET_TOKENS);
        expect(handoffTokens(part!.handoff!)).toBeLessThanOrEqual(limits.budgetTokens);
        expect(summaryCalls).toHaveBeenCalledWith(expect.any(Array), expect.any(Boolean), limits);
    });

    it("cuts a summary that outgrows the smaller allotment", async () => {
        const limits = handoffLimitsFor(SMALL_WINDOW);

        summaryCalls.mockResolvedValue(Array.from({ length: 4000 }, (_, index) => `point ${index}`).join("\n"));

        expect(await switchTo(C, "click-1")).toMatchObject({ switched: true });

        const [part] = await dividers();

        expect(handoffTokens(part!.handoff!)).toBeLessThanOrEqual(limits.budgetTokens);
        expect(part!.handoff).not.toContain("> point 3999");
    });

    it("keeps the whole history for a model whose window holds it", async () => {
        expect(await switchTo(B, "click-1")).toMatchObject({ switched: true });
        expect(await dividers()).toMatchObject([{ mode: "full" }]);
        expect(summaryCalls).not.toHaveBeenCalled();
    });

    it("hands over even when the whole history was asked for, rather than overflow the window", async () => {
        expect(await switchTo(C, "click-1", "full")).toMatchObject({ switched: true });
        expect(await dividers()).toMatchObject([{ mode: "portable", summarized: true }]);
    });

    it("previews a handoff as the default for it, within its own budget", async () => {
        const preview = await run(async (ctx) => await previewAgentSwitchHandler(ctx, { model: C, threadId: threadId as never, userId: owner }));

        expect(preview).toMatchObject({ coldStartCostly: false, defaultMode: "portable" });
        expect(preview.handoffTokens).toBeLessThanOrEqual(handoffLimitsFor(SMALL_WINDOW).budgetTokens);
    });
});

describe("whether the target is sent the history whole", () => {
    const SMALL_WINDOW = 6000;

    beforeEach(() => {
        windows.set(C, SMALL_WINDOW);
    });

    const addImageRow = async (): Promise<void> => {
        const index = order;

        order += 0;
        await run(
            async (ctx) =>
                await ctx.db.insert("messages", {
                    message: { content: [{ image: "storage:an-image", type: "image" as const }], role: "user" },
                    order: index,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    tool: false,
                    userId: owner,
                }),
        );
        // The next row is a new turn.
        order += 1;
    };

    it("counts the stored handoff a short thread is sent in front of its rows", async () => {
        // A long thread handed over once: its handoff weighs about 10k tokens and stands in for all of it.
        await longThread(30);
        await switchTo(B, "click-1", "portable");

        // More rows than a reply reads, so the divider is above the window; each is tiny.
        for (let index = 0; index < 60; index += 1) {
            await addTurn(`q${index}`, `a${index}`);
        }

        await switchTo(C, "click-2", "full");

        const [, toC] = await dividers();

        expect(toC).toMatchObject({ mode: "portable", to: { model: C } });
    });

    it("counts images and files, which have no text", async () => {
        for (let index = 0; index < 8; index += 1) {
            await addImageRow();
            await addRow("assistant", "a picture");
        }

        await switchTo(C, "click-1", "full");

        expect(await dividers()).toMatchObject([{ mode: "portable" }]);
    });

    it("does not restore a model's earlier context as a delta when that context overflows its window", async () => {
        await addTurn("hello", "hi");
        await switchTo(C, "click-1", "full");
        await switchTo(B, "click-2", "full");

        // Under the cold-start threshold, so the history would go whole to a big model, but not to C.
        for (let index = 0; index < 12; index += 1) {
            await addTurn(`question ${index} ${"q".repeat(900)}`, `answer ${index} ${"a".repeat(900)}`);
        }

        await switchTo(C, "click-3");

        expect(await dividers()).toMatchObject([{ mode: "full" }, { mode: "full" }, { mode: "portable", to: { model: C } }]);
    });
});
