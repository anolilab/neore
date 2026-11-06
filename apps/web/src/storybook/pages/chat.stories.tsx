import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Route as ThreadRoute } from "@/routes/(chat)/chat/$threadId";
import { Route as ChatIndexRoute } from "@/routes/(chat)/chat/index";
import { Route as ChatLayoutRoute } from "@/routes/(chat)/route";
import { ago, MINUTE } from "@/storybook/clock";
import { assistantMessage, chatFixtures, CONVERSATION, streamingBody, THREAD_IDS, userMessage } from "@/storybook/fixtures/chat";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// Page data arrives after the route loads; under a loaded machine that can outlast the 1 s default of `find*`.
const PAGE_WAIT = { timeout: 5000 } as const;

/** The chat: the real `(chat)` layout (sidebar, header, command palette) and the thread page. */
const meta = {
    args: {
        levels: [
            { id: "(chat)", route: ChatLayoutRoute },
            { path: "chat/$threadId", route: ThreadRoute },
        ],
        url: `/chat/${THREAD_IDS.main}`,
    },
    component: StoryPage,
    parameters: {
        // Composer controls (model picker, search mode, goal) still set their labels at /30–/50 opacity: the picker
        // work is the one with its own `todo`. Thread rows, sidebar and code blocks are checked here.
        // Still failing axe, so the page is `todo` for now: the composer's muted labels (model trigger "Select model...",
        // the search-mode and goal labels) at about 1.5–1.9:1, and the scroll wrapper Streamdown puts round a code block
        // (not focusable, no `tabIndex` hook in its API). Thread rows, the sidebar and code tokens pass.
        a11y: { test: "todo" },
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

/** A reply streaming in from the gateway, word by word, with its reasoning first. */
export const Streaming: Story = {
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

/** A thread shared with the viewer read-only: no composer. */
export const ReadOnlyShare: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures({ permission: "read" })) } },
    },
};

/** The connection to the backend dropped: the banner above the composer. */
export const Reconnecting: Story = { parameters: { connection: "connecting" } };

export const Offline: Story = { parameters: { connection: "offline" } };

/** A fresh chat, before the first message. */
export const NewChat: Story = {
    args: {
        levels: [
            { id: "(chat)", route: ChatLayoutRoute },
            { path: "chat/", route: ChatIndexRoute },
        ],
        url: "/chat",
    },
};

export const Guest: Story = { parameters: { persona: "guest" } };

export const FreeUser: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures({ tier: "free" }), ...chatFixtures()) } },
        persona: "free",
    },
};
