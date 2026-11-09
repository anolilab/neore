import { api } from "@neore/backend/api";
import { SidebarProvider } from "@neore/ui/components/sidebar";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { useState } from "react";
import { expect, spyOn, userEvent, waitFor } from "storybook/test";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { chatDefaultOpen, chatSidebarNames, chatSidebarStyle } from "@/features/chat/shell-layout";
import type { ChatMessage } from "@/storybook/fixtures/chat";
import { assistantMessage, chatFixtures, CONVERSATION, pageOf, STREAM_ID, streamingBody, THREAD_IDS, THREADS, userMessage } from "@/storybook/fixtures/chat";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { ownedBy } from "@/storybook/fixtures/owner";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraHandlers } from "@/storybook/lunora";

import ChatSplitView from "./chat-split-view";
import { clearComposerDrafts } from "./composer-drafts";
import { useSplitLayoutStore } from "./split-layout-store";

// Page data arrives after the route loads; under a loaded machine that can outlast the 1 s default of `find*`.
const PAGE_WAIT = { timeout: 5000 } as const;
// The state a story names (a stream's text) follows the first load and the polling.
const STATE_WAIT = { timeout: 15_000 } as const;

const DESKTOP_QUERY = "(min-width: 768px)";

/** The same query the split view asks, so a play can tell which layout it was given. */
const isWide = (): boolean => globalThis.matchMedia(DESKTOP_QUERY).matches;

/** Seeds the saved layout the split view reads when it mounts, and starts every story with no parked drafts and an empty composer. */
const seed = (panes: string[], focus = 0): void => {
    const layout = { focus, panes, sizes: {} };

    localStorage.setItem("chat-split-layout", JSON.stringify({ state: { layout }, version: 1 }));
    useSplitLayoutStore.setState({ layout });
    clearComposerDrafts();
    useChatUIStore.getState().clearComposer();
};

const BY_ID: Record<string, (typeof THREADS)[keyof typeof THREADS]> = Object.fromEntries(Object.values(THREADS).map((thread) => [thread._id, thread]));

const reply = (text: string): ChatMessage[] => [userMessage(`Question about ${text}`, 0), assistantMessage(`Here is what I know about ${text}.`, 0)];

/** What each thread says. The shared chat fixtures answer every id with the same chat, which would make the panes identical. */
const MESSAGES: Record<string, ChatMessage[]> = {
    [THREAD_IDS.main]: CONVERSATION,
    [THREAD_IDS.older]: [...reply("Rust lifetimes"), userMessage("Now draft the announcement email.", 1)],
    [THREAD_IDS.pinned]: reply("the weekly update"),
    [THREAD_IDS.project]: reply("pricing copy"),
    [THREAD_IDS.recent]: reply("a flaky test"),
};

const ownedAll = (messages: ChatMessage[]): ChatMessage[] => messages.map((message) => ownedBy(message));

/** Per-thread answers on top of the shared chat fixtures; `streaming` names the one thread with a reply on its way. */
const perThread = (streaming?: string) => [
    lunora(api.chat.compaction.getCompactionStatus, { canCompact: false, contextTokens: 0 }),
    lunora(api.chat.functions.getThread, ({ threadId }) => ownedBy(BY_ID[threadId] ?? THREADS.main)),
    lunora(
        api.chat.composite.getThreadPaneState,
        ({ threadId }) => ({ childThreads: [], goal: null, relationship: null, title: (BY_ID[threadId] ?? THREADS.main).title }) as never,
    ),
    lunora(
        api.chat.composite.getThreadWithData,
        ({ threadId }) =>
            ({
                messages: pageOf(ownedAll(MESSAGES[threadId] ?? CONVERSATION)),
                permission: "admin",
                suggestions: { suggestions: [] },
                thread: ownedBy(BY_ID[threadId] ?? THREADS.main),
            }) as never,
    ),
    lunora(api.chat.functions.getThreadUIMessages, ({ threadId }) => pageOf(ownedAll(MESSAGES[threadId] ?? CONVERSATION)) as never),
    lunora(api.chat.streaming.getActiveStreamForThread, ({ threadId }) =>
        streaming !== undefined && threadId === streaming ? ({ streamId: STREAM_ID } as never) : null,
    ),
];

