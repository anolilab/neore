/**
 * Render-count harness for the message list: how many rows re-render when a
 * live update touches one message of a long thread. Rows are counted through a
 * stub `MessageContent`, which every `MessageItem` render renders once.
 */

import { formatGoalReviewNote } from "@neore/backend/chat/goals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { Context, ReactNode } from "react";
import { createElement, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UIMessage } from "@/lib/agent";
import { shareUnchangedMessages } from "@/lib/agent/share-unchanged-messages";

const harness = vi.hoisted(() => {
    return {
        actions: {} as Record<string, unknown>,
        ActionsContext: undefined as Context<Record<string, unknown>> | undefined,
        activeStreamId: null as string | null,
        contentRenders: new Map<string, number>(),
        goal: null as unknown,
        infos: [] as string[],
        messages: [] as unknown[],
        MessagesContext: undefined as Context<unknown[]> | undefined,
        publish: undefined as (() => void) | undefined,
        threadId: "thread-1",
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { i18n: { locale: "en" }, t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", async () => {
    const { createContext, use } = await import("react");

    // Two separate contexts, like ChatProvider's split messages/actions contexts.
    harness.MessagesContext = createContext<unknown[]>([]);
    harness.ActionsContext = createContext<Record<string, unknown>>({});

    return {
        useChatActions: () => use(harness.ActionsContext!),
        useChatIsStreaming: () => {
            return { activeStreamId: harness.activeStreamId, gatewayUrl: null, isStreaming: harness.activeStreamId !== null, streamToken: null };
        },
        useChatMessages: () => {
            return { isStreaming: false, loadMore: () => {}, messages: use(harness.MessagesContext!), messagesReady: true, messagesStatus: "Exhausted" };
        },
        useChatThread: () => {
            return { isNewThread: false, model: "test-model", thread: undefined, threadId: harness.threadId };
        },
        useChatThreadIdentity: () => {
            return { isNewThread: false, model: "test-model", threadId: harness.threadId };
        },
    };
});

// A host turn's changes (and the comment draft under them) are not under test here and reach for the backend.
vi.mock("./host-changes-of-thread", () => {
    return { default: () => null };
});

vi.mock("./message-content", () => {
    return {
        default: ({ message }: { message: UIMessage }) => {
            harness.contentRenders.set(message.id, (harness.contentRenders.get(message.id) ?? 0) + 1);

            return createElement("div", null, message.text);
        },
    };
});

vi.mock("./streaming-placeholder", () => {
    return {
        StreamingPlaceholder: ({ streamId }: { streamId: string }) => createElement("div", { "data-testid": "streaming-placeholder" }, streamId),
        ThinkingPlaceholder: () => null,
    };
});

vi.mock("@/features/chat/core/hooks/use-thread-manager", () => {
    return {
        useThreadManager: () => {
            return { createBranch: async () => undefined };
        },
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: undefined };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const leaf = {
        mutationOptions: () => {
            return { mutationFn: async () => undefined };
        },
    };
    // Any depth of namespace (`crpc.a.b.fn`) ends at `leaf`.
    const namespace: object = new Proxy({}, { get: (_target, key) => (Object.hasOwn(leaf, key) ? leaf[key as keyof typeof leaf] : namespace) });

    return { useCRPC: () => namespace };
});

// A user message's copy-link action asks whether the thread is a group chat; these threads are not.
vi.mock("@/features/chat/group/use-group-chat", () => {
    return { useGroupChat: () => null };
});

vi.mock("@/features/chat/goal/use-thread-goal", () => {
    return { useThreadGoal: () => harness.goal };
});

vi.mock("@/features/evals/components/save-eval-case-action", () => {
    return { default: () => null };
});

vi.mock("./generation-model-menu", () => {
    return { default: () => null };
});

vi.mock("./read-aloud-action", () => {
    return { default: () => null };
});

vi.mock("./restore-to-input-action", () => {
    return { default: () => null };
});

vi.mock("./memory-usage-action", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/translation/message-translation", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/translation/translate-action", () => {
    return { default: () => null };
});

vi.mock("./fork-branch-dialog", () => {
    return { default: () => null };
});

vi.mock("@/lib/toast", async (importOriginal) => {
    return {
        ...(await importOriginal<object>()),
        showInfo: (message: string) => {
            harness.infos.push(message);
        },
    };
});

/** Animation frames the jump tests run by hand, so none waits on the runner delivering real ones. */
const frames = new Map<number, FrameRequestCallback>();
const frameIds = { last: 0 };

const stubAnimationFrames = (): void => {
    frames.clear();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frameIds.last += 1;
        frames.set(frameIds.last, callback);

        return frameIds.last;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
};

/** Runs `count` frames, each in its own `act` so the effects a frame causes are committed before the next one. */
const runFrames = (count: number): void => {
    for (let frame = 0; frame < count; frame += 1) {
        const due = [...frames.values()];

        frames.clear();
        act(() => {
            for (const callback of due) {
                callback(performance.now());
            }
        });
    }
};

// Imported after the mocks.
const { default: MessageList, scrollToMessage } = await import("./message-list");

const THREAD_LENGTH = 200;

const makeMessage = (index: number, text = `message ${index}`): UIMessage => {
    const role = index % 2 === 0 ? "user" : "assistant";

    return {
        _creationTime: 1_700_000_000_000 + index,
        id: `m${index}`,
        key: `m${index}`,
        order: Math.floor(index / 2),
        parts: [{ text, type: "text" }],
        role,
        status: "success",
        stepOrder: role === "user" ? 0 : 1,
        text,
    } as UIMessage;
};

/** What a live query push looks like: a freshly decoded copy of the whole page. */
const decodeFresh = (messages: UIMessage[]): UIMessage[] => structuredClone(messages);

const Host = (): ReactNode => {
    const [value, setValue] = useState({ actions: harness.actions, messages: harness.messages });
    const ActionsContext = harness.ActionsContext!;
    const MessagesContext = harness.MessagesContext!;

    useLayoutEffect(() => {
        harness.publish = () => setValue({ actions: harness.actions, messages: harness.messages });
    }, []);

    return (
        <MessagesContext value={value.messages}>
            <ActionsContext value={value.actions}>
                <MessageList />
            </ActionsContext>
        </MessagesContext>
    );
};

const mountInto = () => {
    const queryClient = new QueryClient();

    return render(
        <QueryClientProvider client={queryClient}>
            <Host />
        </QueryClientProvider>,
    );
};

const mount = () => {
    mountInto();
};

/** Pushes a live update whose only change is the last message's text; returns the rows it re-rendered. */
const pushLastMessageEdit = (share: boolean, freshActions: boolean): number => {
    const previous = harness.messages as UIMessage[];
    const decoded = decodeFresh(previous);
    const lastIndex = decoded.length - 1;

    decoded[lastIndex] = makeMessage(lastIndex, `${previous[lastIndex]!.text} more`);

    harness.messages = share ? shareUnchangedMessages(previous, decoded) : decoded;

    if (freshActions) {
        harness.actions = { ...harness.actions };
    }

    harness.contentRenders.clear();
    act(() => harness.publish?.());

    let renders = 0;

    for (const count of harness.contentRenders.values()) {
        renders += count;
    }

    return renders;
};

// Each case mounts the whole thread from cold. On a slow Windows runner the first
// mount alone went past the 10 s default, with no change to what is measured.
const RENDER_TEST_TIMEOUT_MS = 60_000;

describe("message list render cost", () => {
    beforeEach(() => {
        harness.messages = Array.from({ length: THREAD_LENGTH }, (_, index) => makeMessage(index));
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };
        harness.contentRenders.clear();
    });

    it(
        "re-renders every row when a push decodes fresh objects and the actions context changes (the old behaviour)",
        () => {
            mount();

            expect(pushLastMessageEdit(false, true)).toBeGreaterThanOrEqual(THREAD_LENGTH);
        },
        RENDER_TEST_TIMEOUT_MS,
    );

    it(
        "re-renders only the changed row once unchanged messages keep their identity and the actions context is stable",
        () => {
            mount();

            expect(pushLastMessageEdit(true, false)).toBe(1);
            expect(harness.contentRenders.get(`m${THREAD_LENGTH - 1}`)).toBe(1);
        },
        RENDER_TEST_TIMEOUT_MS,
    );

    it(
        "still re-renders every row when only the actions context changes",
        () => {
            mount();

            // Why chat-context reads `messages` through a ref in its action callbacks:
            // a new actions object alone re-renders all rows.
            expect(pushLastMessageEdit(true, true)).toBeGreaterThanOrEqual(THREAD_LENGTH);
        },
        RENDER_TEST_TIMEOUT_MS,
    );
});

/* eslint-disable testing-library/no-node-access, testing-library/no-container -- the assertion is about DOM ancestry */
describe("message list text size hook", () => {
    it("marks the message text with .message-text and keeps timestamps outside it", () => {
        harness.messages = Array.from({ length: 4 }, (_, index) => makeMessage(index));
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };

        const { container } = mountInto();

        for (const index of [0, 1, 2, 3]) {
            expect(screen.getByText(`message ${index}`).closest(".message-text")).not.toBeNull();
        }

        const timestamps = container.querySelectorAll("time");

        expect(timestamps.length).toBeGreaterThan(0);

        for (const timestamp of timestamps) {
            expect(timestamp.closest(".message-text")).toBeNull();
        }
    });

    it("marks a system note as message text too", () => {
        harness.messages = [{ ...makeMessage(0, "system note"), role: "system" } as UIMessage];
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };

        mountInto();

        expect(screen.getByText("system note").closest(".message-text")).not.toBeNull();
    });
});

