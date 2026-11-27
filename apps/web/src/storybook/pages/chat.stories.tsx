import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { onlineManager } from "@tanstack/react-query";
import { expect, userEvent, waitFor } from "storybook/test";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import { Route as ThreadRoute } from "@/routes/(chat)/chat/$threadId";
import { Route as ChatIndexRoute } from "@/routes/(chat)/chat/index";
import { Route as ChatLayoutRoute } from "@/routes/(chat)/route";
import { ago, MINUTE } from "@/storybook/clock";
import type { ChatMessage } from "@/storybook/fixtures/chat";
import { assistantMessage, chatFixtures, CONVERSATION, streamingBody, THREAD_IDS, userMessage } from "@/storybook/fixtures/chat";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraError, lunoraHandlers, lunoraIdle } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// Page data arrives after the route loads; under a loaded machine that can outlast the 1 s default of `find*`.
const PAGE_WAIT = { timeout: 5000 } as const;
// The state a story names (a stream's text, a pause, a banner) follows the page's first load and its polling.
const STATE_WAIT = { timeout: 15_000 } as const;

/**
 * The connection banner slides and fades in; axe must read its colours at full opacity, not blended mid-fade with what is
 * behind it.
 */
const bannerShown = async (banner: HTMLElement) => {
    await waitFor(() => expect(getComputedStyle(banner).opacity).toBe("1"), STATE_WAIT);
};

/**
 * The page has finished fading in: the composer, the header and the rest animate in over a few hundred milliseconds, and axe
 * must read their settled colours, not ones blended mid-fade. First the page itself (its route loads after `play` starts) and
 * its data, then every animation that ends (an endless spinner never does), not a fixed time, which a loaded machine outlasts.
 */
const settle = async (canvas: { findByRole: (role: string, options: { name: string }, waitOptions: typeof PAGE_WAIT) => Promise<HTMLElement> }) => {
    await canvas.findByRole("textbox", { name: "Message" }, PAGE_WAIT);
    await lunoraIdle();
    await waitFor(() => {
        const fading = document
            .getAnimations()
            .filter((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity);

        expect(fading).toHaveLength(0);
    }, STATE_WAIT);
};

/** The chat: the real `(chat)` layout (sidebar, header, command palette) and the thread page. */
const meta = {
    args: {
        levels: [
            { id: "/(chat)", route: ChatLayoutRoute },
            { path: "chat/$threadId", route: ThreadRoute },
        ],
        url: `/chat/${THREAD_IDS.main}`,
    },
    component: StoryPage,
    parameters: {
        // Axe runs on the whole page in every mode. Code blocks take the block's foreground colour (see the
        // `[data-streamdown="code-block-body"]` rule in `packages/ui/src/global.css`).
        layout: "fullscreen",
        msw: { handlers: { gateway: gatewayModelsHandler(), lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures()) } },
    },
    title: "Pages/Chat",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Thread: Story = {
    play: async ({ canvas }) => {
        // Named (it had no accessible name before these stories); its fade-in can outlast the query.
        await expect(await canvas.findByRole("textbox", { name: "Message" }, PAGE_WAIT)).toBeInTheDocument();
        // The composer's controls had no accessible name before these stories (#548).
        await expect(await canvas.findAllByRole("button", { name: "Model: Claude Sonnet 4.5" }, PAGE_WAIT)).not.toHaveLength(0);
        await expect(await canvas.findAllByRole("combobox", { name: "Response language: English (US)" }, PAGE_WAIT)).not.toHaveLength(0);
    },
};

const ROUTE_PROMPT = "Draft the launch email";

/**
 * The route prompt is written into the composer even when this exact text was applied to the chat before. On the single-chat page
 * the composer does not remount per focus, so the once-per-chat guard that keeps a split pane's draft must not apply here.
 */
export const RoutePromptWrittenAgain: Story = {
    args: { url: `/chat/${THREAD_IDS.main}?initialMessage=${encodeURIComponent(ROUTE_PROMPT)}` },
    loaders: [
        () => {
            useChatUIStore.getState().clearComposer();
            useChatUIStore.getState().setAppliedInitialMessageKey(`${THREAD_IDS.main}\n${ROUTE_PROMPT}`);
        },
    ],
    play: async ({ canvas }) => {
        await waitFor(() => expect(canvas.getByRole("textbox", { name: "Message" })).toHaveTextContent(ROUTE_PROMPT), PAGE_WAIT);
    },
};

/** The pane-state read fails: the page says so, and the chat stays usable (its messages and composer do not depend on that read). */
export const PaneStateReadFails: Story = {
    parameters: {
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures(),
                    lunoraError(api.chat.composite.getThreadPaneState, "INTERNAL", "Read failed", 500),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        // The thread reads its pane state only after first paint has settled (`useAfterFirstPaint`: browser idle, then 3 s),
        // so the alert arrives later than the page itself.
        await expect(await canvas.findByText("Could not load this chat's details.", undefined, STATE_WAIT)).toBeInTheDocument();
        await expect(await canvas.findByRole("textbox", { name: "Message" }, PAGE_WAIT)).toBeInTheDocument();
    },
};

/** A reply streaming in from the gateway, word by word, with its reasoning first. */
export const Streaming: Story = {
    play: async ({ canvas }) => {
        // The streamed reply has started to render (its first line is in the body before the stream hangs).
        await expect(await canvas.findByText(/Meet the new Neore/i, undefined, STATE_WAIT)).toBeInTheDocument();
    },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures({
                        activeStream: {},
                        messages: [...CONVERSATION, userMessage("Now draft the announcement email.", 2)],
                        streamBody: streamingBody(
                            "Subject: Meet the new Neore\n\nHi there,\n\nToday we are launching onboarding, billing and docs in one release. Here is what changes for you, and what stays the same.",
                            { hang: true, reasoning: "Short, friendly, three things." },
                        ),
                    }),
                ),
            },
        },
    },
};

