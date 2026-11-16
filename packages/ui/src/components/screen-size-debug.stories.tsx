import type { Meta, StoryObj } from "@storybook/react-vite";

import ScreenSizeDebug from "./screen-size-debug";

const meta = {
    component: ScreenSizeDebug,
    parameters: { layout: "fullscreen" },
    title: "UI/Screen size debug",
} satisfies Meta<typeof ScreenSizeDebug>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Shows the active Tailwind breakpoint in the bottom-right corner (development builds only). */
export const Default: Story = {
    render: () => (
        <div className="text-muted-foreground h-48 p-4 text-sm">
            Resize the viewport to see the breakpoint label change.
            <ScreenSizeDebug />
        </div>
    ),
};
