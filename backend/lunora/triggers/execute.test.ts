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
        admissionError: undefined as Error | undefined,
        admissionRefusal: undefined as string | undefined,
        beforeThread: undefined as (() => void) | undefined,
        bot: null as Record<string, unknown> | null,
        mutations: [] as { args: unknown; name: string }[],
        onRun: undefined as (() => void) | undefined,
        queries: [] as string[],
        releaseFails: false,
        runs: [] as Record<string, unknown>[],
        scheduled: [] as { args: unknown; delay: number; name: string }[],
        snapshot: null as unknown as QuietSnapshot,
        snapshotError: false,
        trigger: null as Record<string, unknown> | null,
    };
});

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async (_ctx: unknown, options: Record<string, unknown>) => {
            state.runs.push(options);
            state.beforeThread?.();
            await (options.onThread as ((threadId: string) => void) | undefined)?.("thread-1");
            state.onRun?.();

            return { text: "Here is the digest.", threadId: "thread-1" };
        },
    };
});

const moveWindowBack = (expected: number | undefined): void => {
    const current = state.trigger?.lastTriggeredAt as number | undefined;

    if (current !== undefined && (expected === undefined || expected < current)) {
        state.trigger = { ...state.trigger, lastTriggeredAt: expected };
    }
};

const NAME_SUFFIX = (path: string): string => path.slice(path.lastIndexOf(":") + 1);