/** The provider answered 429: the reply waits and resumes on its own, with a countdown. */
export const RateLimitPaused: Story = {
    play: async ({ canvas }) => {
        // The visible line is aria-hidden; the sr-only announcement says "Rate limited by Anthropic. Retrying in about", with a period.
        await expect(await canvas.findByText(/^Rate limited by Anthropic, retrying in /, undefined, STATE_WAIT)).toBeInTheDocument();
    },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures({
                        activeStream: { pause: { provider: "anthropic", reason: "rate_limit", retryAt: ago(-2 * MINUTE), status: 429 } },
                        messages: [...CONVERSATION, userMessage("Now draft the announcement email.", 2)],
                    }),
                ),
            },
        },
    },
};

/** The last reply failed. */
export const FailedReply: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("The model provider returned an error. Try again.", undefined, STATE_WAIT)).toBeInTheDocument();
    },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures({
                        messages: [
                            ...CONVERSATION,
                            userMessage("Now draft the announcement email.", 2),
                            assistantMessage("", 2, { error: "The model provider returned an error. Try again.", status: "failed" }),
                        ],
                    }),
                ),
            },
        },
    },
};

/**
 * A thread whose permission is read-only, shown on the chat route, which still renders its composer for it. The read-only
 * view a share link opens is the public page, asserted in `shared-thread.stories`.
 */
export const ReadOnlyShare: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findAllByText("Plan the Q1 product launch", undefined, STATE_WAIT)).not.toHaveLength(0);
        await settle(canvas);
    },
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures({ permission: "read" })) } },
    },
};

/** The connection to the backend dropped: the banner at the top of the app. */
export const Reconnecting: Story = {
    play: async ({ canvas }) => {
        const banner = await canvas.findByText("Reconnecting to the server…", undefined, STATE_WAIT);

        await expect(banner).toBeInTheDocument();
        await bannerShown(banner);
    },
    // "connecting" reads as online until a socket has opened, and a story's socket never does, so the live status is "offline".
    parameters: { connection: "offline" },
};

export const Offline: Story = {
    // The event below also takes Query's page-wide `onlineManager` offline, which no later `online` event reaches once this
    // story's client has unmounted: put it back when the story ends.
    beforeEach: () => () => {
        onlineManager.setOnline(true);
    },
    play: async ({ canvas }) => {
        // The "offline" view comes from the browser's offline event, not the live status: fire it once the page has mounted.
        await canvas.findByRole("textbox", { name: "Message" }, PAGE_WAIT);
        globalThis.dispatchEvent(new Event("offline"));
        const banner = await canvas.findByText("Offline – reconnecting…", undefined, STATE_WAIT);

        await expect(banner).toBeInTheDocument();
        await bannerShown(banner);
    },
    parameters: { connection: "offline" },
};

/**
 * The story after `Offline` starts online: Query's `onlineManager` is one per page, so an `offline` event left standing pauses
 * every later story's queries and mutations in the same iframe (the Storybook UI keeps one for the whole session).
 */
