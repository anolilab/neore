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
            runMutation: vi.fn(async (_ref: unknown, args: { delta: number; epoch: number; setTo?: number }) => {
                calls.push(args.setTo === undefined ? `mark+${args.delta}@${args.epoch}` : `set${args.setTo}@${args.epoch}`);
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
        expect(calls.at(-1)).toBe("set0@2");

        // Nothing finished since: nothing to release.
        await marker.release();
        expect(calls).toHaveLength(5);

        vi.doUnmock("../../_generated/internal");
    });

    it("settles a release whose answer was lost by stating the count again, never by subtracting again", async () => {
        const { calls, ctx, marker, tools } = await setup();

        await tools.ok!.execute!();
        ctx.runMutation.mockRejectedValueOnce(new Error("answer lost"));
        await marker.release();

        // Nothing is forgotten: the next release states the same count outright.
        await marker.release();
        expect(calls.slice(-1)).toStrictEqual(["set0@2"]);
        await marker.release();
        expect(calls.filter((call) => call.startsWith("set"))).toHaveLength(1);

        vi.doUnmock("../../_generated/internal");
    });

    it("states the count after a mark that failed on an unknown footing, so a mark that did land cannot linger", async () => {
        const { calls, ctx, marker, tools } = await setup();

        ctx.runMutation.mockRejectedValueOnce(new Error("shard blip"));
        await expect(tools.ok!.execute!()).rejects.toThrow("shard blip");
        await marker.release();

        expect(calls).toStrictEqual(["set0@2"]);

        vi.doUnmock("../../_generated/internal");
    });

    it("never runs a tool whose mark failed, whatever the failure", async () => {
        const { calls, ctx, onReplaced, tools } = await setup();

        ctx.runMutation.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "CONFLICT" }));
        await expect(tools.ok!.execute!()).rejects.toThrow("gone");

        ctx.runMutation.mockRejectedValueOnce(Object.assign(new Error("replaced"), { code: "RUN_REPLACED" }));
        await expect(tools.ok!.execute!()).rejects.toThrow("replaced");
        expect(onReplaced).toHaveBeenCalledOnce();

        // A blip on the shard stops the tool too: a call without a confirmed mark could be run again by a resume.
        ctx.runMutation.mockRejectedValueOnce(new Error("shard blip"));
        await expect(tools.ok!.execute!()).rejects.toThrow("shard blip");
        expect(calls).toStrictEqual([]);

        vi.doUnmock("../../_generated/internal");
    });

    it("keeps `this`, so a tool that reads its context off itself still gets the one `wrapTools` attaches", async () => {
        const { marker } = await setup();
        const wrapped = marker.wrap({
            reads: {
                ctx: undefined as unknown,
                execute(this: { ctx: unknown }) {
                    return this.ctx;
                },
            },
        } as never) as Record<string, { execute: () => Promise<unknown> }>;

        // What `wrapTools` does with a tool that accepts a context: a copy carrying `ctx`.
        const withContext = { ...wrapped.reads!, ctx: "the run context" };

        expect(await withContext.execute()).toBe("the run context");

        vi.doUnmock("../../_generated/internal");
    });

    it("leaves a createTool tool working through wrapTools: it keeps every tool and still runs with its context", async () => {
        const { marker } = await setup();
        const { z } = await import("zod");
        const { createTool, wrapTools } = await import("../../agent/client/create-tool");
        const createDocument = createTool({
            description: "Create a document",
            execute: async (context: { label: string }, input: { title: string }) => `${context.label}:${input.title}`,
            inputSchema: z.object({ title: z.string() }),
        } as never);
        const tools = wrapTools({ label: "ctx" } as never, marker.wrap({ createDocument }) as never) as Record<
            string,
            { execute: (input: unknown, options: unknown) => Promise<unknown> }
        >;

        expect(Object.keys(tools)).toStrictEqual(["createDocument"]);
        expect(await tools.createDocument!.execute({ title: "T" }, {})).toBe("ctx:T");

        vi.doUnmock("../../_generated/internal");
    });
});
