import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor } from "storybook/test";

import { CitationMarker, Source, Sources, SourcesContent, SourcesTrigger } from "./sources";

const GUIDE = { href: "https://docs.example.com/guide", title: "Getting started guide" };
const POST = { href: "https://blog.example.org/post", title: "Announcing the new release" };
const NEWS = { href: "https://news.example.net/story", title: "Industry news" };
const SOURCES = [GUIDE, POST, NEWS];

const meta = {
    component: Sources,
    title: "Chat/Sources",
} satisfies Meta<typeof Sources>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Used 3 sources, toggle to show" }));
        await waitFor(() => expect(canvas.getAllByRole("link")).toHaveLength(3));
    },
    render: () => (
        <Sources>
            <SourcesTrigger count={SOURCES.length} />
            <SourcesContent>
                {SOURCES.map((source, index) => (
                    <Source href={source.href} index={index + 1} key={source.href} title={source.title} />
                ))}
            </SourcesContent>
        </Sources>
    ),
};

export const Open: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getAllByRole("link")).toHaveLength(3);
    },
    render: () => (
        <Sources defaultOpen>
            <SourcesTrigger count={SOURCES.length} sourceUrls={SOURCES.map((source) => source.href)} />
            <SourcesContent>
                {SOURCES.map((source, index) => (
                    <Source href={source.href} index={index + 1} key={source.href} title={source.title} />
                ))}
            </SourcesContent>
        </Sources>
    ),
};

export const SingleSource: Story = {
    render: () => (
        <Sources defaultOpen>
            <SourcesTrigger count={1} />
            <SourcesContent>
                <Source href={GUIDE.href} title={GUIDE.title} />
            </SourcesContent>
        </Sources>
    ),
};

export const Highlighted: Story = {
    render: () => (
        <Sources defaultOpen>
            <SourcesTrigger count={2} />
            <SourcesContent>
                <Source highlighted href={GUIDE.href} index={1} title={GUIDE.title} />
                <Source href={POST.href} index={2} title={POST.title} />
            </SourcesContent>
        </Sources>
    ),
};

export const InlineMarker: Story = {
    render: () => (
        <p className="text-sm">
            The release is out
            <CitationMarker aria-label="Source 1" href={POST.href} index={1} />.
        </p>
    ),
};
