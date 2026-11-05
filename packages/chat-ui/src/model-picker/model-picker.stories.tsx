import type { GatewayModel } from "@neore/ai/models";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";

import { ModelPicker } from "./model-picker";

const model = (fixture: Partial<GatewayModel> & Pick<GatewayModel, "id" | "mode" | "name" | "provider">): GatewayModel => {
    return { enabled: true, modelApiId: fixture.id, regions: ["US"], supportsFileInput: false, supportsMultimodal: false, supportsTools: true, ...fixture };
};

/** The extension's picker takes its catalog as a prop, so a small inline one is enough. */
const KIMI = model({ displayProvider: "Moonshot", id: "cf-kimi-k2.5", mode: "text", name: "Kimi K2.5 (Workers AI)", provider: "cloudflare" });
const CLAUDE = model({
    displayProvider: "Anthropic",
    id: "anthropic/claude-sonnet-4.5",
    isPremium: true,
    mode: "text",
    name: "Claude Sonnet 4.5",
    provider: "openrouter",
});
const GPT = model({ displayProvider: "OpenAI", id: "openai/gpt-5", isPremium: true, mode: "text", name: "GPT-5", provider: "openrouter" });
const GEMINI = model({ displayProvider: "Google", id: "google/gemini-2.5-flash", mode: "text", name: "Gemini 2.5 Flash", provider: "openrouter" });
const FLUX = model({ displayProvider: "Black Forest Labs", id: "cf-flux-1-schnell", mode: "image", name: "FLUX.1 schnell", provider: "cloudflare" });
const CATALOG = [KIMI, CLAUDE, GPT, GEMINI, FLUX];

const meta = {
    args: {
        defaultModeFilter: "text",
        defaultTab: "all",
        favorites: [CLAUDE.id],
        initialModelId: CLAUDE.id,
        models: CATALOG,
        onSelect: fn(),
        onSelectMultiple: fn(),
        onToggleFavorite: fn(),
        panelClassName: "h-[28rem]",
    },
    component: ModelPicker,
    decorators: [
        (Story) => (
            <div className="bg-popover w-[36rem] rounded-xl border shadow-lg">
                <Story />
            </div>
        ),
    ],
    // The same secondary-text contrast as the web picker (`text-muted-foreground/50`–`/60`); see its stories.
    parameters: { a11y: { test: "todo" } },
    title: "Extension/Model picker",
} satisfies Meta<typeof ModelPicker>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The default model selected opens on its creator (the #539 regression, in the extension's copy). */
export const DefaultModelSelected: Story = {
    args: { favorites: [], initialModelId: KIMI.id },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(KIMI.name ?? "")).toBeVisible();
        await expect(canvas.queryByText(/no models found/i)).toBeNull();
    },
};

export const Starred: Story = { args: { defaultTab: "starred" } };

export const Guest: Story = { args: { favorites: [], initialModelId: KIMI.id, isAnonymous: true } };

export const ParallelMode: Story = { args: { initialModelId: undefined, initialModelIds: [CLAUDE.id, GPT.id] } };

export const Empty: Story = { args: { favorites: [], initialModelId: undefined, models: [] } };
