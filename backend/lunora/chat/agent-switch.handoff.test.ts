/**
 * A switch with a handoff (plans/harness-switch.md, S2), driven against the real schema: the mode a switch
 * defaults to, the summary charged once, a failed write that leaves nothing behind, a handoff that cannot fit,
 * and a switch back that sends only what the model missed.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentSwitchOf } from "../agent/agent-switch-logic";
import { handoffAboveOf } from "../agent/agent-switch";
import { HANDOFF_REFUSED_TOO_LARGE, HANDOFF_BUDGET_TOKENS, handoffTokens } from "../agent/handoff";
import { assembleHandoffContext } from "../agent/handoff-context";
import { hasClaim } from "../lib/claim-once";
import { createRatelimit } from "../lib/rate-limiter";
import schema from "../schema";
import { previewAgentSwitchHandler, planAgentSwitchHandler, runAgentSwitch, switchThreadAgentHandler, type Summarise } from "./agent-switch";

type Harness = ReturnType<typeof lunoraTest>;

// Three text models on the free tier, so no plan lookup runs.
const A = "openai/gpt-4.1-mini";
const B = "google/gemini-2.0-flash-001";

const QUOTA = "chat/dailyText:free";
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

const remaining = async (): Promise<number> =>
    await run(async (ctx) => {
        const { remaining: left } = await createRatelimit(QUOTA, ctx.db as never).getRemaining(owner);

        return left;
    });

const summaryCalls = vi.fn<Summarise>();

const runner = {
    runMutation: async (_reference: unknown, args: any) => await run(async (ctx) => await switchThreadAgentHandler(ctx, args)),
    runQuery: async (_reference: unknown, args: any) => await run(async (ctx) => await planAgentSwitchHandler(ctx, args)),
};

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

    it("is charged once: a repeat of the click neither summarises nor charges again", async () => {
        const before = await remaining();

        await switchTo(B, "click-1");
        const replay = await switchTo(B, "click-1");

        expect(replay).toMatchObject({ messageId: null, switched: false });
        expect(summaryCalls).toHaveBeenCalledTimes(1);
        expect(await dividers()).toHaveLength(1);
        expect(await remaining()).toBe(before - 1);
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

    it("fails the same way when the summary outgrows what it was given", async () => {
        summaryCalls.mockResolvedValue("s".repeat(HANDOFF_BUDGET_TOKENS * 4));

        const before = await remaining();

        await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: HANDOFF_REFUSED_TOO_LARGE } });
        expect(await remaining()).toBe(before);
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

        expect(never).toBeNull();

        await switchTo(B, "click-1", "portable");
        await addTurn("later question", "later answer");

        const all = await rows();
        const above = await run(
            async (ctx) => await handoffAboveOf(ctx, { belowMessageId: all.find((row) => row.text === "later question")!._id, threadId: threadId as never }),
        );

        expect(above).toBe(all.map((row) => agentSwitchOf(row)).find(Boolean)!.handoff);
    });
});
