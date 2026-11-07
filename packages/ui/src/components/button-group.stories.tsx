import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { Button } from "./button";
import { ButtonGroup, ButtonGroupSeparator, ButtonGroupText } from "./button-group";

const meta = {
    argTypes: { orientation: { control: "inline-radio", options: ["horizontal", "vertical"] } },
    component: ButtonGroup,
    title: "UI/ButtonGroup",
} satisfies Meta<typeof ButtonGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    args: { "aria-label": "Text alignment" },
    render: (args) => (
        <ButtonGroup {...args}>
            <Button onClick={fn()} variant="outline">
                Left
            </Button>
            <Button onClick={fn()} variant="outline">
                Center
            </Button>
            <Button onClick={fn()} variant="outline">
                Right
            </Button>
        </ButtonGroup>
    ),
};

export const Vertical: Story = {
    args: { "aria-label": "Zoom", orientation: "vertical" },
    render: (args) => (
        <ButtonGroup {...args}>
            <Button variant="outline">Zoom in</Button>
            <Button variant="outline">Zoom out</Button>
        </ButtonGroup>
    ),
};

export const WithText: Story = {
    args: { "aria-label": "Page size" },
    render: (args) => (
        <ButtonGroup {...args}>
            <ButtonGroupText>Rows</ButtonGroupText>
            <Button variant="outline">10</Button>
            <Button variant="outline">25</Button>
        </ButtonGroup>
    ),
};

export const WithSeparator: Story = {
    args: { "aria-label": "Save options" },
    render: (args) => (
        <ButtonGroup {...args}>
            <Button variant="secondary">Save</Button>
            <ButtonGroupSeparator />
            <Button variant="secondary">Save as</Button>
        </ButtonGroup>
    ),
};
