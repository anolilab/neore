import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileSearchIcon, LightbulbIcon, SearchIcon } from "lucide-react";
import { expect, userEvent, waitFor } from "storybook/test";

import {
    ChainOfThought,
    ChainOfThoughtContent,
    ChainOfThoughtHeader,
    ChainOfThoughtImage,
    ChainOfThoughtSearchResult,
    ChainOfThoughtSearchResults,
    ChainOfThoughtStep,
} from "./chain-of-thought";

const meta = {
    component: ChainOfThought,
    title: "Chat/ChainOfThought",
} satisfies Meta<typeof ChainOfThought>;

export default meta;

type Story = StoryObj<typeof meta>;

const Steps = () => (
    <div role="list">
        <ChainOfThoughtStep description="Looking for recent benchmarks." icon={SearchIcon} label="Searching the web" status="complete">
            <ChainOfThoughtSearchResults>
                <ChainOfThoughtSearchResult>example.com</ChainOfThoughtSearchResult>
                <ChainOfThoughtSearchResult>docs.example.org</ChainOfThoughtSearchResult>
            </ChainOfThoughtSearchResults>
        </ChainOfThoughtStep>
        <ChainOfThoughtStep icon={FileSearchIcon} label="Reading the results" status="active" />
        <ChainOfThoughtStep icon={LightbulbIcon} label="Drafting an answer" status="pending" />
    </div>
);

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Collapse chain of thought" })).toBeVisible();
        await expect(canvas.getAllByRole("listitem")).toHaveLength(3);
    },
    render: () => (
        <ChainOfThought defaultOpen>
            <ChainOfThoughtHeader />
            <ChainOfThoughtContent>
                <Steps />
            </ChainOfThoughtContent>
        </ChainOfThought>
    ),
};

export const Collapsed: Story = {
    play: async ({ canvas }) => {
        const trigger = canvas.getByRole("button", { name: "Expand chain of thought" });

        await userEvent.click(trigger);
        await waitFor(() => expect(canvas.getByRole("button", { name: "Collapse chain of thought" })).toBeVisible());
    },
    render: () => (
        <ChainOfThought>
            <ChainOfThoughtHeader />
            <ChainOfThoughtContent>
                <Steps />
            </ChainOfThoughtContent>
        </ChainOfThought>
    ),
};

export const WithImage: Story = {
    render: () => (
        <ChainOfThought defaultOpen>
            <ChainOfThoughtHeader>Looking at the screenshot</ChainOfThoughtHeader>
            <ChainOfThoughtContent>
                <div role="list">
                    <ChainOfThoughtStep label="Inspecting the page" status="complete">
                        <ChainOfThoughtImage caption="The settings page, cropped to the form.">
                            <div className="bg-background h-24 w-48 rounded border" />
                        </ChainOfThoughtImage>
                    </ChainOfThoughtStep>
                </div>
            </ChainOfThoughtContent>
        </ChainOfThought>
    ),
};
