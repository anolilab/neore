import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { onlineManager } from "@tanstack/react-query";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { useCommandDialogStore } from "@/components/command-dialog-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { useGoalComposer } from "@/features/chat/goal/goal-store";
import { useThreadListUIStore } from "@/features/chat/thread-list/stores/thread-list-ui-store";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import { Route as ThreadRoute } from "@/routes/(chat)/chat/$threadId";
import { Route as ChatIndexRoute } from "@/routes/(chat)/chat/index";
import { Route as ChatLayoutRoute } from "@/routes/(chat)/route";
import { ago, DAY, HOUR, MINUTE } from "@/storybook/clock";
import type { ChatMessage } from "@/storybook/fixtures/chat";
import { assistantMessage, chatFixtures, CONVERSATION, pageOf, streamingBody, thread, THREAD_IDS, userMessage } from "@/storybook/fixtures/chat";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraError, lunoraHandlers, lunoraIdle } from "@/storybook/lunora";
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
        await settle(canvas);
    },
};

/**
 * Web search with research depth, a goal armed for the next message and tools that run without asking: the composer's status
 * line names each of them, and the settings strip stays on one row.
 */
export const StatusLineArmed: Story = {
    beforeEach: () => {
        useModelStore.getState().setSearchMode("web");
        useModelStore.getState().setResearchDepth("thorough");
        useGoalComposer.getState().setEnabled(true);

        return () => {
            useModelStore.getState().setSearchMode("chat");
            useModelStore.getState().setResearchDepth("balanced");
            useGoalComposer.getState().setEnabled(false);
        };
    },
    parameters: {
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures(),
                    lunora(api.chat.thread_state.getEffectivePermissionMode, "full"),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        const status = await canvas.findByRole("group", { name: "Composer status" }, PAGE_WAIT);

        await expect(status).toHaveTextContent("Web · Thorough");
        await expect(status).toHaveTextContent("Goal: run until done");
        await expect(await canvas.findByText("Tools run without asking", undefined, STATE_WAIT)).toBeInTheDocument();
    },
};

/** Web search with depth and full access, no goal: the busiest strip that is not wrapped by a goal's own pills. */
export const StatusLineSearchFullAccess: Story = {
    beforeEach: () => {
        useModelStore.getState().setSearchMode("web");
        useModelStore.getState().setResearchDepth("thorough");

        return () => {
            useModelStore.getState().setSearchMode("chat");
            useModelStore.getState().setResearchDepth("balanced");
        };
    },
    parameters: StatusLineArmed.parameters,
    play: async ({ canvas }) => {
        const status = await canvas.findByRole("group", { name: "Composer status" }, PAGE_WAIT);

        await expect(status).toHaveTextContent("Web · Thorough");
        await expect(status).not.toHaveTextContent("Goal");
        // The search suggestions fade in after the status line: axe reads them settled.
        await settle(canvas);
    },
};

