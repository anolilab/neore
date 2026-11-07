import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import {
    InlineCitation,
    InlineCitationCard,
    InlineCitationCardBody,
    InlineCitationCardTrigger,
    InlineCitationCarousel,
    InlineCitationCarouselContent,
    InlineCitationCarouselHeader,
    InlineCitationCarouselIndex,
    InlineCitationCarouselItem,
    InlineCitationCarouselNext,
    InlineCitationCarouselPrev,
    InlineCitationQuote,
    InlineCitationSource,
    InlineCitationText,
} from "./inline-citation";

const OVERVIEW = {
    description: "A short overview of how the feature behaves in production.",
    title: "Feature overview",
    url: "https://docs.example.com/overview",
};
const SOURCES = [OVERVIEW, { description: "Release notes for the latest minor version.", title: "Release notes", url: "https://blog.example.org/release" }];

const meta = {
    component: InlineCitation,
    decorators: [
        (Story) => (
            <div className="w-[28rem] pt-4 text-sm">
                <Story />
            </div>
        ),
    ],
    title: "Chat/InlineCitation",
} satisfies Meta<typeof InlineCitation>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("docs.example.com")).toBeVisible();
    },
    render: () => (
        <p>
            The feature ships to everyone this month{" "}
            <InlineCitation>
                <InlineCitationText>according to the release notes</InlineCitationText>
                <InlineCitationCard>
                    <InlineCitationCardTrigger sources={[OVERVIEW.url]} />
                    <InlineCitationCardBody>
                        <div className="p-4">
                            <InlineCitationSource {...OVERVIEW} />
                        </div>
                    </InlineCitationCardBody>
                </InlineCitationCard>
            </InlineCitation>
            .
        </p>
    ),
};

export const MultipleSourcesOpen: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("docs.example.com +1")).toBeVisible();
    },
    render: () => (
        <p>
            The feature ships to everyone this month{" "}
            <InlineCitation>
                <InlineCitationText>according to two sources</InlineCitationText>
                <InlineCitationCard defaultOpen>
                    <InlineCitationCardTrigger sources={SOURCES.map((source) => source.url)} />
                    <InlineCitationCardBody>
                        <InlineCitationCarousel>
                            <InlineCitationCarouselHeader>
                                <InlineCitationCarouselPrev />
                                <InlineCitationCarouselNext />
                                <InlineCitationCarouselIndex />
                            </InlineCitationCarouselHeader>
                            <InlineCitationCarouselContent>
                                {SOURCES.map((source) => (
                                    <InlineCitationCarouselItem key={source.url}>
                                        <InlineCitationSource {...source} />
                                        <InlineCitationQuote>The rollout completes within the month.</InlineCitationQuote>
                                    </InlineCitationCarouselItem>
                                ))}
                            </InlineCitationCarouselContent>
                        </InlineCitationCarousel>
                    </InlineCitationCardBody>
                </InlineCitationCard>
            </InlineCitation>
            .
        </p>
    ),
};

export const NoSources: Story = {
    render: () => (
        <p>
            An unverified claim
            <InlineCitation>
                <InlineCitationCard>
                    <InlineCitationCardTrigger sources={[]} />
                    <InlineCitationCardBody />
                </InlineCitationCard>
            </InlineCitation>
            .
        </p>
    ),
};
