import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { API_KEYS, apiKeyHandlers } from "@/storybook/fixtures/api-keys";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraHandlers } from "@/storybook/lunora";

import APIKeysCard from "./api-keys-card";

const meta = {
    component: APIKeysCard,
    decorators: [
        (Story) => (
            <div className="w-[40rem]">
                <Story />
            </div>
        ),
    ],
    parameters: {
        msw: {
            handlers: {
                apiKeys: apiKeyHandlers(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    lunora(api.auth.api_keys.createScopedApiKey, ({ name, scopes }) => {
                        return { expiresAt: null, id: "key_new", key: "app_storybook_example_key", name, scopes, start: "app_stor" };
                    }),
                ),
            },
        },
    },
    title: "Settings/API keys",
} satisfies Meta<typeof APIKeysCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Keys with scopes, an expiry, a last use, and one that has never been used. */
export const WithKeys: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(API_KEYS[0]?.name ?? "")).toBeVisible();
    },
};

export const Empty: Story = {
    parameters: { msw: { handlers: { apiKeys: apiKeyHandlers([]) } } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/no api keys found/i)).toBeVisible();
    },
};

/** `/api-key/list` has not answered yet. */
export const Loading: Story = { parameters: { msw: { handlers: { apiKeys: apiKeyHandlers("pending") } } } };

export const CreateDialog: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: /create api key/i }));
        const dialog = await screen.findByRole("dialog");

        // The popup fades in from `opacity: 0`.
        await waitFor(async () => {
            await expect(dialog).toBeVisible();
        });
    },
};