/** A bot's thread: the bot sets the model, said once in the status line, and the picker is locked. */
export const BotThread: Story = {
    parameters: {
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures({ thread: thread({ _id: THREAD_IDS.main, botId: "bot_weekly", title: "Weekly numbers" } as Parameters<typeof thread>[0]) }),
                    lunora(api.bots.functions.listBots, [
                        { _id: "bot_weekly", model: "anthropic/claude-sonnet-4.5", name: "Weekly Bot" },
                    ] as unknown as ReturnOf<typeof api.bots.functions.listBots>),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("The bot sets the model for this chat.", undefined, PAGE_WAIT)).toBeInTheDocument();
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

/** The composer's permission menu: each mode with what it allows, the widest one marked. */
export const PermissionMenuOpen: Story = {
    play: async ({ canvas }) => {
        await settle(canvas);
        const [trigger] = await canvas.findAllByRole("button", { name: /^Permission mode:/ }, PAGE_WAIT);

        await userEvent.click(trigger as HTMLElement);

        const menu = within(document.body);
        const full = await menu.findByRole("menuitemradio", { name: /Full access/ }, PAGE_WAIT);

        await waitFor(() => expect(full).toBeVisible());
        await expect(menu.getByRole("menuitemradio", { name: /Supervised/ })).toBeVisible();
        // The trigger names itself as a mode, not as a second bare "Auto" beside the model's toggle.
        await expect(trigger).toHaveTextContent("Mode: Auto");
    },
};

/**
 * The header keeps Share and the side panel; the rest is one labelled overflow menu. An ordinary chat has no "Link pull request"
 * button: it is offered on chats that run code on a computer, or once a pull request is linked.
 */
export const HeaderOverflowOpen: Story = {
    play: async ({ canvas }) => {
        await settle(canvas);
        await expect(canvas.queryByRole("button", { name: "Link pull request" })).not.toBeInTheDocument();
        await userEvent.click(await canvas.findByRole("button", { name: "More actions" }, PAGE_WAIT));

        const menu = within(document.body);

        await waitFor(() => expect(menu.getByRole("button", { name: "Toggle theme" })).toBeVisible());
        await expect(menu.getByRole("button", { name: "Chat actions" })).toBeVisible();
        await expect(menu.getByRole("button", { name: "Knowledge base" })).toBeVisible();
    },
};

/** A chat that runs on a paired computer offers "Link pull request" next to its title. */
export const HostThreadHeader: Story = {
    parameters: {
        // The host composer's textarea carries `role="combobox"` (axe `aria-allowed-role`): it predates this story and belongs to the host
        // composer, not the header this story shows.
        a11y: { test: "todo" },
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures({
                        thread: thread({ _id: THREAD_IDS.main, runner: "host", title: "Refactor the billing worker" } as Parameters<typeof thread>[0]),
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findAllByRole("button", { name: "Link pull request" }, STATE_WAIT)).not.toHaveLength(0);
        await lunoraIdle();
    },
};

const PROJECT_Q1 = { _creationTime: ago(20 * DAY), _id: "project_q1", createdAt: ago(20 * DAY), title: "Q1 Launch", updatedAt: ago(DAY), userId: "user-pro" };

/** A chat on a paired computer: the composer names the computer, the folder and the coding agent in a row under the message box. */
export const HostThreadComposer: Story = {
    parameters: {
        // The host composer's textarea carries `role="combobox"` (axe `aria-allowed-role`): it predates this story, as in `HostThreadHeader`.
        // Axe checks the context row alone.
        a11y: { context: { include: ['[aria-label="Context"]'] } },
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures({
                        thread: thread({ _id: THREAD_IDS.main, runner: "host", title: "Refactor the billing worker" } as Parameters<typeof thread>[0]),
                    }),
                    lunora(api.acp.functions.getHostSession, {
                        _id: "acp_session_1",
                        agentKey: "claude-code",
                        agentLabel: "Claude Code",
                        createdAt: ago(HOUR),
                        deviceId: "device_nova",
                        agentState: {
                            configOptions: [
                                {
                                    category: "model",
                                    choices: [
                                        { name: "Sonnet", value: "sonnet" },
                                        { name: "Opus", value: "opus" },
                                    ],
                                    currentValue: "sonnet",
                                    id: "model",
                                    name: "Model",
                                },
                            ],
                            usage: { size: 200_000, used: 48_000 },
                        },
                        folderLabel: "~/Projects/billing",
                        status: "idle",
                        threadId: THREAD_IDS.main,
                    } as never),
                    lunora(api.devices.functions.listDevices, [
                        {
                            _id: "device_nova",
                            appVersion: "1.14.2",
                            createdAt: ago(60 * DAY),
                            lastSeenAt: ago(MINUTE),
                            name: "nova",
                            platform: "linux",
                            toolNames: ["read_file", "write_file", "run_command"],
                            updateRequired: false,
                        },
                    ] as never),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        const context = await canvas.findByRole("group", { name: "Context" }, STATE_WAIT);

        await waitFor(() => expect(context).toHaveTextContent("nova"), STATE_WAIT);
        await expect(context).toHaveTextContent("~/Projects/billing");
        await expect(context).toHaveTextContent("Claude Code");
        await lunoraIdle();
    },
};

/** A chat filed in a project: a quiet chip under the composer names it. */
export const ThreadInProject: Story = {
    parameters: {
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures({ thread: thread({ _id: THREAD_IDS.main, projectId: "project_q1" } as Parameters<typeof thread>[0]) }),
                    lunora(api.projects.functions.getProject, PROJECT_Q1 as never),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        // The sidebar names the project too, so the chip is read inside the composer's context group.
        const context = await canvas.findByRole("group", { name: "Context" }, STATE_WAIT);

        await expect(await within(context).findByText("Q1 Launch", undefined, STATE_WAIT)).toBeVisible();
        await settle(canvas);
    },
};

/** The command palette open: filters, the groups with their shortcuts and the footer legend. */
export const CommandPaletteOpen: Story = {
    // The thread rows hold archive and delete buttons inside their option (axe `nested-interactive`): a palette row problem that predates this
    // story, kept out of this change. The story still checks everything else the palette renders.
    parameters: { a11y: { test: "todo" } },
    // The palette and the shortcuts sheet live in stores: left open they would cover the next story.
    beforeEach: () => () => {
        useCommandDialogStore.getState().close();
        useThreadListUIStore.getState().setShowKeyboardHelp(false);
    },
    play: async ({ canvas }) => {
        await settle(canvas);
        useCommandDialogStore.getState().openCommandPalette();

        const dialog = within(document.body);
        const input = await dialog.findByPlaceholderText("Search threads, navigate, or perform actions...", undefined, PAGE_WAIT);

        await waitFor(() => expect(input).toBeVisible());
        // The footer legend: move, open, the `#` state filter and close.
        await expect(await dialog.findByText("Navigate", undefined, PAGE_WAIT)).toBeVisible();
        await expect(dialog.getByText("Open")).toBeVisible();
        await expect(dialog.getByText("Filter")).toBeVisible();
        await expect(dialog.getByText("Esc")).toBeVisible();

        // "Keyboard shortcuts" is an entry of the palette, and it opens the sheet.
        await userEvent.click(dialog.getByRole("option", { name: /Keyboard shortcuts/ }));
        const sheet = await dialog.findByRole("dialog", { name: /Keyboard shortcuts/ }, PAGE_WAIT);

        await waitFor(() => expect(sheet).toBeVisible());
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

/** A fresh chat with a project picked: the choice sits under the box, in the context row. */
export const NewChatInProject: Story = {
    args: NewChat.args,
    beforeEach: () => () => useModelStore.getState().setPendingSettings(undefined),
    parameters: {
        // With a project listed, the sidebar's project header (a draggable `role="button"` that holds its own buttons) trips axe
        // `nested-interactive`: the sidebar's, tracked as #547. Axe checks the composer's own row.
        a11y: { context: { include: ["button[aria-pressed]"] } },
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures(),
                    lunora(api.projects.functions.listProjects, () => pageOf([PROJECT_Q1]) as never),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        // Picked once the page has set up its new chat: the page's own setup would otherwise clear a pick made before it.
        await settle(canvas);
        useModelStore.getState().setPendingSettings({ projectId: PROJECT_Q1._id } as never);
        await expect(await canvas.findByRole("button", { name: "File in Q1 Launch", pressed: true }, STATE_WAIT)).toBeVisible();
    },
};

/** A suggestion category opened under the centred composer: the list drops below the chips, over the page, and a pick fills the editor. */
export const NewChatSuggestionsOpen: Story = {
    args: NewChat.args,
    play: async ({ canvas }) => {
        await settle(canvas);
        await userEvent.click(await canvas.findByRole("tab", { name: "Ideas" }, PAGE_WAIT));

        const pick = await canvas.findByRole("button", { name: "Brainstorm creative marketing strategies for a new product" }, PAGE_WAIT);

        await waitFor(() => expect(pick).toBeVisible());
        await expect(pick.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
        await userEvent.click(pick);
        await waitFor(() => expect(canvas.getByRole("textbox", { name: "Message" })).toHaveTextContent("Brainstorm creative marketing strategies"));
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
