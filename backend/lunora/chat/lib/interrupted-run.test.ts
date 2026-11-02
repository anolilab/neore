import { describe, expect, it, vi } from "vitest";

import { MAX_INTERRUPTION_RESUMES, planInterruption, RUN_STALE_MS, type SavedRow, type SavedRun, settleSavedRows } from "./interrupted-run";

const row = (id: string, over: Partial<SavedRow> = {}): SavedRow => {return {
    callsTools: false,
    empty: false,
    id,
    order: 1,
    role: "assistant",
    status: "success",
    stepOrder: 0,
    ...over,
}};

describe("settleSavedRows", () => {
    it("continues from the last saved row and counts the steps that finished", () => {
        const saved = settleSavedRows([
            row("b", { callsTools: false, role: "tool", stepOrder: 1 }),
            row("a", { callsTools: true, stepOrder: 0 }),
            row("c", { stepOrder: 2 }),
        ]);

        expect(saved).toStrictEqual({ from: "c", ok: true, placeholders: [], replyRowIds: ["a", "b", "c"], stepsUsed: 2 });
    });

    it("continues from the prompt when nothing was saved, and sets the dead step's empty placeholder aside", () => {
        expect(settleSavedRows([row("p", { empty: true, status: "pending" })])).toStrictEqual({
            from: undefined,
            ok: true,
            placeholders: ["p"],
            replyRowIds: [],
            stepsUsed: 0,
        });
    });

    it("refuses a row that is neither finished nor an empty placeholder", () => {
        expect(settleSavedRows([row("a"), row("b", { empty: false, status: "pending", stepOrder: 1 })])).toStrictEqual({ ok: false, reason: "unsettled_row" });
    });

    it("refuses a trailing tool call whose result was not saved: a resume would answer it twice", () => {
        expect(settleSavedRows([row("a", { callsTools: true })])).toStrictEqual({ ok: false, reason: "tool_call_without_result" });
    });
});

describe("planInterruption", () => {
    const saved: SavedRun = { from: "a", ok: true, placeholders: [], replyRowIds: ["a"], stepsUsed: 1 };
    const dead = { beatAt: 0, interruptions: 0, now: RUN_STALE_MS, saved, steerDelivered: false, toolsInFlight: 0 };

    it("waits while the beat is fresh", () => {
        expect(planInterruption({ ...dead, now: RUN_STALE_MS - 1 })).toStrictEqual({ action: "wait" });
    });

    it("resumes a dead run, three times", () => {
        for (let interruptions = 0; interruptions < MAX_INTERRUPTION_RESUMES; interruptions += 1) {
            expect(planInterruption({ ...dead, interruptions })).toStrictEqual({ action: "resume" });
        }
    });

    it("fails the fourth interruption", () => {
        expect(planInterruption({ ...dead, interruptions: MAX_INTERRUPTION_RESUMES })).toStrictEqual({ action: "fail", reason: "too_many_interruptions" });
    });

    it("fails a run that died inside a tool, or after a steered message, or on rows it cannot read", () => {
        expect(planInterruption({ ...dead, toolsInFlight: 1 })).toStrictEqual({ action: "fail", reason: "tool_in_flight" });
        expect(planInterruption({ ...dead, steerDelivered: true })).toStrictEqual({ action: "fail", reason: "steered" });
        expect(planInterruption({ ...dead, saved: { ok: false, reason: "unsettled_row" } })).toStrictEqual({ action: "fail", reason: "unsettled_row" });
    });
});

describe("markToolRuns", () => {
    it("marks a tool before it runs and unmarks it after, even when it throws", async () => {
        vi.resetModules();
        vi.doMock("../../_generated/internal", () => {return {
            internal: { chat: { streaming: { persistent: { interrupted: { markToolRun: "mark" } } } } },
        }});

        const { markToolRuns } = await import("./mark-tool-runs");
        const calls: string[] = [];
        const ctx = {
            runMutation: vi.fn(async (_ref: unknown, args: { delta: number }) => {
                calls.push(`mark${args.delta > 0 ? "+" : "-"}`);
            }),
        };
        const tools = markToolRuns(ctx as never, "stream-1", {
            boom: {
                execute: async () => {
                    calls.push("run");

                    throw new Error("nope");
                },
            },
            ok: {
                execute: async () => {
                    calls.push("run");

                    return "fine";
                },
            },
            passive: { description: "no execute" },
        } as never) as Record<string, { execute?: () => Promise<unknown> }>;

        expect(await tools.ok!.execute!()).toBe("fine");
        await expect(tools.boom!.execute!()).rejects.toThrow("nope");
        expect(tools.passive!.execute).toBeUndefined();
        expect(calls).toStrictEqual(["mark+", "run", "mark-", "mark+", "run", "mark-"]);

        // A refused mark (the stream ended) stops the tool from running unmarked.
        calls.length = 0;
        ctx.runMutation.mockRejectedValueOnce(new Error("The stream is no longer live"));
        await expect(tools.ok!.execute!()).rejects.toThrow("no longer live");
        expect(calls).toStrictEqual([]);

        vi.doUnmock("../../_generated/internal");
    });
});
