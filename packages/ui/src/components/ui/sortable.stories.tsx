import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn } from "storybook/test";

import * as Sortable from "./sortable";

const initial = ["Research", "Draft", "Review", "Publish"];

type ExampleProps = {
    disabled?: boolean;
    onValueChange: (items: string[]) => void;
    orientation?: "vertical" | "horizontal";
};

const Example = ({ disabled, onValueChange, orientation = "vertical" }: ExampleProps) => {
    const [items, setItems] = useState(initial);

    return (
        <Sortable.Root
            onValueChange={(next) => {
                setItems(next);
                onValueChange(next);
            }}
            orientation={orientation}
            value={items}
        >
            <Sortable.Content className={orientation === "vertical" ? "flex w-56 flex-col gap-2" : "flex gap-2"}>
                {items.map((item) => (
                    <Sortable.Item className="bg-card flex items-center gap-2 rounded-md border p-2 text-sm" disabled={disabled} key={item} value={item}>
                        <Sortable.ItemHandle aria-label={`Move ${item}`} className="px-1">
                            ::
                        </Sortable.ItemHandle>
                        {item}
                    </Sortable.Item>
                ))}
            </Sortable.Content>
            <Sortable.Overlay>{({ value }) => <div className="bg-card rounded-md border p-2 text-sm shadow-md">{String(value)}</div>}</Sortable.Overlay>
        </Sortable.Root>
    );
};

const meta = {
    args: { onValueChange: fn() },
    component: Example,
    title: "UI/Sortable",
} satisfies Meta<typeof Example>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Vertical: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getAllByRole("button", { name: /^Move / })).toHaveLength(4);
    },
};

export const Horizontal: Story = { args: { orientation: "horizontal" } };