export const OnlineAfterOffline: Story = {
    play: async ({ canvas }) => {
        await expect(onlineManager.isOnline()).toBe(true);
        await settle(canvas);
        await expect(canvas.queryByText("Offline – reconnecting…")).not.toBeInTheDocument();
    },
};

/** A fresh chat, before the first message. */
export const NewChat: Story = {
    play: async ({ canvas }) => {
        await settle(canvas);
    },
    args: {
        levels: [
            { id: "/(chat)", route: ChatLayoutRoute },
            { path: "chat/", route: ChatIndexRoute },
        ],
        url: "/chat",
    },
};

export const Guest: Story = {
    parameters: { persona: "guest" },
    play: async ({ canvas }) => {
        await settle(canvas);
    },
};

export const FreeUser: Story = {
    play: async ({ canvas }) => {
        await settle(canvas);
    },
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures({ tier: "free" }), ...chatFixtures()) } },
        persona: "free",
    },
};

const LONG_PROMPT = "What is the rollback plan if the billing migration fails halfway?";
const LONG_REPLY = Array.from(
    { length: 4 },
    (_, line) => `Paragraph ${String(line + 1)}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6)}`,
).join("\n\n");

/** Fourteen exchanges, then the person's last question, then three long replies: the question sits far above the bottom. */
const LONG_THREAD: ChatMessage[] = [
    ...Array.from({ length: 14 }, (_, index) => [
        userMessage(`Earlier question ${String(index + 1)}`, index * 2),
        assistantMessage(LONG_REPLY, index * 2 + 1),
    ]).flat(),
    userMessage(LONG_PROMPT, 28),
    assistantMessage(LONG_REPLY, 29),
    assistantMessage(LONG_REPLY, 30),
    assistantMessage(LONG_REPLY, 31),
];

/**
 * A long run of replies after the person's last question. Scrolled up, the control beside scroll-to-bottom jumps back to that
 * question, and the `jumpToLastMessage` shortcut does the same from the keyboard.
 */
export const JumpToLastMessage: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures({ messages: LONG_THREAD })) } },
    },
    play: async ({ canvas }) => {
        await settle(canvas);

        const scroller = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');

        if (!scroller) {
            throw new Error("The thread has no scroll viewport");
        }

        const prompt = await canvas.findByText(LONG_PROMPT, undefined, PAGE_WAIT);
        const row = prompt.closest<HTMLElement>('[role="listitem"]');

        if (!row) {
            throw new Error("The prompt is not in a message row");
        }

        // The prompt's row is centred in the viewport (what the jump scrolls to), or not.
        const isCentred = (): boolean => {
            const box = scroller.getBoundingClientRect();
            const rect = row.getBoundingClientRect();
            const centre = rect.top + rect.height / 2;

            return centre >= box.top && centre <= box.bottom;
        };

        // The thread first scrolls itself to the bottom, a frame after its messages are ready (`thread-viewport.tsx`). Scrolling up
        // before that lands would be undone by it, and the control, shown only away from the bottom, would never appear. The
        // viewport starts at the top and nothing else moves it first.
        await waitFor(() => {
            expect(scroller.scrollTop).toBeGreaterThan(0);
        }, STATE_WAIT);

        // Scrolled up past the question, the way a long run of replies leaves it.
        scroller.scrollTop = 0;
        await waitFor(() => {
            expect(isCentred()).toBe(false);
        }, STATE_WAIT);

        await userEvent.click(await canvas.findByRole("button", { name: "Jump to my last message" }, STATE_WAIT));
        await waitFor(() => {
            expect(isCentred()).toBe(true);
        }, STATE_WAIT);

        // The jump starts unbound, so this story binds the chord a person would set in Settings (Ctrl here, where the platform modifier
        // is Ctrl). Back up again; the shortcut brings the question back. A real key sequence, not one synthetic keydown, so the keyup
        // and focus that a person's press also produces are exercised.
        useUIStateStore.getState().setKeyboardShortcuts({ jumpToLastMessage: "ctrl+shift+l" });
        scroller.scrollTop = 0;
        await waitFor(() => {
            expect(isCentred()).toBe(false);
        }, STATE_WAIT);

        await userEvent.keyboard("{Control>}{Shift>}l{/Shift}{/Control}");
        await waitFor(() => {
            expect(isCentred()).toBe(true);
        }, STATE_WAIT);
    },
};
