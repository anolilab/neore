/**
 * A quiet routine's run: a skipped run writes no execution row, creates no
 * thread and is not charged; a posted run goes through the normal path. The
 * agent run and the workspace read are faked; the decision is `isQuietRunSkipped`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mappedReferences } from "../../test/registered-api";
import type { BriefInputs } from "../notifications/daily-brief-logic";
import { executeTrigger } from "./execute";

// A reference is read as its dispatch key (`<module>:<function>`), which the fake ctx below switches on.
vi.mock("../_generated/internal", async (importOriginal) => mappedReferences(await importOriginal(), (reference) => reference.__lunoraRef));

const state = vi.hoisted(() => {
    return {
        inputs: { events: [], needsYou: [], running: [], threads: [] } as BriefInputs,
        inputsError: false,
        mutations: [] as { args: unknown; name: string }[],
        queries: [] as string[],
        runs: [] as Record<string, unknown>[],
        trigger: null as Record<string, unknown> | null,
    };
});

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async (_ctx: unknown, options: Record<string, unknown>) => {
            state.runs.push(options);

            return { text: "Here is the digest.", threadId: "thread-1" };
        },
    };
});

const NAME_SUFFIX = (path: string): string => path.slice(path.lastIndexOf(":") + 1);

const ctx = () =>
    ({
        runMutation: async (path: string, args: unknown) => {
            const name = NAME_SUFFIX(path);

            state.mutations.push({ args, name });

            return name === "createExecution" ? "execution-1" : null;
        },
        runQuery: async (path: string) => {
            const name = NAME_SUFFIX(path);

            state.queries.push(name);

            if (name === "getTriggerInternal") {
                return state.trigger;
            }

            if (name === "loadDailyBriefInputs") {
                if (state.inputsError) {
                    throw new Error("workspace read failed");
                }

                return state.inputs;
            }

            throw new Error(`unexpected query ${path}`);
        },
    }) as never;

const run = async () =>
    await (executeTrigger as unknown as { handler: (context: unknown, args: unknown) => Promise<unknown> }).handler(ctx(), { triggerId: "trigger-1" });

const names = () => state.mutations.map((entry) => entry.name);

const EMPTY: BriefInputs = { events: [], needsYou: [], running: [], threads: [] };

beforeEach(() => {
    state.inputs = EMPTY;
    state.inputsError = false;
    state.mutations = [];
    state.queries = [];
    state.runs = [];
    state.trigger = {
        _id: "trigger-1",
        botId: undefined,
        createdAt: 100,
        enabled: true,
        lastTriggeredAt: 500,
        model: "m",
        name: "Digest",
        quietWhenEmpty: undefined,
        triggerCount: 0,
        type: "schedule",
        userId: "user-a",
    };
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("a quiet routine's run", () => {
    it("posts every run when the flag is off, without reading the workspace", async () => {
        await run();

        expect(state.runs).toHaveLength(1);
        expect(state.queries).not.toContain("loadDailyBriefInputs");
        expect(names()).toContain("createExecution");
        expect(names()).not.toContain("recordFilteredExecution");
    });

    it("skips a run with nothing to report: no thread, no notification, no charge", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };

        await run();

        expect(state.queries).toContain("loadDailyBriefInputs");
        expect(state.runs).toHaveLength(0);
        expect(names()).not.toContain("createExecution");
        expect(names()).not.toContain("admitTriggerRun");
        expect(names()).not.toContain("updateTriggerStats");
        expect(names()).toContain("recordFilteredExecution");
        expect(state.mutations.find((entry) => entry.name === "recordFilteredExecution")?.args).toEqual({
            reason: "Nothing to report",
            triggerId: "trigger-1",
        });
    });

    it("posts a run when the workspace has something to report", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };
        state.inputs = { ...EMPTY, threads: ["Planning"] };

        await run();

        expect(state.runs).toHaveLength(1);
        expect(names()).toContain("createExecution");
        expect(names()).not.toContain("recordFilteredExecution");
    });

    it("posts the run when the check itself fails", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };
        state.inputsError = true;
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        await run();

        expect(state.runs).toHaveLength(1);
        expect(names()).not.toContain("recordFilteredExecution");
    });
});
