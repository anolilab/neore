import { describe, expect, it, vi } from "vitest";

import { MAX_INTERRUPTION_RESUMES, planInterruption, RUN_STALE_MS, type SavedRow, type SavedRun, settleSavedRows } from "./interrupted-run";

const row = (id: string, over: Partial<SavedRow> = {}): SavedRow => {
    return {
        callsTools: false,
        empty: false,
        id,
        order: 1,
        role: "assistant",
        status: "success",
        stepOrder: 0,
        ...over,
    };
};

describe("settleSavedRows", () => {
    it("continues from the last saved row and counts the steps that finished", () => {
        const saved = settleSavedRows([
            row("b", { callsTools: false, role: "tool", stepOrder: 1 }),
            row("a", { callsTools: true, stepOrder: 0 }),
            row("c", { stepOrder: 2 }),
        ]);

        expect(saved).toStrictEqual({ finished: true, from: "c", ok: true, placeholders: [], replyRowIds: ["a", "b", "c"], stepsUsed: 2 });
    });

    it("continues from the prompt when nothing was saved, and sets the dead step's empty placeholder aside", () => {
        expect(settleSavedRows([row("p", { empty: true, status: "pending" })])).toStrictEqual({
            finished: false,
            from: undefined,
            ok: true,
            placeholders: ["p"],
            replyRowIds: [],
            stepsUsed: 0,
        });
    });

    it("refuses a row that is neither finished nor an empty placeholder", () => {
        expect(settleSavedRows([row("a"), row("b", { empty: false, status: "pending", stepOrder: 1 })])).toStrictEqual({
            ok: false,
            reason: "unsettled_row",
            replyRowIds: ["a"],
        });
    });

    it("refuses a trailing tool call whose result was not saved: a resume would answer it twice", () => {
        expect(settleSavedRows([row("a", { callsTools: true })])).toStrictEqual({ ok: false, reason: "tool_call_without_result", replyRowIds: ["a"] });
    });
});

describe("planInterruption", () => {
    const saved: SavedRun = { finished: false, from: "a", ok: true, placeholders: [], replyRowIds: ["a"], stepsUsed: 1 };
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

    it("finishes a run that saved its whole answer instead of asking the model again", () => {
        expect(planInterruption({ ...dead, saved: { ...saved, finished: true } })).toStrictEqual({ action: "finish" });
        expect(planInterruption({ ...dead, now: RUN_STALE_MS - 1, saved: { ...saved, finished: true } })).toStrictEqual({ action: "wait" });
    });

    it("fails a run that died inside a tool, or after a steered message, or on rows it cannot read", () => {
        expect(planInterruption({ ...dead, toolsInFlight: 1 })).toStrictEqual({ action: "fail", reason: "tool_in_flight" });
        expect(planInterruption({ ...dead, steerDelivered: true })).toStrictEqual({ action: "fail", reason: "steered" });
        expect(planInterruption({ ...dead, saved: { ok: false, reason: "unsettled_row", replyRowIds: [] } })).toStrictEqual({
            action: "fail",
            reason: "unsettled_row",
        });
    });
});

describe("createToolRunMarker", () => {
    const setup = async () => {
        vi.resetModules();
        vi.doMock("../../_generated/internal", () => {
            return {
                internal: { chat: { streaming: { persistent: { interrupted: { markToolRun: "mark" } } } } },
            };
        });

        const { createToolRunMarker } = await import("./mark-tool-runs");
        const calls: string[] = [];
        const onReplaced = vi.fn();
        const ctx = {
            runMutation: vi.fn(async (_ref: unknown, args: { delta: number; epoch: number }) => {
                calls.push(`mark${args.delta > 0 ? "+" : "-"}${Math.abs(args.delta)}@${args.epoch}`);
            }),
        };
        const marker = createToolRunMarker(ctx as never, { epoch: 2, onReplaced, streamId: "stream-1" });
        const tools = marker.wrap({
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

        return { calls, ctx, marker, onReplaced, tools };
    };

    it("marks a tool before it runs and keeps it marked until its step is saved, even when it throws", async () => {
        const { calls, marker, tools } = await setup();

        expect(await tools.ok!.execute!()).toBe("fine");
        await expect(tools.boom!.execute!()).rejects.toThrow("nope");
        expect(tools.passive!.execute).toBeUndefined();
        // Both tools returned, their step is not saved: still open. A death here fails visibly instead of calling them again.
        expect(calls).toStrictEqual(["mark+1@2", "run", "mark+1@2", "run"]);

        await marker.release();
        expect(calls.at(-1)).toBe("mark-2@2");

        // Nothing finished since: nothing to release.
        await marker.release();
        expect(calls).toHaveLength(5);

        vi.doUnmock("../../_generated/internal");
    });

    it("stops a tool whose mark is refused, and runs one whose mark merely failed", async () => {
        const { calls, ctx, onReplaced, tools } = await setup();

        ctx.runMutation.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "CONFLICT" }));
        await expect(tools.ok!.execute!()).rejects.toThrow("gone");
        expect(calls).toStrictEqual([]);

        ctx.runMutation.mockRejectedValueOnce(Object.assign(new Error("replaced"), { code: "RUN_REPLACED" }));
        await expect(tools.ok!.execute!()).rejects.toThrow("replaced");
        expect(onReplaced).toHaveBeenCalledOnce();
        expect(calls).toStrictEqual([]);

        // A blip on the shard must not fail the tool.
        ctx.runMutation.mockRejectedValueOnce(new Error("shard blip"));
        expect(await tools.ok!.execute!()).toBe("fine");
        expect(calls).toStrictEqual(["run"]);

        vi.doUnmock("../../_generated/internal");
    });
});
