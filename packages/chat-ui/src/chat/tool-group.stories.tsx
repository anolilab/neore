import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import ToolGroup from "./tool-group";
import type { ToolGroupSegment } from "./turn-summary";

const group = (names: ToolGroupSegment["names"]): ToolGroupSegment => {
    return { end: names.length, kind: "group", names, start: 0, toolCount: names.reduce((sum, entry) => sum + entry.count, 0) };
};

const CALLS = (
    <ul className="space-y-1 rounded-lg border p-3 text-sm">
        <li className="font-mono">web_search</li>
        <li className="font-mono">read_page</li>
        <li className="font-mono">read_page</li>
    </ul>
);

const meta = {
    args: {
        children: CALLS,
        group: group([
            { count: 1, name: "web_search" },
            { count: 2, name: "read_page" },
        ]),
    },
    component: ToolGroup,
    decorators: [
        (Story) => (
            <div className="max-w-xl">
                <Story />
            </div>
        ),
    ],
    title: "Chat/ToolGroup",
} satisfies Meta<typeof ToolGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

/** One summary line; the per-call cards sit behind it. */
export const Collapsed: Story = {
    play: async ({ canvas }) => {
        const trigger = canvas.getByTestId("tool-group-trigger");

        await expect(trigger).toHaveTextContent("Used 3 tools · web_search, read_page ×2");
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
    },
};

export const Expanded: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByTestId("tool-group-trigger"));
        await expect(await canvas.findAllByText("read_page")).toHaveLength(2);
    },
};

/** Past two names the rest are counted. */
export const ManyTools: Story = {
    args: {
        group: group([
            { count: 4, name: "web_search" },
            { count: 2, name: "read_page" },
            { count: 1, name: "run_code" },
            { count: 1, name: "write_file" },
        ]),
    },
    play: async ({ canvas }) => {
        await expect(canvas.getByTestId("tool-group-trigger")).toHaveTextContent("Used 8 tools · web_search ×4, read_page ×2, +2 more");
    },
};

export const SingleName: Story = {
    args: { group: group([{ count: 5, name: "web_search" }]) },
};