const handlers = (streaming?: string) => {
    return {
        gateway: gatewayModelsHandler(),
        lunora: lunoraHandlers(
            ...userFixtures(),
            ...shellFixtures(),
            ...chatFixtures(),
            ...perThread(streaming),
            ...(streaming
                ? [
                      lunora(
                          api.chat.streaming.getStreamBody,
                          streamingBody("Subject: Meet the new Neore\n\nHi there,\n\nToday we are launching onboarding, billing and docs.", { hang: true }),
                      ),
                  ]
                : []),
        ),
    };
};

const WithPanelSlot = (args: ComponentProps<typeof ChatSplitView>) => {
    const [slot, setSlot] = useState<HTMLDivElement | null>(null);

    return (
        <div className="flex h-full">
            <div className="h-full min-w-0 flex-1">
                <ChatSplitView {...args} sidebarSlot={slot} />
            </div>
            <div aria-label="Thread details" data-sidebar-right-wrapper="" ref={setSlot} role="complementary" />
        </div>
    );
};

/**
 * What is still animating in the panes (the card, its header, and the composer that mounts in the focused pane): moving focus
 * must not animate any of it.
 */
const paneAnimations = (): string[] =>
    document
        .getAnimations()
        .filter((animation) => {
            const target = (animation.effect as KeyframeEffect | null)?.target;

            return (
                animation.playState === "running" &&
                animation.effect?.getComputedTiming().iterations !== Infinity &&
                target?.closest("[data-split-view]") != null
            );
        })
        .map((animation) => {
            const target = (animation.effect as KeyframeEffect).target as Element;

            return `${animation.constructor.name} ${(animation as CSSTransition).transitionProperty ?? (animation as CSSAnimation).animationName} on <${target.tagName.toLowerCase()} class="${String(target.getAttribute("class")).slice(0, 80)}">`;
        });

/** Several chats side by side. The saved layout is seeded per story; the route's chat is always one of the panes. */
const meta = {
    args: { jwtToken: "storybook", routeThreadId: THREAD_IDS.main, sidebarSlot: null },
    component: ChatSplitView,
    decorators: [
        (Story) => (
            <SidebarProvider defaultOpen={chatDefaultOpen} sidebarNames={chatSidebarNames} style={chatSidebarStyle}>
                <div className="bg-background h-dvh w-full">
                    <Story />
                </div>
            </SidebarProvider>
        ),
    ],
    parameters: { layout: "fullscreen", msw: { handlers: handlers() } },
    // The page's wrapper for the right-hand panel, which the focused pane renders its chat's details into.
    render: (args) => <WithPanelSlot {...args} />,
    title: "Chat/Split view",
} satisfies Meta<typeof ChatSplitView>;

export default meta;

type Story = StoryObj<typeof meta>;

/** One chat: a pane with its header and the live composer. */
export const OnePane: Story = {
    // color-contrast (#548): the code block in this thread inherits #e2e8f0 on the light page, as in the chat page story.
    parameters: { a11y: { test: "todo" } },
    loaders: [async () => seed([THREAD_IDS.main])],
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("region", { name: "Plan the Q1 product launch" }, PAGE_WAIT)).toBeInTheDocument();
        await expect(await canvas.findByRole("textbox", { name: "Message" }, PAGE_WAIT)).toBeInTheDocument();
        // The only pane cannot be closed: a split view without a chat has nothing to show.
        await expect(canvas.queryByRole("button", { name: /^Close pane/ })).not.toBeInTheDocument();
    },
};