describe("a jump to a message", () => {
    afterEach(() => {
        harness.threadId = "thread-1";
    });

    it("takes a request made for the next thread once the same list shows that thread", async () => {
        harness.messages = Array.from({ length: 4 }, (_, index) => makeMessage(index));
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };
        Element.prototype.scrollIntoView = vi.fn();

        mountInto();

        // Made while the list still shows thread-1, so the list rejects it and it stays pending.
        act(() => scrollToMessage("b2", { threadId: "thread-2" }));

        // Navigation lands: the same list now renders thread-2.
        harness.threadId = "thread-2";
        harness.messages = Array.from(
            { length: 4 },
            (_, index) => ({ ...makeMessage(index, `second ${index}`), id: `b${index}`, key: `b${index}` }) as UIMessage,
        );
        act(() => harness.publish?.());

        const row = screen.getByText("second 2").closest<HTMLElement>("[role=listitem]")!;

        await vi.waitFor(() => expect(document.activeElement).toBe(row));
    });

    it("marks the row it focuses for a focus ring, and only until focus leaves it", async () => {
        harness.messages = Array.from({ length: 4 }, (_, index) => makeMessage(index));
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };
        Element.prototype.scrollIntoView = vi.fn();

        mountInto();

        const row = screen.getByText("message 2").closest<HTMLElement>("[role=listitem]")!;

        // A row a click in its text focused is not marked.
        act(() => row.focus());
        expect(row.dataset.jumped).toBeUndefined();
        act(() => row.blur());

        act(() => scrollToMessage(row.dataset.listMessageId!));

        await vi.waitFor(() => expect(document.activeElement).toBe(row));
        expect(row.dataset.jumped).toBe("");

        act(() => row.blur());

        expect(row.dataset.jumped).toBeUndefined();
    });
});

