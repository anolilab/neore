import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { ButtonGroup } from "./button-group";
import { DirectionProvider } from "./direction";

const meta: Meta<typeof DirectionProvider> = {
    argTypes: { direction: { control: "inline-radio", options: ["ltr", "rtl"] } },
    component: DirectionProvider,
    render: (args) => (
        <DirectionProvider {...args}>
            <div dir={args.direction}>
                <ButtonGroup aria-label="Navigation">
                    <Button variant="outline">First</Button>
                    <Button variant="outline">Second</Button>
                    <Button variant="outline">Third</Button>
                </ButtonGroup>
            </div>
        </DirectionProvider>
    ),
    title: "UI/DirectionProvider",
};

export default meta;

type Story = StoryObj<typeof DirectionProvider>;

export const LeftToRight: Story = { args: { children: null, direction: "ltr" } };

export const RightToLeft: Story = { args: { children: null, direction: "rtl" } };
