import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Autocomplete, AutocompleteEmpty, AutocompleteInput, AutocompleteItem, AutocompleteList, AutocompletePopup } from "./autocomplete";

const fruits = ["Apple", "Banana", "Cherry", "Grape", "Mango"];

const meta = {
    args: { items: fruits },
    component: Autocomplete,
    render: (args) => (
        <div className="w-64">
            <Autocomplete {...args}>
                <AutocompleteInput aria-label="Fruit" placeholder="Search fruit" />
                <AutocompletePopup>
                    <AutocompleteEmpty>No fruit found.</AutocompleteEmpty>
                    <AutocompleteList>
                        {(item: string) => (
                            <AutocompleteItem key={item} value={item}>
                                {item}
                            </AutocompleteItem>
                        )}
                    </AutocompleteList>
                </AutocompletePopup>
            </Autocomplete>
        </div>
    ),
    title: "UI/Autocomplete",
} satisfies Meta<typeof Autocomplete>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("combobox", { name: "Fruit" })).toBeVisible();
    },
};

export const Open: Story = {
    args: { defaultOpen: true },
    play: async ({ canvasElement }) => {
        await expect(await within(canvasElement.ownerDocument.body).findByRole("option", { name: "Mango" })).toBeVisible();
    },
};

export const WithValue: Story = {
    args: { defaultValue: "Cherry" },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("combobox", { name: "Fruit" })).toHaveValue("Cherry");
    },
};

export const Typing: Story = {
    play: async ({ canvas, canvasElement }) => {
        await userEvent.type(canvas.getByRole("combobox", { name: "Fruit" }), "an");
        const option = await within(canvasElement.ownerDocument.body).findByRole("option", { name: "Banana" });

        await waitFor(() => expect(option).toBeVisible());
    },
};

export const NoResults: Story = {
    args: { defaultOpen: true, defaultValue: "zzz" },
    play: async ({ canvasElement }) => {
        await expect(await within(canvasElement.ownerDocument.body).findByText("No fruit found.")).toBeVisible();
    },
};

export const Disabled: Story = { args: { disabled: true } };
