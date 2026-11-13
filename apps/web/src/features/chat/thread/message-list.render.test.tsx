/* eslint-disable max-classes-per-file -- two inert stand-ins for browser APIs jsdom lacks (ResizeObserver, SpeechSynthesisUtterance) */

/**
 * Render-count harness for the message list: how many rows re-render when a
 * live update touches one message of a long thread. Rows are counted through a
 * stub `MessageContent`, which every `MessageItem` render renders once.
 */

import { formatGoalReviewNote } from "@neore/backend/chat/goals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import userEvent from "@testing-library/user-event";
import type { Context, ReactNode } from "react";
import { createElement, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UIMessage } from "@/lib/agent";
import { shareUnchangedMessages } from "@/lib/agent/share-unchanged-messages";

import { ALWAYS_MOUNTED_TAIL, VIRTUALIZE_FLAG_KEY } from "./message-windowing";
import { getReadAloudId, stopReadAloud } from "./read-aloud-speech";

const harness = vi.hoisted(() => {
    return {
        actions: {} as Record<string, unknown>,
        ActionsContext: undefined as Context<Record<string, unknown>> | undefined,
        contentRenders: new Map<string, number>(),
        /** Renders the list inside the real shortcut manager and the thread's find bar. */
        withFind: false,
        /** Renders the real read-aloud action on assistant rows. */
        withReadAloud: false,
        activeStreamId: null as string | null,
        goal: null as unknown,
        /** Gives the scroller a layout; jsdom has none. */
        layoutViewport: undefined as ((element: HTMLElement) => void) | undefined,
        loadMore: (() => {}) as (count: number) => void,
        messages: [] as unknown[],
        MessagesContext: undefined as Context<unknown[]> | undefined,
        messagesStatus: "Exhausted",
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
            return {
                isStreaming: false,
                loadMore: (count: number) => harness.loadMore(count),
                messages: use(harness.MessagesContext!),
                messagesReady: true,
                messagesStatus: harness.messagesStatus,
            };
        },
        useChatThread: () => {
            return { isNewThread: false, model: "test-model", thread: undefined, threadId: harness.threadId };
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

vi.mock("./read-aloud-action", async (importOriginal) => {
    const { createElement: create } = await import("react");
    const actual = await importOriginal<typeof import("./read-aloud-action")>();

    return {
        default: (props: Parameters<typeof actual.default>[0]) => (harness.withReadAloud ? create(actual.default, props) : null),
    };
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

// The shortcut chain the thread's find answers to: bindings as a user has them, a router it does not use here.
vi.mock("@/features/layout/hooks/use-ui-state", () => {
    return {
        useKeyboardShortcuts: () => {
            return { keyboardShortcuts: { findInThread: "ctrl+f" }, resetKeyboardShortcuts: () => {}, setKeyboardShortcuts: () => {} };
        },
    };
});

vi.mock("@/features/keyboard/components/keyboard-shortcuts-sheet", () => {
    return { default: () => null };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => () => {} };
});

// Imported after the mocks.
const { default: MessageList, scrollToMessage } = await import("./message-list");
const { KeyboardShortcutsManager } = await import("@/features/keyboard/components/keyboard-shortcuts-manager");
const { default: useKeyboardShortcutHandler } = await import("@/features/keyboard/hooks/use-keyboard-shortcut-handler");
const { default: ThreadFindBar } = await import("./find/thread-find-bar");

/** What `_shortcut.tsx` and `thread.tsx` wrap an open thread in: the app's shortcuts, and the find bar on the thread host. */
const FindShell = ({ children }: { children: ReactNode }): ReactNode => {
    const handleShortcut = useKeyboardShortcutHandler();

    return (
        <KeyboardShortcutsManager onShortcut={handleShortcut}>
            <div data-find-in-thread-host="">
                <ThreadFindBar />
                {children}
            </div>
        </KeyboardShortcutsManager>
    );
};

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

    // The scroller ThreadViewport renders around the list; the virtualized head finds it by this slot.
    const list = (
        <div
            data-slot="scroll-area-viewport"
            ref={(element) => {
                if (element) {
                    harness.layoutViewport?.(element);
                }
            }}
        >
            <MessagesContext value={value.messages}>
                <ActionsContext value={value.actions}>
                    <MessageList />
                </ActionsContext>
            </MessagesContext>
        </div>
    );

    return harness.withFind ? <FindShell>{list}</FindShell> : list;
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
    // Memoization is measured over every row, so all of them are mounted.
    afterEach(() => {
        localStorage.removeItem(VIRTUALIZE_FLAG_KEY);
    });

    beforeEach(() => {
        localStorage.setItem(VIRTUALIZE_FLAG_KEY, "0");
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

/* eslint-disable class-methods-use-this -- inert stand-ins for browser APIs jsdom lacks */
class InertResizeObserver {
    public disconnect(): void {}

    public observe(): void {}

    public unobserve(): void {}
}

/** An utterance that never ends on its own, like a long reply still being read. */
class SilentUtterance {
    public lang = "";

    public constructor(public readonly text: string) {}

    public addEventListener(): void {}
}
/* eslint-enable class-methods-use-this */

/** A Cmd/Ctrl+F keydown, as it reaches the document. */
/** A keydown from the focused element, as a real keypress reaches the document and the window. */
const pressKey = (init: KeyboardEventInit): void => {
    const target = document.activeElement ?? document.body;

    act(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
};

const pressFind = (): void => pressKey({ code: "KeyF", ctrlKey: true, key: "f" });

const nextFrames = async (count: number): Promise<void> => {
    for (let frame = 0; frame < count; frame += 1) {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
        });
    }
};

const SHOW_ALL_NAME = /earlier messages/;

const viewport = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;

const focusedMessageId = (): string | undefined => (document.activeElement as HTMLElement | null)?.dataset.listMessageId;

// Several cases mount the whole thread from cold; see RENDER_TEST_TIMEOUT_MS.
describe("a long thread", { timeout: RENDER_TEST_TIMEOUT_MS }, () => {
    const VIEWPORT_HEIGHT = 800;
    const ROW_HEIGHT = 100;
    // How many frames late the scroller reports a programmatic scroll (a slow layout under load).
    let scrollReportDelayFrames = 0;

    const mountedIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-list-message-id]")].map((row) => row.dataset.listMessageId!);

    beforeEach(() => {
        harness.messages = Array.from({ length: THREAD_LENGTH }, (_, index) => makeMessage(index));
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };
        harness.messagesStatus = "Exhausted";
        Element.prototype.scrollIntoView = vi.fn();
        vi.stubGlobal("ResizeObserver", InertResizeObserver);
        // Every row measures the same; the scroller gets a height, a scroll range and a scroll position that holds.
        vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(ROW_HEIGHT);
        harness.layoutViewport = (element: HTMLElement) => {
            let position = 0;

            Object.defineProperties(element, {
                clientHeight: { configurable: true, value: VIEWPORT_HEIGHT },
                scrollHeight: { configurable: true, value: THREAD_LENGTH * ROW_HEIGHT },
                scrollTo: {
                    configurable: true,
                    value: (options: ScrollToOptions) => {
                        position = options.top ?? position;

                        let framesLeft = scrollReportDelayFrames;
                        const report = () => {
                            if (framesLeft > 0) {
                                framesLeft -= 1;
                                requestAnimationFrame(report);

                                return;
                            }

                            element.dispatchEvent(new Event("scroll"));
                        };

                        report();
                    },
                },
                scrollTop: {
                    configurable: true,
                    get: () => position,
                    set: (value: number) => {
                        position = value;
                    },
                },
            });
        };
    });

    afterEach(() => {
        localStorage.removeItem(VIRTUALIZE_FLAG_KEY);
        harness.activeStreamId = null;
        harness.layoutViewport = undefined;
        harness.loadMore = () => {};
        harness.withFind = false;
        harness.withReadAloud = false;
        harness.threadId = "thread-1";
        scrollReportDelayFrames = 0;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("mounts the newest messages and only a window of the older ones by default", () => {
        mountInto();

        const mounted = mountedIds();

        expect(mounted.length).toBeLessThan(THREAD_LENGTH / 2);

        // The always-mounted tail: stick-to-bottom and the newest replies never depend on the virtualizer.
        const tail = Array.from({ length: ALWAYS_MOUNTED_TAIL }, (_, offset) => `m${THREAD_LENGTH - ALWAYS_MOUNTED_TAIL + offset}`);

        expect(mounted).toStrictEqual(expect.arrayContaining(tail));

        expect(mounted).not.toContain("m100");
        // Screen readers still hear the whole thread's length.
        expect(
            screen
                .getByText(`message ${THREAD_LENGTH - 1}`)
                .closest("[role=listitem]")
                ?.getAttribute("aria-setsize"),
        ).toBe(String(THREAD_LENGTH));
    });

    it("mounts every message when the browser opted out", () => {
        localStorage.setItem(VIRTUALIZE_FLAG_KEY, "0");

        mountInto();

        expect(mountedIds()).toHaveLength(THREAD_LENGTH);
    });

    it("jumps to an older message that is not mounted, mounting and focusing it", async () => {
        mountInto();

        expect(mountedIds()).not.toContain("m100");

        act(() => scrollToMessage("m100"));

        await vi.waitFor(() => expect(focusedMessageId()).toBe("m100"), { timeout: 5000 });
    });

    it("still lands on an older message when its row mounts several frames after the jump scrolled", async () => {
        scrollReportDelayFrames = 6;
        mountInto();

        act(() => scrollToMessage("m100"));

        await vi.waitFor(() => expect(focusedMessageId()).toBe("m100"), { timeout: 5000 });
    });

    it("opens the thread's own find on Cmd/Ctrl+F and stays virtualized", async () => {
        harness.withFind = true;
        mountInto();

        expect(screen.queryByRole("search", { name: "Find in thread" })).toBeNull();

        pressFind();

        expect(await screen.findByRole("search", { name: "Find in thread" })).toBeTruthy();
        expect(mountedIds().length).toBeLessThan(THREAD_LENGTH / 2);
    });

    it("lands on the newest of two quick jumps, and the older one's pending reveal stops", async () => {
        // The first target is in the virtualized head and mounts late; the second is in the tail and is revealed at once.
        scrollReportDelayFrames = 8;
        mountInto();

        const revealed = vi.mocked(Element.prototype.scrollIntoView);

        act(() => scrollToMessage("m100"));
        // The first jump has scrolled the virtualizer towards its row; the row has not mounted yet.
        await vi.waitFor(() => expect(document.querySelector('[data-slot="scroll-area-viewport"]')?.scrollTop).toBeGreaterThan(0));
        expect(mountedIds()).not.toContain("m100");

        act(() => scrollToMessage(`m${THREAD_LENGTH - 5}`));

        await vi.waitFor(() => expect(focusedMessageId()).toBe(`m${THREAD_LENGTH - 5}`), { timeout: 5000 });

        // The first target's row mounts once its scroll is reported; a retry still pending would reveal it on its next frame.
        await vi.waitFor(() => expect(mountedIds()).toContain("m100"), { timeout: 5000 });
        await act(async () => {
            await nextFrames(2);
        });

        expect(mountedIds()).toContain("m100");
        expect(focusedMessageId()).toBe(`m${THREAD_LENGTH - 5}`);
        expect(revealed.mock.contexts.some((element) => (element as HTMLElement).dataset.listMessageId === "m100")).toBe(false);
    });

    it("mounts every message once Cmd/Ctrl+F reaches the browser's find", () => {
        mountInto();

        pressFind();

        expect(mountedIds()).toHaveLength(THREAD_LENGTH);
    });

    it.each([
        ["F3", { code: "F3", key: "F3" }],
        ["Shift+F3", { code: "F3", key: "F3", shiftKey: true }],
        ["Ctrl+G", { code: "KeyG", ctrlKey: true, key: "g" }],
        ["Cmd+Shift+G", { code: "KeyG", key: "G", metaKey: true, shiftKey: true }],
    ])("mounts every message once %s reaches the browser's find", (_name, init: KeyboardEventInit) => {
        mountInto();

        pressKey(init);

        expect(mountedIds()).toHaveLength(THREAD_LENGTH);
    });

    it("offers keyboard users a control that shows every earlier message and moves focus to the oldest", async () => {
        const user = userEvent.setup();

        mountInto();

        expect(mountedIds()).not.toContain("m100");

        // The control is the first stop in the thread for Tab, and its name says what it does.
        await user.tab();

        const showAll = screen.getByRole("button", { name: `Show all ${THREAD_LENGTH - ALWAYS_MOUNTED_TAIL} earlier messages` });

        expect(document.activeElement).toBe(showAll);

        await user.keyboard("{Enter}");

        expect(mountedIds()).toHaveLength(THREAD_LENGTH);
        expect(focusedMessageId()).toBe("m0");
        expect(screen.queryByRole("button", { name: SHOW_ALL_NAME })).toBeNull();
    });

    it("keeps the rows a text selection spans mounted while it lasts, then windows them again", async () => {
        mountInto();

        act(() => scrollToMessage("m100"));
        await vi.waitFor(() => expect(mountedIds()).toEqual(expect.arrayContaining(["m100", "m101"])), { timeout: 5000 });

        const rowOf = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-list-message-id="${CSS.escape(id)}"]`)!;
        const first = rowOf("m100");
        const last = rowOf("m101");
        const selection = document.getSelection()!;

        // Select from inside one older reply into the next, as a drag would.
        act(() => {
            const range = document.createRange();

            range.setStart(within(first).getByText("message 100").firstChild!, 2);
            range.setEnd(within(last).getByText("message 101").firstChild!, 5);
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event("selectionchange"));
        });

        // Back to the newest messages: without the selection both rows would leave the window.
        act(() => viewport().scrollTo({ top: THREAD_LENGTH * 100 }));
        await vi.waitFor(() => expect(mountedIds()).not.toContain("m99"), { timeout: 5000 });

        expect(rowOf("m100")).toBe(first);
        expect(rowOf("m101")).toBe(last);
        expect(selection.toString()).not.toBe("");

        act(() => {
            selection.removeAllRanges();
            document.dispatchEvent(new Event("selectionchange"));
        });

        await vi.waitFor(() => expect(mountedIds()).not.toContain("m100"), { timeout: 5000 });
        expect(mountedIds()).not.toContain("m101");
    });

    it("has no show-all control while every message is mounted", () => {
        localStorage.setItem(VIRTUALIZE_FLAG_KEY, "0");

        mountInto();

        expect(screen.queryByRole("button", { name: SHOW_ALL_NAME })).toBeNull();
    });

    it("keeps the streaming reply and the newest messages mounted while a run streams", () => {
        harness.activeStreamId = "stream-1";

        mountInto();

        expect(screen.getAllByRole("listitem").at(-1)?.querySelector("[data-testid=streaming-placeholder]")).not.toBeNull();
        expect(mountedIds()).toContain(`m${THREAD_LENGTH - 1}`);
    });

    it("keeps the tail mounted and pulls in older pages for a jump into history not loaded yet", async () => {
        const pages: number[] = [];

        harness.messagesStatus = "CanLoadMore";
        harness.loadMore = (count: number) => {
            pages.push(count);
        };
        mountInto();

        act(() => scrollToMessage("older-5"));
        await vi.waitFor(() => expect(pages).toHaveLength(1));

        // The older page lands in front of the loaded history.
        const older = Array.from(
            { length: 20 },
            (_, index) => ({ ...makeMessage(index, `older ${index}`), id: `older-${index}`, key: `older-${index}` }) as UIMessage,
        );

        harness.messages = [...older, ...(harness.messages as UIMessage[])];
        harness.messagesStatus = "Exhausted";
        act(() => harness.publish?.());

        await vi.waitFor(() => expect(focusedMessageId()).toBe("older-5"), { timeout: 5000 });
        expect(mountedIds()).toContain(`m${THREAD_LENGTH - 1}`);
        expect(mountedIds().length).toBeLessThan(THREAD_LENGTH / 2);
    });

    describe("read aloud", () => {
        const speechSynthesisStub = { cancel: vi.fn(), speak: vi.fn() };

        const row = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-list-message-id="${CSS.escape(id)}"]`);

        /** Jumps to an older reply in the virtualized head and starts reading it aloud. */
        let user: UserEvent;

        const readOlderReply = async (id: string): Promise<void> => {
            act(() => scrollToMessage(id));
            await vi.waitFor(() => expect(row(id)).not.toBeNull(), { timeout: 5000 });

            const button = within(row(id)!).getByRole("button", { name: "Read aloud" });

            await user.click(button);

            expect(getReadAloudId()).toBe(id);
            expect(document.activeElement).toBe(button);
        };

        beforeEach(() => {
            user = userEvent.setup();
            harness.withReadAloud = true;
            speechSynthesisStub.cancel.mockClear();
            speechSynthesisStub.speak.mockClear();
            vi.stubGlobal("speechSynthesis", speechSynthesisStub);
            vi.stubGlobal("SpeechSynthesisUtterance", SilentUtterance);
        });

        afterEach(() => {
            stopReadAloud();
        });

        it("keeps reading an older reply after it scrolls out of the window, and its row offers Stop again", async () => {
            mountInto();
            await readOlderReply("m101");

            const cancelsWhileStarting = speechSynthesisStub.cancel.mock.calls.length;

            // Back to the newest messages: the virtualizer unmounts the reply that is reading.
            act(() => viewport().scrollTo({ top: THREAD_LENGTH * 100 }));
            await vi.waitFor(() => expect(row("m101")).toBeNull(), { timeout: 5000 });

            expect(getReadAloudId()).toBe("m101");
            expect(speechSynthesisStub.cancel).toHaveBeenCalledTimes(cancelsWhileStarting);

            // Scrolled back into view, the remounted row knows it is reading and stops it.
            act(() => scrollToMessage("m101"));
            await vi.waitFor(() => expect(row("m101")).not.toBeNull(), { timeout: 5000 });
            const stop = within(row("m101")!).getByRole("button", { name: "Stop reading" });

            await user.click(stop);

            expect(document.activeElement).toBe(stop);

            expect(getReadAloudId()).toBeNull();
            expect(speechSynthesisStub.cancel).toHaveBeenCalledTimes(cancelsWhileStarting + 1);
        });

        it("stops reading when the thread is left", async () => {
            mountInto();
            await readOlderReply("m101");

            harness.threadId = "thread-2";
            harness.messages = Array.from({ length: 4 }, (_, index) => ({ ...makeMessage(index), id: `b${index}`, key: `b${index}` }) as UIMessage);
            act(() => harness.publish?.());

            expect(getReadAloudId()).toBeNull();
        });

        it("stops reading when the list goes away", async () => {
            const { unmount } = mountInto();

            await readOlderReply("m101");
            unmount();

            expect(getReadAloudId()).toBeNull();
        });

        it("stops reading when the message that is reading is deleted", async () => {
            mountInto();
            await readOlderReply("m101");

            harness.messages = (harness.messages as UIMessage[]).filter((message) => message.id !== "m101");
            act(() => harness.publish?.());

            expect(getReadAloudId()).toBeNull();
        });
    });
});