describe("message list goal", () => {
    beforeEach(() => {
        harness.actions = {};
        harness.contentRenders.clear();
        harness.messages = [
            makeMessage(0, "Make the report"),
            makeMessage(1, "Here is a draft."),
            { ...makeMessage(2, `Goal: Ship the report.\n\n${formatGoalReviewNote("Add the charts.")}`), agentName: "neore:goal", order: 1 },
            { ...makeMessage(3, "Charts added."), order: 1 },
        ];
        harness.goal = {
            costMicrodollars: 0,
            createdAt: 1,
            goalId: "g1",
            maxCostMicrodollars: 2_000_000,
            maxRounds: 5,
            round: 2,
            startMessageId: "m0",
            status: "met",
            text: "Ship the report",
            verdicts: [
                { met: false, order: 0, reason: "Add the charts.", round: 1 },
                { met: true, order: 1, reason: "Charts added.", round: 2 },
            ],
        };
    });

    it("shows the goal at the top of the run and a verdict under each reply it judged", () => {
        mount();

        expect(screen.getByRole("region", { name: "Goal" }).textContent).toContain("Ship the report");
        expect(screen.getByText("Goal met: Charts added.")).toBeTruthy();
    });

    it("shows what the instruction that opened the second round carried as a review note, once", () => {
        mount();

        expect(screen.getAllByText("Review: Add the charts.")).toHaveLength(1);
        expect(screen.queryByText("Round 1: not yet. Add the charts.")).toBeNull();
    });

    it("does not show the instruction the goal saved to open its second round as a message", () => {
        mount();

        expect(harness.contentRenders.has("m2")).toBe(false);
        expect(harness.contentRenders.has("m1")).toBe(true);
        expect(harness.contentRenders.has("m3")).toBe(true);
    });
});