/** Two chats: the focused one has the composer, the other a one-line stub. */
export const TwoPanes: Story = {
    loaders: [async () => seed([THREAD_IDS.main, THREAD_IDS.pinned])],
    play: async ({ canvas }) => {
        const wide = isWide();

        await expect(await canvas.findByRole("region", { name: "Plan the Q1 product launch" }, PAGE_WAIT)).toBeInTheDocument();
        await expect(await canvas.findAllByRole("textbox", { name: "Message" }, PAGE_WAIT)).toHaveLength(1);

        if (wide) {
            await expect(await canvas.findByRole("region", { name: "Weekly team update draft" }, PAGE_WAIT)).toBeInTheDocument();
            await expect(await canvas.findByRole("button", { name: "Continue in this chat" })).toBeInTheDocument();
            await expect(canvas.getByRole("separator", { name: "Resize chats" })).toBeInTheDocument();

            // Cards 8px apart with no line between, and a 36px header (mirrored panes in RTL: sort by position).
            const [left, right] = [
                canvas.getByRole("region", { name: "Plan the Q1 product launch" }),
                canvas.getByRole("region", { name: "Weekly team update draft" }),
            ].toSorted((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

            await expect(Math.abs((right as HTMLElement).getBoundingClientRect().left - (left as HTMLElement).getBoundingClientRect().right - 8)).toBeLessThan(
                1,
            );
            await expect((left as HTMLElement).querySelector("header")?.getBoundingClientRect().height).toBe(36);
        } else {
            // A phone shows the focused chat alone.
            await expect(canvas.queryByRole("button", { name: "Continue in this chat" })).not.toBeInTheDocument();
        }
    },
};

/** Three chats are the most there is room for: opening a fourth from the sidebar changes nothing. */
export const CappedAtThreePanes: Story = {
    loaders: [async () => seed([THREAD_IDS.main, THREAD_IDS.pinned, THREAD_IDS.recent], 1)],
    play: async ({ canvas }) => {
        // The route's chat is shown by the page, so it takes focus even though the saved layout had another.
        await expect(await canvas.findByRole("region", { name: "Plan the Q1 product launch" }, PAGE_WAIT)).toBeInTheDocument();
        await expect(await canvas.findAllByRole("textbox", { name: "Message" }, PAGE_WAIT)).toHaveLength(1);

        if (isWide()) {
            await expect(await canvas.findByRole("region", { name: "Weekly team update draft" }, PAGE_WAIT)).toBeInTheDocument();
            await expect(await canvas.findByRole("region", { name: "Fix flaky Playwright test" }, PAGE_WAIT)).toBeInTheDocument();

            // What the sidebar's "Open in split view" does; the layout refuses a fourth pane.
            useSplitLayoutStore.getState().dispatch({ threadId: THREAD_IDS.older, type: "open" });

            await expect(useSplitLayoutStore.getState().layout.panes).toEqual([THREAD_IDS.main, THREAD_IDS.pinned, THREAD_IDS.recent]);
            await expect(canvas.queryByRole("region", { name: "Rust lifetimes, explained" })).not.toBeInTheDocument();
            await expect(canvas.getByRole("region", { name: "Weekly team update draft" })).toBeInTheDocument();
            await expect(canvas.getAllByRole("button", { name: "Continue in this chat" })).toHaveLength(2);
            await expect(canvas.getAllByRole("separator", { name: "Resize chats" })).toHaveLength(2);
        }
    },
};

/** A reply is still arriving in the chat that does not have focus: it keeps streaming, and the focused chat is untouched. */
export const BackgroundPaneStreaming: Story = {
    loaders: [async () => seed([THREAD_IDS.main, THREAD_IDS.older])],
    parameters: { msw: { handlers: handlers(THREAD_IDS.older) } },
    play: async ({ canvas }) => {
        if (!isWide()) {
            await expect(await canvas.findByRole("region", { name: "Plan the Q1 product launch" }, PAGE_WAIT)).toBeInTheDocument();

            return;
        }

        await expect(await canvas.findByText(/Meet the new Neore/i, undefined, STATE_WAIT)).toBeInTheDocument();
        await expect(await canvas.findByRole("button", { name: "Continue in this chat" })).toBeInTheDocument();
        await expect(await canvas.findAllByRole("textbox", { name: "Message" })).toHaveLength(1);
    },
};

/** Below 768px the split is off: the focused chat shows alone, and the others stay reachable from the sidebar. */
export const NarrowViewport: Story = {
    beforeEach: () => {
        const original = globalThis.matchMedia.bind(globalThis);
        const spy = spyOn(globalThis, "matchMedia").mockImplementation((query: string) =>
            query === DESKTOP_QUERY
                ? ({ addEventListener: () => {}, matches: false, media: query, removeEventListener: () => {} } as unknown as MediaQueryList)
                : original(query),
        );

        return () => spy.mockRestore();
    },
    loaders: [async () => seed([THREAD_IDS.main, THREAD_IDS.pinned])],
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("region", { name: "Plan the Q1 product launch" }, PAGE_WAIT)).toBeInTheDocument();
        await expect(await canvas.findAllByRole("textbox", { name: "Message" }, PAGE_WAIT)).toHaveLength(1);
        await expect(canvas.queryByRole("region", { name: "Weekly team update draft" })).not.toBeInTheDocument();
        await expect(canvas.queryByRole("separator", { name: "Resize chats" })).not.toBeInTheDocument();
    },
};

