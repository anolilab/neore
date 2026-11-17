import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { STORY_NOW } from "@/storybook/clock";
import { userFixtures } from "@/storybook/fixtures/user";
import type { LunoraFixture } from "@/storybook/lunora";
import { lunora, lunoraError, lunoraHandlers } from "@/storybook/lunora";

import DailyBriefOffer from "./daily-brief-offer";

const HOUR = 60 * 60 * 1000;

const handlers = (...fixtures: LunoraFixture[]) =>
    lunoraHandlers(
        ...userFixtures(),
        lunora(api.notifications.daily_brief.setDailyBriefEnabled, { nextBriefAt: STORY_NOW + 18 * HOUR, timeZone: "Europe/Berlin" }),
        lunora(api.notifications.daily_brief.dismissDailyBriefOffer, null),
        ...fixtures,
    );

const meta = {
    args: { offered: true },
    component: DailyBriefOffer,
    parameters: { layout: "padded", msw: { handlers: { lunora: handlers() } } },
    title: "Pages/Home/Daily Brief offer",
} satisfies Meta<typeof DailyBriefOffer>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Someone with a few chats who never decided: the offer, with both answers. */
export const Offered: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("heading", { name: "Daily Brief" })).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Turn it on" })).toBeEnabled();
        await expect(canvas.getByRole("button", { name: "Not now" })).toBeEnabled();
    },
};

/** After "Turn it on": when the first brief arrives, in the user's zone, and where to change it. */
export const TurnedOn: Story = {
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Turn it on" }));

        await expect(await canvas.findByRole("status")).toHaveTextContent("07:00");
        await expect(canvas.getByRole("link", { name: "Change it in settings" })).toBeVisible();
    },
};

/** The setter failed: an alert, and both answers stay. */
export const TurnOnFailed: Story = {
    parameters: {
        msw: { handlers: { lunora: handlers(lunoraError(api.notifications.daily_brief.setDailyBriefEnabled, "INTERNAL_SERVER_ERROR", "down", 500)) } },
    },
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Turn it on" }));

        await expect(await canvas.findByRole("alert")).toHaveTextContent("Could not turn on the Daily Brief.");
        await expect(canvas.getByRole("button", { name: "Not now" })).toBeEnabled();
    },
};