describe("a long thread", () => {
    afterEach(() => {
        harness.activeStreamId = null;
        vi.restoreAllMocks();
    });

    beforeEach(() => {
        harness.messages = Array.from({ length: THREAD_LENGTH }, (_, index) => makeMessage(index));
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };
    });

    it("keeps every message mounted, each a row directly in the list, where off-screen rows skip layout and paint", () => {
        mountInto();

        const rows = [...document.querySelectorAll<HTMLElement>("[data-list-message-id]")];

        expect(rows).toHaveLength(THREAD_LENGTH);
        // `.message-list > [data-list-message-id]` in styles.css: content-visibility applies to exactly these.
        expect(rows.every((row) => row.parentElement?.classList.contains("message-list"))).toBe(true);
    });

    it("renders the streaming reply as the list's last item, outside the rows the stylesheet can skip", () => {
        harness.activeStreamId = "stream-1";

        mountInto();

        const placeholder = screen.getByTestId("streaming-placeholder");

        expect(placeholder.closest("[data-list-message-id]")).toBeNull();
        expect(screen.getAllByRole("listitem").at(-1)?.contains(placeholder)).toBe(true);
    });

    describe("a jump", () => {
        /** Calls of `scrollIntoView` per row, and the tops a row reports, frame after frame. */
        const scrolls = new Map<string, number>();
        const tops = new Map<string, number[]>();
        /** The heights a row reports, frame after frame (100 when unset). */
        const heights = new Map<string, number[]>();
        /** Runs after a row's `scrollIntoView`. */
        let onScroll: (id: string) => void = () => {};

        beforeEach(() => {
            scrolls.clear();
            tops.clear();
            heights.clear();
            onScroll = () => {};
            harness.infos.length = 0;
            stubAnimationFrames();
        });

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        const rowOf = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-list-message-id="${CSS.escape(id)}"]`)!;

        /** Gives every mounted row a scroll that is counted and a top that follows `tops`, frame after frame. */
        const stubRows = (): void => {
            for (const row of document.querySelectorAll<HTMLElement>("[data-list-message-id]")) {
                const id = row.dataset.listMessageId ?? "";

                Object.defineProperties(row, {
                    getBoundingClientRect: {
                        configurable: true,
                        value: () => {
                            const queue = tops.get(id) ?? [];
                            const top = queue.length > 1 ? queue.shift()! : (queue[0] ?? 0);
                            const heightQueue = heights.get(id) ?? [];
                            const height = heightQueue.length > 1 ? heightQueue.shift()! : (heightQueue[0] ?? 100);

                            return { bottom: top + height, height, left: 0, right: 0, top, width: 0, x: 0, y: top } as DOMRect;
                        },
                    },
                    scrollIntoView: {
                        configurable: true,
                        value: () => {
                            scrolls.set(id, (scrolls.get(id) ?? 0) + 1);
                            onScroll(id);
                        },
                    },
                });
            }
        };

        it("re-centres its row until rows above it stop pushing it", () => {
            // Rows above render at their real height as they come into view: the row moves twice, then stays.
            tops.set("m100", [500, 300, 300]);
            mountInto();
            stubRows();

            act(() => scrollToMessage("m100"));
            // The jump's own frame, then one per re-centring.
            runFrames(4);

            expect(scrolls.get("m100")).toBe(3);
            expect(document.activeElement).toBe(rowOf("m100"));

            runFrames(3);

            expect(scrolls.get("m100")).toBe(3);
            // Re-centring moves the view, never focus: keyboard and screen-reader users stay on the message.
            expect(document.activeElement).toBe(rowOf("m100"));
        });

        it("re-centres its row again when a row above changes after it stood still", () => {
            // Still for two frames, then a late image above it pushes it once more.
            tops.set("m100", [500, 300, 300, 300, 250, 250]);
            mountInto();
            stubRows();

            act(() => scrollToMessage("m100"));
            runFrames(8);

            // The jump's own scroll, the two moves while rows settled, and the late one.
            expect(scrolls.get("m100")).toBe(4);
            expect(document.activeElement).toBe(rowOf("m100"));
        });

        it("re-centres its row when it grows in place, its top unmoved", () => {
            // An image in the row loads without a reserved size: the row grows by 400px, its top stays.
            tops.set("m100", [300]);
            heights.set("m100", [100, 100, 500, 500]);
            mountInto();
            stubRows();

            act(() => scrollToMessage("m100"));
            runFrames(6);

            // The jump's own scroll, the first settling frame, and the growth.
            expect(scrolls.get("m100")).toBe(3);
        });

        it("stops re-centring once the reader scrolls on their own", () => {
            // A row that never settles would be re-centred for every frame of the budget.
            tops.set("m100", [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
            mountInto();
            stubRows();

            act(() => scrollToMessage("m100"));
            runFrames(2);

            const before = scrolls.get("m100");

            // The reader turns the wheel right after the jump.
            act(() => {
                document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
            });
            runFrames(8);

            expect(scrolls.get("m100")).toBe(before);
        });

        it("stops re-centring an older jump once a newer one is asked for", () => {
            // A row that never settles would be re-centred for every frame of the budget.
            tops.set("m100", [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
            mountInto();
            stubRows();

            // The newer jump is asked for right after the older one first scrolls its row.
            onScroll = (id) => {
                if (id === "m100" && scrolls.get("m100") === 1) {
                    scrollToMessage("m150");
                }
            };
            act(() => scrollToMessage("m100"));
            runFrames(14);

            expect(scrolls.get("m150")).toBeGreaterThanOrEqual(1);
            // Its first scroll only: none of the re-centring frames ran.
            expect(scrolls.get("m100")).toBe(1);
            // Focus went to the newer target and stayed there.
            expect(document.activeElement).toBe(rowOf("m150"));
        });

        it("lands on the streaming item for the reply still streaming, without paging or a not-found notice", () => {
            const last = THREAD_LENGTH - 1;

            harness.activeStreamId = "stream-1";
            harness.messages = [...(harness.messages as UIMessage[]).slice(0, last), { ...makeMessage(last), status: "pending" } as UIMessage];
            mountInto();

            const streaming = screen.getAllByRole("listitem").at(-1)!;

            streaming.scrollIntoView = vi.fn();
            act(() => scrollToMessage(`m${String(last)}`));
            runFrames(4);

            expect(streaming.scrollIntoView).toHaveBeenCalled();
            expect(document.activeElement).toBe(streaming);
            expect(harness.infos).toStrictEqual([]);
        });
    });
});
