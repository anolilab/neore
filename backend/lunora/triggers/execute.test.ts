/**
 * A quiet routine's run: a skipped run writes no execution row, creates no
 * thread and is not charged; a posted run goes through the normal path. The
 * agent run, the bot lookup and the workspace read are faked; the decision is `isQuietRunSkipped`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mappedReferences } from "../../test/registered-api";
import { executeTrigger } from "./execute";
import type { QuietSnapshot } from "./quiet";

// A reference is read as its dispatch key (`<module>:<function>`), which the fake ctx below switches on.
vi.mock("../_generated/internal", async (importOriginal) => mappedReferences(await importOriginal(), (reference) => reference.__lunoraRef));

const state = vi.hoisted(() => {
    return {
        bot: null as Record<string, unknown> | null,
        mutations: [] as { args: unknown; name: string }[],
        onRun: undefined as (() => void) | undefined,
        queries: [] as string[],
        runs: [] as Record<string, unknown>[],
        snapshot: null as unknown as QuietSnapshot,
        snapshotError: false,
        trigger: null as Record<string, unknown> | null,
    };
});

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async (_ctx: unknown, options: Record<string, unknown>) => {
            state.runs.push(options);
            state.onRun?.();

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

            if (name === "getBotForRun") {
                return state.bot;
            }

            if (name === "loadQuietSnapshot") {
                if (state.snapshotError) {
                    throw new Error("workspace read failed");
                }

                return state.snapshot;
            }

            throw new Error(`unexpected query ${path}`);
        },
    }) as never;

const run = async (extra: Record<string, unknown> = {}) =>
    await (executeTrigger as unknown as { handler: (context: unknown, args: unknown) => Promise<unknown> }).handler(ctx(), {
        triggerId: "trigger-1",
        ...extra,
    });

const names = () => state.mutations.map((entry) => entry.name);

const EMPTY: QuietSnapshot = { events: [], needsYou: [], running: [], threads: [] };

beforeEach(() => {
    state.bot = { computerEnabled: false, instructions: "Be brief.", model: "bot-model" };
    state.snapshot = EMPTY;
    state.snapshotError = false;
    state.mutations = [];
    state.onRun = undefined;
    state.queries = [];
    state.runs = [];
    state.trigger = {
        _id: "trigger-1",
        botId: "bot-a",
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
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("a quiet routine's run", () => {
    it("posts every run when the flag is off, without reading the workspace", async () => {
        await run();

        expect(state.runs).toHaveLength(1);
        expect(state.queries).not.toContain("loadQuietSnapshot");
        expect(names()).toContain("createExecution");
        expect(names()).not.toContain("recordFilteredExecution");
    });

    it("skips a run with nothing to report: no thread, no notification, no charge", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };

        await run();

        expect(state.queries).toContain("loadQuietSnapshot");
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
        state.snapshot = { ...EMPTY, threads: [{ title: "Planning", updatedAt: 600 }] };

        await run();

        expect(state.runs).toHaveLength(1);
        expect(names()).toContain("createExecution");
        expect(names()).not.toContain("recordFilteredExecution");
    });

    it("creates the run's thread with the routine tag, which is how a later check tells it from a chat", async () => {
        await run();

        expect(state.runs[0]?.thread).toEqual({ tags: ["trigger"], title: "Trigger: Digest" });
    });

    it("posts the run when the check itself fails", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };
        state.snapshotError = true;
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        await run();

        expect(state.runs).toHaveLength(1);
        expect(names()).not.toContain("recordFilteredExecution");
    });

    it("posts a manual run with nothing to report, without reading the workspace", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };

        await run({ ignoreDisabled: true, manual: true });

        expect(state.queries).not.toContain("loadQuietSnapshot");
        expect(state.runs).toHaveLength(1);
        expect(names()).toContain("createExecution");
        expect(names()).toContain("updateTriggerStats");
        expect(names()).not.toContain("recordFilteredExecution");
    });

    it("posts when the routine's bot is gone, whatever the flag says", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };
        state.bot = null;

        await run();

        expect(state.queries).not.toContain("loadQuietSnapshot");
        expect(state.runs).toHaveLength(1);
        expect(names()).not.toContain("recordFilteredExecution");
    });

    it("never skips a webhook delivery, even when its row carries the flag", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true, type: "webhook" };

        await run();

        expect(state.queries).not.toContain("loadQuietSnapshot");
        expect(state.runs).toHaveLength(1);
    });

    it("counts only what is newer than the last run: an older open request does not make it post", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };
        state.snapshot = { ...EMPTY, needsYou: [{ at: 400, kind: "waiting_in_chat", title: "Old approval" }] };

        await run();

        expect(state.runs).toHaveLength(0);
        expect(names()).toContain("recordFilteredExecution");
    });
});

describe("the window a run leaves for the next one", () => {
    const START = 10_000;
    const DURATION = 90_000;

    it("starts at the run's beginning, so activity while the agent worked is reported by the next run", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(START);
        state.onRun = () => {
            vi.setSystemTime(START + DURATION);
        };
        state.trigger = { ...state.trigger, quietWhenEmpty: true };
        state.snapshot = { ...EMPTY, threads: [{ title: "Planning", updatedAt: 1000 }] };

        await run();

        const stats = state.mutations.find((entry) => entry.name === "updateTriggerStats")?.args as { lastTriggeredAt: number };

        expect(stats.lastTriggeredAt).toBe(START);

        // A chat touched halfway through the first run: after its start, before its end.
        state.mutations = [];
        state.runs = [];
        state.trigger = { ...state.trigger, lastTriggeredAt: stats.lastTriggeredAt };
        state.snapshot = { ...EMPTY, threads: [{ title: "Mid-run chat", updatedAt: START + DURATION / 2 }] };

        await run();

        expect(state.runs).toHaveLength(1);
        expect(names()).not.toContain("recordFilteredExecution");
    });

    it("records the start of a run that failed too", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(START);
        state.onRun = () => {
            vi.setSystemTime(START + DURATION);

            throw new Error("model down");
        };
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        await run();

        expect(state.mutations.find((entry) => entry.name === "updateTriggerStats")?.args).toMatchObject({ lastTriggeredAt: START });
    });
});
