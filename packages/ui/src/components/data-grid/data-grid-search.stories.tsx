import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import DataGridSearch from "./data-grid-search";

const MATCHES = [
    { columnId: "title", rowIndex: 0 },
    { columnId: "notes", rowIndex: 2 },
    { columnId: "title", rowIndex: 4 },
];

const meta = {
    args: {
        matchIndex: 0,
        onNavigateToNextMatch: fn(),
        onNavigateToPrevMatch: fn(),
        onSearch: fn(),
        onSearchOpenChange: fn(),
        onSearchQueryChange: fn(),
        searchMatches: MATCHES,
        searchOpen: true,
        searchQuery: "release",
    },
    component: DataGridSearch,
    decorators: [
        (Story) => (
            <div className="relative h-32 w-full">
                <Story />
            </div>
        ),
    ],
    title: "UI/Data grid/Data grid search",
} satisfies Meta<typeof DataGridSearch>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Next match" }));
        await expect(args.onNavigateToNextMatch).toHaveBeenCalled();
    },
};

export const NoMatches: Story = {
    args: { matchIndex: -1, searchMatches: [], searchQuery: "zzz" },
};

export const EmptyQuery: Story = {
    args: { matchIndex: -1, searchMatches: [], searchQuery: "" },
};

export const Closed: Story = {
    args: { searchOpen: false },
    play: async ({ canvas }) => {
        await expect(canvas.queryByRole("search")).toBeNull();
    },
};
