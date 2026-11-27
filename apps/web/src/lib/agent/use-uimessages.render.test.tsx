/**
 * `useUIMessages` keeps its per-turn combine cache for the COMMITTED result: a render React throws away
 * (here one for another thread, suspended inside a transition) must not evict it.
 */
import type { UIMessage } from "@neore/backend/agent/ui-messages";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { startTransition, Suspense, use, useLayoutEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        /** Steps of each thread handed to `combineUIMessages`, summed. */
        combinedSteps: new Map<string, number>(),
        controls: { push: () => {}, switchTo: (_threadId: string) => {} },
        pages: new Map<string, UIMessage[]>(),
        /** Every thread a render (committed or not) read messages for. */
        renderedThreads: new Set<string>(),
        /** What the last COMMITTED render showed. */
        shown: [] as unknown[],
    };
});

vi.mock("@lunora/react", () => {
    return {
        usePaginatedQuery: (_query: unknown, args: "skip" | { threadId: string }) => {
            if (args !== "skip") {
                harness.renderedThreads.add(args.threadId);
            }

            return {
                isLoading: false,
                loadMore: () => {},
                results: args === "skip" ? [] : (harness.pages.get(args.threadId) ?? []),
                status: "Exhausted",
            };
        },
    };
});

vi.mock("./use-streaming-uimessages", () => {
    return { default: () => undefined };
});

vi.mock("@neore/backend/agent/ui-messages", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@neore/backend/agent/ui-messages")>();

    return {
        ...actual,
        combineUIMessages: (steps: UIMessage[]) => {
            const threadId = steps[0]?.id.split("-", 1)[0] ?? "?";

            harness.combinedSteps.set(threadId, (harness.combinedSteps.get(threadId) ?? 0) + steps.length);

            return actual.combineUIMessages(steps);
        },
    };
});

const { useUIMessages } = await import("./use-uimessages");

const TURNS = 50;
const STEPS_PER_REPLY = 3;

const step = (threadId: string, order: number, stepOrder: number, text = `${threadId} turn ${order} step ${stepOrder}`): UIMessage => {
    const id = `${threadId}-t${order}-s${stepOrder}`;

    return {
        _creationTime: order * 10 + stepOrder,
        id,
        key: id,
        order,
        parts: [{ text, type: "text" }],
        role: stepOrder === 0 ? "user" : "assistant",
        status: "success",
        stepOrder,
        text,
    } as unknown as UIMessage;
};

const thread = (threadId: string): UIMessage[] =>
    Array.from({ length: TURNS }, (_, order) => Array.from({ length: STEPS_PER_REPLY + 1 }, (__, stepOrder) => step(threadId, order, stepOrder))).flat();

const never = new Promise<never>(() => {});

/** Suspends while the next thread is "loading", so a transition to it never commits. */
const Pending = ({ threadId }: { threadId: string }): ReactNode => {
    if (threadId === "b") {
        use(never);
    }

    return null;
};

const Messages = ({ threadId }: { threadId: string }): ReactNode => {
    const { results } = useUIMessages({} as never, { threadId } as never, { initialNumItems: 20 });

    useLayoutEffect(() => {
        harness.shown = results;
    });

    return null;
};

const Host = (): ReactNode => {
    const [threadId, setThreadId] = useState("a");
    const [, setPush] = useState(0);

    useLayoutEffect(() => {
        harness.controls = {
            push: () => setPush((value) => value + 1),
            switchTo: (next: string) => startTransition(() => setThreadId(next)),
        };
    }, []);

    return (
        <Suspense fallback={null}>
            <Messages threadId={threadId} />
            <Pending threadId={threadId} />
        </Suspense>
    );
};

describe("useUIMessages' combine cache", () => {
    it("survives a render for another thread that React discards, so the next push recombines only the changed turn", async () => {
        harness.pages.set("a", thread("a"));
        harness.pages.set("b", thread("b"));

        render(<Host />);

        const committed = harness.shown as UIMessage[];

        expect(committed).toHaveLength(TURNS * 2);

        // Thread b renders inside a transition and suspends: React throws that render away and keeps thread a.
        await act(async () => {
            harness.controls.switchTo("b");
            await Promise.resolve();
        });

        expect(harness.renderedThreads.has("b")).toBe(true);
        expect(harness.shown).toBe(committed);

        // A push into thread a: one step of one reply changed, every other step is the object it was.
        const pushed = [...harness.pages.get("a")!];
        const changed = pushed.findIndex((message) => message.id === "a-t20-s3");

        pushed[changed] = step("a", 20, 3, "a turn 20 step 3, more");
        harness.pages.set("a", pushed);
        harness.combinedSteps.clear();

        act(() => harness.controls.push());

        // React retries the pending transition for thread b as well; what counts is thread a's work.
        expect(harness.combinedSteps.get("a")).toBe(STEPS_PER_REPLY);
        expect((harness.shown as UIMessage[]).find((message) => message.id === "a-t20-s1")?.text).toContain("more");
        expect((harness.shown as UIMessage[]).filter((message, index) => message !== committed[index])).toHaveLength(1);
    });
});