const ctx = () =>
    ({
        runMutation: async (path: string, args: unknown) => {
            const name = NAME_SUFFIX(path);

            state.mutations.push({ args, name });

            if (name === "admitTriggerRun" && state.admissionError) {
                throw state.admissionError;
            }

            // The stored window, moved atomically as the real mutations do (nothing awaits between the read and the write).
            if (name === "reserveQuietWindow") {
                const { expected, windowStart } = args as { expected?: number; windowStart: number };

                if (state.trigger?.lastTriggeredAt !== expected) {
                    return false;
                }

                state.trigger = { ...state.trigger, lastTriggeredAt: windowStart };

                return true;
            }

            if (name === "releaseQuietWindow") {
                const { expected } = args as { expected?: number };

                if (state.releaseFails) {
                    throw new Error("release unavailable");
                }

                moveWindowBack(expected);

                return null;
            }

            if (name === "admitTriggerRun") {
                return state.admissionRefusal ?? null;
            }

            return name === "createExecution" ? "execution-1" : null;
        },
        runQuery: async (path: string) => {
            const name = NAME_SUFFIX(path);

            state.queries.push(name);

            if (name === "getTriggerInternal") {
                return state.trigger && { ...state.trigger };
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
        scheduler: {
            runAfter: async (delay: number, path: string, args: unknown) => {
                state.scheduled.push({ args, delay, name: NAME_SUFFIX(path) });
            },
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
    state.admissionError = undefined;
    state.admissionRefusal = undefined;
    state.beforeThread = undefined;
    state.snapshot = EMPTY;
    state.snapshotError = false;
    state.mutations = [];
    state.onRun = undefined;
    state.queries = [];
    state.releaseFails = false;
    state.runs = [];
    state.scheduled = [];
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

    it("takes the window before it creates anything, and does not give it back once the thread exists", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };
        state.snapshot = { ...EMPTY, threads: [{ title: "Planning", updatedAt: 600 }] };

        await run();

        expect(names().indexOf("reserveQuietWindow")).toBeGreaterThanOrEqual(0);
        expect(names().indexOf("reserveQuietWindow")).toBeLessThan(names().indexOf("createExecution"));
        expect(names()).not.toContain("releaseQuietWindow");
    });

    it("lets only one of two overlapping runs post the same activity", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };
        state.snapshot = { ...EMPTY, threads: [{ title: "Planning", updatedAt: 600 }] };

        await Promise.all([run(), run()]);

        expect(state.runs).toHaveLength(1);
        expect(names().filter((name) => name === "createExecution")).toHaveLength(1);
        expect(names().filter((name) => name === "admitTriggerRun")).toHaveLength(1);
        expect(state.mutations.filter((entry) => entry.name === "recordFilteredExecution")).toHaveLength(1);
    });

    it("gives the window back when admission refuses the run, so the next run still reports the activity", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };
        state.snapshot = { ...EMPTY, threads: [{ title: "Planning", updatedAt: 600 }] };
        state.admissionRefusal = "Daily limit reached";

        await run();

        expect(state.runs).toHaveLength(0);
        expect(state.trigger?.lastTriggeredAt).toBe(500);

        state.admissionRefusal = undefined;
        state.mutations = [];

        await run();

        expect(state.runs).toHaveLength(1);
    });

    it("schedules the give-back again when it fails, so the window is not left past activity nobody posted", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        state.trigger = { ...state.trigger, quietWhenEmpty: true };
        state.snapshot = { ...EMPTY, threads: [{ title: "Planning", updatedAt: 600 }] };
        state.admissionRefusal = "Daily limit reached";
        state.releaseFails = true;

        await run();

        expect(state.scheduled).toStrictEqual([{ args: { expected: 500, triggerId: "trigger-1" }, delay: expect.any(Number), name: "releaseQuietWindow" }]);
    });

    it("does not take the window for a manual run or a routine that is not quiet", async () => {
        state.trigger = { ...state.trigger, quietWhenEmpty: true };

        await run({ ignoreDisabled: true, manual: true });

        state.trigger = { ...state.trigger, quietWhenEmpty: undefined };

        await run();

        expect(names()).not.toContain("reserveQuietWindow");
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

        expect(state.trigger?.lastTriggeredAt).toBe(START);
        expect((state.mutations.find((entry) => entry.name === "updateTriggerStats")?.args as { lastTriggeredAt?: number }).lastTriggeredAt).toBeUndefined();

        // A chat touched halfway through the first run: after its start, before its end.
        state.mutations = [];
        state.runs = [];
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

    describe("a run that posted nothing", () => {
        const ACTIVITY = 1000;

        /** Applies the recorded stats to the stored trigger as `updateTriggerStats` does, then checks again with the same activity. */
        const nextCheckPosts = async (): Promise<boolean> => {
            const stats = state.mutations.find((entry) => entry.name === "updateTriggerStats")?.args as { lastTriggeredAt?: number } | undefined;

            expect(stats).toBeDefined();
            state.trigger = { ...state.trigger, lastTriggeredAt: stats?.lastTriggeredAt ?? state.trigger?.lastTriggeredAt };
            state.admissionError = undefined;
            state.beforeThread = undefined;
            state.mutations = [];
            state.runs = [];

            await run();

            return state.runs.length === 1 && !names().includes("recordFilteredExecution");
        };

        beforeEach(() => {
            vi.spyOn(console, "error").mockImplementation(() => undefined);
            state.trigger = { ...state.trigger, lastTriggeredAt: 500, quietWhenEmpty: true };
            state.snapshot = { ...EMPTY, threads: [{ title: "Planning", updatedAt: ACTIVITY }] };
        });

        it("leaves lastTriggeredAt unchanged on a thrown admission error, still counting the run and the error", async () => {
            state.admissionError = new Error("admission store unavailable");

            await run();

            const stats = state.mutations.find((entry) => entry.name === "updateTriggerStats")?.args as Record<string, unknown>;

            expect(state.runs).toHaveLength(0);
            expect(stats).not.toHaveProperty("lastTriggeredAt");
            expect(stats.error).toEqual(expect.any(String));
            expect(names()).toContain("updateExecution");
            expect(state.trigger?.lastTriggeredAt).toBe(500);
            expect(await nextCheckPosts()).toBe(true);
        });

        it("leaves lastTriggeredAt unchanged on a failure before the thread exists", async () => {
            state.beforeThread = () => {
                throw new Error("model gateway down");
            };

            await run();

            // The fake only reports a thread after `beforeThread`, as the real run does after its create call.
            const stats = state.mutations.find((entry) => entry.name === "updateTriggerStats")?.args as Record<string, unknown>;

            expect(stats).not.toHaveProperty("lastTriggeredAt");
            expect(stats.error).toEqual(expect.any(String));
            expect(await nextCheckPosts()).toBe(true);
        });

        it("still stamps the last run of a routine that is not quiet when it fails before a thread exists", async () => {
            const now = 20_000;

            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(now);
            state.trigger = { ...state.trigger, quietWhenEmpty: undefined };
            state.beforeThread = () => {
                throw new Error("model gateway down");
            };

            await run();

            const stats = state.mutations.find((entry) => entry.name === "updateTriggerStats")?.args as Record<string, unknown>;

            expect(stats.lastTriggeredAt).toBe(now);
        });
    });
});