/** Opens a second chat, types in it, moves focus to the first chat and back: the draft is where it was left. */
export const DraftKeptAcrossFocus: Story = {
    loaders: [async () => seed([THREAD_IDS.main])],
    play: async ({ canvas, step }) => {
        if (!isWide()) {
            // One chat shows on a phone, so there is no other pane to move focus to.
            await expect(await canvas.findByRole("textbox", { name: "Message" }, PAGE_WAIT)).toBeInTheDocument();

            return;
        }

        await canvas.findByRole("textbox", { name: "Message" }, PAGE_WAIT);

        await step("open a second chat", async () => {
            // What the thread row's "Open in split view" does.
            useSplitLayoutStore.getState().dispatch({ threadId: THREAD_IDS.pinned, type: "open" });
            await expect(await canvas.findByRole("region", { name: "Weekly team update draft" }, PAGE_WAIT)).toBeInTheDocument();
        });

        await step("type a draft in the focused pane", async () => {
            const box = await canvas.findByRole("textbox", { name: "Message" }, PAGE_WAIT);

            await userEvent.click(box);
            await userEvent.keyboard("Remind everyone about Friday");
            await waitFor(() => expect(canvas.getByRole("textbox", { name: "Message" })).toHaveTextContent("Remind everyone about Friday"));
        });

        await step("focus the other pane", async () => {
            await userEvent.click(await canvas.findByRole("button", { name: "Focus chat: Plan the Q1 product launch" }));
            await expect(paneAnimations()).toEqual([]);
            await waitFor(() => expect(canvas.getByRole("region", { name: "Plan the Q1 product launch" })).toHaveAttribute("data-focused"));
            await expect(await canvas.findAllByRole("textbox", { name: "Message" })).toHaveLength(1);
            await waitFor(() => expect(canvas.getByRole("textbox", { name: "Message" })).not.toHaveTextContent("Remind everyone about Friday"));
            // The chat that lost focus shows the stub where its composer was.
            await expect(canvas.getByRole("button", { name: "Continue in this chat" })).toBeInTheDocument();
        });

        await step("and back", async () => {
            await userEvent.click(await canvas.findByRole("button", { name: "Continue in this chat" }));
            await waitFor(() => expect(canvas.getByRole("region", { name: "Weekly team update draft" })).toHaveAttribute("data-focused"));
            await waitFor(() => expect(canvas.getByRole("textbox", { name: "Message" })).toHaveTextContent("Remind everyone about Friday"));
            // The stub took focus with it when it went: it lands in the composer, not on the page.
            await waitFor(() => expect(canvas.getByRole("textbox", { name: "Message" })).toHaveFocus());
            await expect(paneAnimations()).toEqual([]);
        });
    },
};
