import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Route as SharedThreadRoute } from "@/routes/(public)/thread/$token";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// The public page's data arrives after its route loads; under a loaded machine that can outlast the 1 s default of `find*`.
const STATE_WAIT = { timeout: 15_000 } as const;

type PublicThread = NonNullable<ReturnOf<typeof api.chat.sharing.getPublicThread>>;

const SHARED_THREAD = {
    createdAt: Date.UTC(2026, 0, 15),
    messages: [
        { _creationTime: Date.UTC(2026, 0, 15), id: "shared_1", order: 1, parts: [{ text: "Plan the Q1 product launch.", type: "text" }], role: "user" },
        {
            _creationTime: Date.UTC(2026, 0, 15),
            id: "shared_2",
            order: 2,
            parts: [{ state: "done", text: "Start with the onboarding flow, then billing, then docs.", type: "text" }],
            role: "assistant",
        },
    ],
    title: "Plan the Q1 product launch",
    truncated: false,
} as unknown as PublicThread;

const meta = {
    component: StoryPage,
    parameters: {
        layout: "fullscreen",
        msw: { handlers: { gateway: gatewayModelsHandler(), lunora: lunoraHandlers(...userFixtures(), ...shellFixtures()) } },
        persona: "signed-out",
    },
    title: "Pages/Shared thread",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

const levels = [{ path: "thread/$token", route: SharedThreadRoute }];

/** A conversation shared read-only: its messages, and no composer. */
export const Shared: Story = {
    args: { levels, url: "/thread/story-token" },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    lunora(api.chat.sharing.getPublicThread, () => SHARED_THREAD),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Read-only shared conversation", undefined, STATE_WAIT)).toBeInTheDocument();
        await expect(canvas.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    },
};

/** The link no longer shows a conversation: the page says so instead. */
export const Unavailable: Story = {
    args: { levels, url: "/thread/story-token" },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    lunora(api.chat.sharing.getPublicThread, () => null),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("This conversation is not available", undefined, STATE_WAIT)).toBeInTheDocument();
    },
};
