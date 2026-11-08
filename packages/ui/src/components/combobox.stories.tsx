import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Combobox, ComboboxChip, ComboboxChips, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxValue } from "./combobox";

const frameworks = ["Astro", "Next.js", "Nuxt", "Remix", "SvelteKit"];

const meta: Meta<typeof Combobox> = {
    args: { items: frameworks },
    component: Combobox,
    render: (args) => (
        <div className="w-64">
            <Combobox {...args}>
                <ComboboxInput aria-label="Framework" placeholder="Pick a framework" showTrigger={false} />
                <ComboboxPopup>
                    <ComboboxEmpty>No framework found.</ComboboxEmpty>
                    <ComboboxList>
                        {(item: string) => (
                            <ComboboxItem key={item} value={item}>
                                {item}
                            </ComboboxItem>
                        )}
                    </ComboboxList>
                </ComboboxPopup>
            </Combobox>
        </div>
    ),
    title: "UI/Combobox",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("combobox", { name: "Framework" })).toBeVisible();
    },
};

export const Open: Story = {
    args: { defaultOpen: true },
    play: async ({ canvasElement }) => {
        await waitFor(() => {
            expect(within(canvasElement.ownerDocument.body).getByRole("option", { name: "Nuxt" })).toBeVisible();
        });
    },
};

export const WithValue: Story = {
    args: { defaultValue: "Remix" },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("combobox", { name: "Framework" })).toHaveValue("Remix");
    },
};

export const Filtering: Story = {
    play: async ({ canvas, canvasElement }) => {
        await userEvent.type(canvas.getByRole("combobox", { name: "Framework" }), "nu");

        const body = within(canvasElement.ownerDocument.body);

        const option = await body.findByRole("option", { name: "Nuxt" });

        await waitFor(() => expect(option).toBeVisible());
        await expect(body.queryByRole("option", { name: "Astro" })).toBeNull();
    },
};

export const NoResults: Story = {
    args: { defaultInputValue: "zzz", defaultOpen: true },
    play: async ({ canvasElement }) => {
        await waitFor(() => {
            expect(within(canvasElement.ownerDocument.body).getByText("No framework found.")).toBeVisible();
        });
    },
};

export const Multiple: Story = {
    args: { defaultValue: ["Astro", "Nuxt"], multiple: true },
    play: async ({ canvas }) => {
        await expect(canvas.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
    },
    render: (args) => (
        <div className="w-80">
            <Combobox {...args}>
                <ComboboxChips>
                    <ComboboxValue>
                        {(value: string[]) => (
                            <>
                                {value.map((item) => (
                                    <ComboboxChip aria-label={item} key={item}>
                                        {item}
                                    </ComboboxChip>
                                ))}
                                <ComboboxInput aria-label="Frameworks" placeholder={value.length > 0 ? undefined : "Pick frameworks"} />
                            </>
                        )}
                    </ComboboxValue>
                </ComboboxChips>
                <ComboboxPopup>
                    <ComboboxList>
                        {(item: string) => (
                            <ComboboxItem key={item} value={item}>
                                {item}
                            </ComboboxItem>
                        )}
                    </ComboboxList>
                </ComboboxPopup>
            </Combobox>
        </div>
    ),
};

export const Disabled: Story = { args: { disabled: true } };
