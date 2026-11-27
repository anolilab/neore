import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Route as ShortcutRoute } from "@/routes/_shortcut";
import { Route as PagesRoute } from "@/routes/_shortcut/pages";
import { Route as PageRoute } from "@/routes/_shortcut/pages/$pageId";
import { chatFixtures } from "@/storybook/fixtures/chat";
import { COLLABORATORS, DOCUMENT_ID, documentFixtures, EMPTY_DOCUMENT, READ_ONLY_DOCUMENT } from "@/storybook/fixtures/documents";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { pagesFixtures } from "@/storybook/fixtures/workspace";
import { lunoraError, lunoraHandlers, lunoraPending } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";
import { pressable } from "@/storybook/play";

// The route chunk, then the lazy editor, then the data: with four browser projects running at once that can outlast a few seconds.
const PAGE_WAIT = { timeout: 15_000 } as const;

const handlers = (...fixtures: ReturnType<typeof userFixtures>) => {
    return {
        gateway: gatewayModelsHandler(),
        lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...pagesFixtures(), ...fixtures),
    };
};

/**
 * One document open from the Pages list: the pages tree beside it, the title bar with its actions, the editor, and the
 * comment, history and share panels. The rich-text editor itself is the real one.
 */
const meta = {
    args: { levels: [], url: `/pages/${DOCUMENT_ID}` },
    component: StoryPage,
    parameters: { layout: "fullscreen", msw: { handlers: handlers(...documentFixtures()) } },
    title: "Pages/Documents",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

const LEVELS = [
    { id: "/_shortcut", route: ShortcutRoute },
    { path: "pages", route: PagesRoute },
    { path: "$pageId", route: PageRoute },
] as const;

const OPEN = { levels: LEVELS, url: `/pages/${DOCUMENT_ID}` } as const;

export const Document: Story = {
    args: OPEN,
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT)).toHaveValue("Pricing page copy");
    },
};

export const EmptyDocument: Story = {
    args: { levels: LEVELS, url: `/pages/${DOCUMENT_ID}` },
    parameters: { msw: { handlers: handlers(...documentFixtures({ page: EMPTY_DOCUMENT, threads: [], versions: [] })) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT)).toHaveValue("");
    },
};

export const CommentsPanel: Story = {
    args: OPEN,
    play: async ({ canvas }) => {
        await userEvent.click(await pressable(canvas, "Comments"));
        await expect(await canvas.findByText("Can we test this headline against the old one before we commit to it?", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const CommentsPanelEmpty: Story = {
    args: OPEN,
    parameters: { msw: { handlers: handlers(...documentFixtures({ threads: [] })) } },
    play: async ({ canvas }) => {
        await userEvent.click(await pressable(canvas, "Comments"));
        await expect(await canvas.findByText("Select text in the page and choose “Comment”.", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const VersionHistoryPanel: Story = {
    args: OPEN,
    play: async ({ canvas }) => {
        await userEvent.click(await pressable(canvas, "Version history"));
        await expect(await canvas.findByText("AI edit", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const VersionHistoryEmpty: Story = {
    args: OPEN,
    parameters: { msw: { handlers: handlers(...documentFixtures({ versions: [] })) } },
    play: async ({ canvas }) => {
        await userEvent.click(await pressable(canvas, "Version history"));
        await expect(await canvas.findByText("No versions yet. Versions are saved as you edit.", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const ShareDialog: Story = {
    args: OPEN,
    play: async ({ canvas }) => {
        await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT);
        await userEvent.click(await pressable(canvas, "Share"));

        const heading = await within(document.body).findByText("People with access", undefined, PAGE_WAIT);

        // The dialog fades in: wait for the end of it rather than judging its first frame.
        await waitFor(() => expect(heading).toBeVisible(), PAGE_WAIT);
    },
};

export const PageAgentDialog: Story = {
    args: OPEN,
    play: async ({ canvas }) => {
        // The button shows once the page's access has loaded, after the title.
        await canvas.findByRole("button", { name: "Page agent" }, PAGE_WAIT);
        await userEvent.click(await pressable(canvas, "Page agent"));
        const field = await within(document.body).findByLabelText("What should change?", undefined, PAGE_WAIT);

        await waitFor(() => expect(field).toBeVisible(), PAGE_WAIT);
    },
};

export const CollaboratorEditing: Story = {
    args: OPEN,
    parameters: { msw: { handlers: handlers(...documentFixtures({ presence: COLLABORATORS })) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/Jonas Weber is editing this page/u, undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const CommentOnly: Story = {
    args: OPEN,
    parameters: { msw: { handlers: handlers(...documentFixtures({ page: READ_ONLY_DOCUMENT })) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("You can comment on this page but not edit it.", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Loading: Story = {
    args: OPEN,
    parameters: { msw: { handlers: handlers(...documentFixtures(), lunoraPending(api.pages.functions.getPage)) } },
};

export const NotFound: Story = {
    args: OPEN,
    parameters: { msw: { handlers: handlers(...documentFixtures(), lunoraError(api.pages.functions.getPage, "NOT_FOUND", "Page not found", 404)) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Page not found", undefined, PAGE_WAIT)).toBeVisible();
    },
};
