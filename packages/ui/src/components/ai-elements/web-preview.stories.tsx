import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowLeftIcon, ArrowRightIcon, RefreshCwIcon } from "lucide-react";
import { expect, fn, userEvent, waitFor } from "storybook/test";

import { WebPreview, WebPreviewBody, WebPreviewConsole, WebPreviewNavigation, WebPreviewNavigationButton, WebPreviewUrl } from "./web-preview";

// The preview only loads http(s) pages, so the sample is a static file that Storybook serves beside itself
// (`apps/web/.storybook/public`), addressed by its absolute URL.
const PAGE = new URL("preview-sample.html", globalThis.location.href).href;

const LOGS = [
    { level: "log" as const, message: "Server started", timestamp: new Date(Date.UTC(2026, 10, 5, 12, 0, 0)) },
    { level: "warn" as const, message: "Slow request", timestamp: new Date(Date.UTC(2026, 10, 5, 12, 0, 5)) },
    { level: "error" as const, message: "Failed to load /missing.js", timestamp: new Date(Date.UTC(2026, 10, 5, 12, 0, 9)) },
];

const meta = {
    component: WebPreview,
    decorators: [
        (Story) => (
            <div className="h-96 w-[34rem]">
                <Story />
            </div>
        ),
    ],
    title: "Chat/WebPreview",
} satisfies Meta<typeof WebPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

const Navigation = () => (
    <WebPreviewNavigation>
        <WebPreviewNavigationButton aria-label="Back" tooltip="Back">
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton aria-label="Forward" tooltip="Forward">
            <ArrowRightIcon aria-hidden="true" className="size-4" />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton aria-label="Reload" tooltip="Reload">
            <RefreshCwIcon aria-hidden="true" className="size-4" />
        </WebPreviewNavigationButton>
        <WebPreviewUrl aria-label="Address" />
    </WebPreviewNavigation>
);

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("textbox", { name: "Address" })).toHaveValue("https://example.com");
    },
    render: () => (
        <WebPreview defaultUrl="https://example.com">
            <Navigation />
            <WebPreviewBody src={PAGE} />
        </WebPreview>
    ),
};

export const UrlChange: Story = {
    play: async ({ canvas }) => {
        const input = canvas.getByRole("textbox", { name: "Address" });

        await userEvent.clear(input);
        await userEvent.type(input, "https://example.org{Enter}");
        await expect(input).toHaveValue("https://example.org");
    },
    render: () => (
        <WebPreview defaultUrl="https://example.com" onUrlChange={fn()}>
            <Navigation />
            <WebPreviewBody src={PAGE} />
        </WebPreview>
    ),
};

export const WithConsole: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Console" }));
        await waitFor(() => expect(canvas.getByText("Slow request")).toBeVisible());
    },
    render: () => (
        <WebPreview defaultUrl="https://example.com">
            <Navigation />
            <WebPreviewBody src={PAGE} />
            <WebPreviewConsole logs={LOGS} />
        </WebPreview>
    ),
};

export const EmptyConsole: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Console" }));
        await waitFor(() => expect(canvas.getByText("No console output")).toBeVisible());
    },
    render: () => (
        <WebPreview defaultUrl="https://example.com">
            <Navigation />
            <WebPreviewBody src={PAGE} />
            <WebPreviewConsole />
        </WebPreview>
    ),
};

export const Loading: Story = {
    render: () => (
        <WebPreview defaultUrl="https://example.com">
            <Navigation />
            <WebPreviewBody loading={<p className="text-muted-foreground p-4 text-sm">Loading preview...</p>} src={PAGE} />
        </WebPreview>
    ),
};
