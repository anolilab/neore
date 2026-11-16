import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor } from "storybook/test";

import { DEFAULT_MODEL_ID, gatewayModelsHandler, MODEL_CATALOG, MODELS } from "@/storybook/fixtures/models";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunoraHandlers } from "@/storybook/lunora";

import ModelPicker from "./model-picker";

const meta = {
    args: {
        defaultModeFilter: "text",
        favorites: [MODELS.claudeSonnet.id, MODELS.kimi.id],
        footer: null,
        initialModelId: MODELS.claudeSonnet.id,
        models: MODEL_CATALOG,
        onMoveFavorite: fn(),
        onSelect: fn(),
        onSelectMultiple: fn(),
        onToggleFavorite: fn(),
        panelClassName: "h-[32rem]",
    },
    component: ModelPicker,
    decorators: [
        (Story) => (
            <div className="bg-popover w-[42rem] rounded-xl border shadow-lg">
                <Story />
            </div>
        ),
    ],
    parameters: {
        msw: { handlers: { gateway: gatewayModelsHandler(), lunora: lunoraHandlers(...userFixtures()) } },
    },
    title: "Chat/Model picker",
} satisfies Meta<typeof ModelPicker>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A signed-in user with a premium model selected; opens on Starred. */
export const Default: Story = {};

/**
 * The default model selected. It opens scoped to its creator: the "No models found"
 * bug from #539 opened this one on an empty list.
 */
export const DefaultModelSelected: Story = {
    args: { defaultTab: "all", favorites: [], initialModelId: DEFAULT_MODEL_ID },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(MODELS.kimi.name ?? "")).toBeVisible();
        await expect(canvas.queryByText(/no models found/i)).toBeNull();
    },
};

export const AllModels: Story = { args: { defaultTab: "all" } };

/** A free account: premium models are listed but cannot run. */
export const FreeUser: Story = {
    args: { defaultTab: "all", initialModelId: DEFAULT_MODEL_ID },
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures({ canRunPaidModels: false })) } },
        persona: "free",
    },
};

/** A guest: selection is locked to the current model, with the sign-up banner. */
export const Guest: Story = {
    args: { defaultTab: "all", favorites: [], initialModelId: DEFAULT_MODEL_ID, isAnonymous: true },
    parameters: { persona: "guest" },
};

/**
 * "EU only": the user's region rule hides every model not hosted in the EU, and the
 * Workers AI models (served from any region) with them.
 */
export const RegionRuleActive: Story = {
    args: { defaultTab: "all", favorites: [], initialModelId: MODELS.mistral.id, models: undefined },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures({ preferences: { modelFilterRules: { allowedRegions: ["EU"] } } })),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(MODELS.mistral.name ?? "")).toBeVisible();
        await waitFor(async () => {
            await expect(canvas.queryByText(MODELS.gpt.name ?? "")).toBeNull();
        });
    },
};

/** Comparing models side by side: two are selected, the rest stay selectable up to the cap. */
export const ParallelMode: Story = {
    args: { defaultTab: "all", initialModelId: undefined, initialModelIds: [MODELS.claudeSonnet.id, MODELS.gpt.id] },
};

export const ImageModels: Story = { args: { defaultModeFilter: "image", defaultTab: "all", initialModelId: MODELS.fluxSchnell.id } };

/**
 * A model behind a PostHog flag. The picker's own catalog (no `models` prop) drops flagged
 * models unless the flag is on: here it is, through `parameters.featureFlags`.
 */
export const FeatureFlaggedModel: Story = {
    args: { defaultTab: "all", favorites: [], initialModelId: MODELS.preview.id, models: undefined },
    parameters: { featureFlags: ["model-preview"] },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(MODELS.preview.name ?? "")).toBeVisible();
    },
};

/** The gateway is down: `/v1/models` answers 503, so the picker's own catalog stays empty. */
export const GatewayUnavailable: Story = {
    args: { defaultTab: "all", favorites: [], initialModelId: undefined, models: undefined },
    parameters: { msw: { handlers: { gateway: gatewayModelsHandler("error") } } },
};

/** The gateway answered with no models. */
export const Empty: Story = {
    args: { defaultTab: "all", favorites: [], initialModelId: undefined, models: [] },
};

/** No starred models yet: the Starred tab explains how to add some. */
export const NoFavorites: Story = { args: { favorites: [] } };

export const Search: Story = {
    args: { defaultTab: "all" },
    play: async ({ canvas }) => {
        await userEvent.type(canvas.getByPlaceholderText("Search models..."), "gemini");
        await expect(await canvas.findByText(MODELS.gemini.name ?? "")).toBeVisible();
        await expect(canvas.queryByText(MODELS.gpt.name ?? "")).toBeNull();
    },
};
