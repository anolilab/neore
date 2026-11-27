import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { ChatProvider } from "@/features/chat/core/context/chat-context";
import { ASIDE_FIND_EVENT } from "@/features/keyboard/lib/aside-find-target";
import { chatFixtures, THREAD_IDS } from "@/storybook/fixtures/chat";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraHandlers } from "@/storybook/lunora";

import AsidePanel from "./aside-panel";
import type { AsideEntry } from "./aside-store";
import { useAsideStore } from "./aside-store";

/** Two answered side questions and one still waiting, so the find has hits in a question and in an answer. */
const ENTRIES: AsideEntry[] = [
    {
        answer: "Safe to repeat: calling it again gives the same result.",
        id: "a",
        question: "What is idempotent?",
        status: "answered",
        token: "tok-a",
        withThread: true,
    },
    {
        answer: "Yes. A retry is idempotent when the server ignores the second write.",
        id: "b",
        question: "Does a retry change the order?",
        status: "answered",
        token: "tok-b",
        withThread: true,
    },
    { id: "c", question: "Is the webhook idempotent too?", status: "pending" },
];

/** Seeds the side-question store before each story renders; the store is per browser session. */
const seed = (entries: AsideEntry[]) => () => {
    useAsideStore.setState({ byThread: { [THREAD_IDS.main]: entries } });
};

const meta = {
    args: { threadId: THREAD_IDS.main },
    component: AsidePanel,
    decorators: [
        (Story) => (
            // The panel sits in the right sidebar, about this wide.
            <ChatProvider jwtToken="storybook" threadId={THREAD_IDS.main}>
                <div className="bg-background text-foreground h-dvh w-80 overflow-y-auto px-2">
                    <Story />
                </div>
            </ChatProvider>
        ),
    ],
    parameters: {
        layout: "fullscreen",
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...chatFixtures()) } },
    },
    title: "Chat/Side question",
} satisfies Meta<typeof AsidePanel>;

export default meta;

type Story = StoryObj<typeof meta>;

/** No side question yet: the field to ask one, and nothing to find. */
export const Empty: Story = {
    loaders: [seed([])],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(await canvas.findByRole("textbox", { name: "Your side question" })).toBeVisible();
        await expect(canvas.queryByRole("search")).toBeNull();
    },
};

/** Answered and pending questions, the find closed: the panel as it reads day to day. */
export const Answered: Story = {
    loaders: [seed(ENTRIES)],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(await canvas.findByText("What is idempotent?")).toBeVisible();
        await expect(await canvas.findByText("Thinking…")).toBeVisible();
        await expect(canvas.queryByRole("search")).toBeNull();
    },
};

/** The Find shortcut opened over the panel, a query with three hits (two in questions, one in an answer), on the first. */
export const FindWithMatches: Story = {
    loaders: [seed(ENTRIES)],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(await canvas.findByText("What is idempotent?")).toBeVisible();
        globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));

        const input = await canvas.findByRole("textbox", { name: "Find in side questions" });

        await userEvent.type(input, "idempotent");
        await expect(await canvas.findByText("1 of 3")).toBeVisible();
    },
};

/** A query the panel does not contain: the bar says so and the step buttons stay off. */
export const FindNoMatches: Story = {
    loaders: [seed(ENTRIES)],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(await canvas.findByText("What is idempotent?")).toBeVisible();
        globalThis.dispatchEvent(new CustomEvent(ASIDE_FIND_EVENT));

        const input = await canvas.findByRole("textbox", { name: "Find in side questions" });

        await userEvent.type(input, "zebra");
        await expect(await canvas.findByText("No matches")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Next match" })).toBeDisabled();
    },
};

/** The same find in dark mode, for the highlight colours against the dark panel. */
export const FindWithMatchesDark: Story = {
    ...FindWithMatches,
    globals: { theme: "dark" },
    name: "Find with matches (dark)",
};
