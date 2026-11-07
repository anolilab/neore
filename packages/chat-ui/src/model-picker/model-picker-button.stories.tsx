import type { GatewayModel } from "@neore/ai/models";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { ModelPickerButton } from "./model-picker-button";

const model = (fixture: Partial<GatewayModel> & Pick<GatewayModel, "id" | "mode" | "name" | "provider">): GatewayModel => {
    return { enabled: true, modelApiId: fixture.id, regions: ["US"], supportsFileInput: false, supportsMultimodal: false, supportsTools: true, ...fixture };
};

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
const CATALOG = [KIMI, CLAUDE, GPT, GEMINI];

const meta = {
    args: {
        favorites: [CLAUDE.id],
        modelId: CLAUDE.id,
        models: CATALOG,
        onSelect: fn(),
        onSelectMultiple: fn(),
        onToggleFavorite: fn(),
    },
    component: ModelPickerButton,
    decorators: [
        (Story) => (
            <div className="h-[34rem] w-[40rem]">
                <Story />
            </div>
        ),
    ],
    title: "Chat/ModelPickerButton",
} satisfies Meta<typeof ModelPickerButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Claude Sonnet 4.5" })).toHaveAttribute("aria-expanded", "false");
    },
};

/** The popover lists the catalog. */
export const Open: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Claude Sonnet 4.5" }));

        const popover = within(document.body);

        await waitFor(() => expect(popover.getAllByText(CLAUDE.name ?? "").length).toBeGreaterThan(1));
        await expect(args.onSelect).not.toHaveBeenCalled();
    },
};

export const Placeholder: Story = {
    args: { modelId: undefined, placeholder: "Choose a model" },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Choose a model" })).toBeVisible();
    },
};

export const NothingSelected: Story = {
    args: { modelId: undefined },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Select model..." })).toBeVisible();
    },
};

/** Two or more selected models show a stack of provider icons and a count. */
export const Comparing: Story = {
    args: { modelId: undefined, selectedModelIds: [CLAUDE.id, GPT.id, GEMINI.id] },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("3 models")).toBeVisible();
    },
};

export const Disabled: Story = {
    args: { disabled: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Claude Sonnet 4.5" })).toBeDisabled();
    },
};

export const Compact: Story = { args: { className: "h-7 max-w-40 text-xs", size: "sm" } };

/** On a phone the picker opens in a drawer. */
export const MobileDrawer: Story = {
    args: { isMobile: true },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Claude Sonnet 4.5" }));
        await expect(await within(document.body).findByText("Select Model")).toBeVisible();
    },
};
