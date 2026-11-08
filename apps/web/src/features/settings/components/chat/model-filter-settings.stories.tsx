import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraAnswered, lunoraError, lunoraHandlers, lunoraIdle, lunoraPending } from "@/storybook/lunora";

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

/** Preferences failed to load: the page renders without rules and an edit is refused. */
export const LoadError: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures(), lunoraError(api.auth.functions.getAIUserPreferences, "INTERNAL", "Shard unavailable", 500)),
            },
        },
    },
};

/** The save is refused: the switch goes back and a toast says so. */
export const SaveFails: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures(), lunoraError(api.auth.functions.updateAIUserPreferences, "RATE_LIMITED", "Too many updates", 429)),
            },
        },
    },
    play: async ({ canvas }) => {
        const toggle = await canvas.findByRole("switch", { name: /zero data retention/i });

        await lunoraAnswered(api.auth.functions.getAIUserPreferences);
        await userEvent.click(toggle);
        // The save was refused, so the failure toast shows, and the switch ends where it started.
        await expect(await screen.findByText("Failed to update filter rules")).toBeInTheDocument();
        await waitFor(async () => {
            await expect(toggle).not.toBeChecked();
        });
    },
};

export const ToggleZeroDataRetention: Story = {
    // The unchecked switch track meets 3:1 (non-text contrast) in every mode since the `--input` token was darkened.
    play: async ({ canvas }) => {
        const zdr = async () => await canvas.findByRole("switch", { name: /zero data retention/i });

        // The edit builds on the loaded preferences: wait for them, and for the page to settle, so no refetch still in
        // flight replaces the switch or the rules under the click.
        await lunoraAnswered(api.auth.functions.getAIUserPreferences);
        await lunoraIdle();
        await userEvent.click(await zdr());
        // The save went through (a refused one shows "Failed to update filter rules" instead)...
        await expect(await screen.findByText("Filter rules updated")).toBeInTheDocument();
        // ...and the stateful fixture kept it, so the switch on the page now, not the node first found, reads on.
        await waitFor(async () => {
            await expect(await zdr()).toBeChecked();
        });
    },
};
