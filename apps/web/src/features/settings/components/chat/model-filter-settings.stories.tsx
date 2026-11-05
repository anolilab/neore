import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor } from "storybook/test";

import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraAnswered, lunoraHandlers, lunoraPending } from "@/storybook/lunora";

import ModelFilterSettings from "./model-filter-settings";

const meta = {
    component: ModelFilterSettings,
    decorators: [
        (Story) => (
            <div className="w-[48rem]">
                <Story />
            </div>
        ),
    ],
    parameters: {
        layout: "padded",
        msw: { handlers: { gateway: gatewayModelsHandler(), lunora: lunoraHandlers(...userFixtures()) } },
    },
    title: "Settings/Models/Filters",
} satisfies Meta<typeof ModelFilterSettings>;

export default meta;

type Story = StoryObj<typeof meta>;

/** No rules: every model is allowed. */
export const NoRules: Story = {};

/** "EU only", plus hidden labs and a blocked provider. */
export const RulesActive: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures({
                        preferences: {
                            modelFilterRules: { allowedRegions: ["EU"], blockedCreators: ["meta", "xai"], blockedProviders: ["fal"] },
                        },
                    }),
                ),
            },
        },
    },
};

/** Zero data retention and no data collection: Workers AI drops out of every list. */
export const PrivacyRules: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures({ preferences: { modelFilterRules: { denyDataCollection: true, requireZDR: true } } })),
            },
        },
    },
};

/** Preferences have not loaded yet. */
export const Loading: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), lunoraPending(api.auth.functions.getAIUserPreferences)) } },
    },
};

export const ToggleZeroDataRetention: Story = {
    play: async ({ canvas }) => {
        const toggle = await canvas.findByRole("switch", { name: /zero data retention/i });

        await lunoraAnswered(api.auth.functions.getAIUserPreferences);
        await userEvent.click(toggle);
        // Saved through the stateful fixture, so the refetch keeps it on.
        await waitFor(async () => {
            await expect(toggle).toBeChecked();
        });
    },
};
