import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Route as ShortcutRoute } from "@/routes/_shortcut";
import { Route as PagesRoute } from "@/routes/_shortcut/pages";
import { Route as PageRoute } from "@/routes/_shortcut/pages/$pageId";
import { Route as PagesIndexRoute } from "@/routes/_shortcut/pages/index";
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
        await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT);
        await userEvent.click(await pressable(canvas, "Comments"));
        await expect(await canvas.findByText("Can we test this headline against the old one before we commit to it?", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const CommentsPanelEmpty: Story = {
    args: OPEN,
    parameters: { msw: { handlers: handlers(...documentFixtures({ threads: [] })) } },
    play: async ({ canvas }) => {
        await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT);
        await userEvent.click(await pressable(canvas, "Comments"));
        await expect(await canvas.findByText("Select text in the page and choose “Comment”.", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const VersionHistoryPanel: Story = {
    args: OPEN,
    play: async ({ canvas }) => {
        await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT);
        await userEvent.click(await pressable(canvas, "Version history"));
        await expect(await canvas.findByText("AI edit", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const VersionHistoryEmpty: Story = {
    args: OPEN,
    parameters: { msw: { handlers: handlers(...documentFixtures({ versions: [] })) } },
    play: async ({ canvas }) => {
        await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT);
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

/**
 * The Pages tree beside the page needs room: below `lg` (1024 px) it is a drawer behind a button in the page's header, and on the
 * Pages list, where it is the content, it fills the screen. The viewport is set on the story, so it holds in every Vitest project.
 */
const PHONE = { globals: { viewport: { isRotated: false, value: "mobile" } } } as const;
const NARROW = {
    globals: { viewport: { isRotated: false, value: "narrow" } },
    parameters: { viewport: { options: { narrow: { name: "Narrow (900 px)", styles: { height: "1000px", width: "900px" }, type: "tablet" } } } },
} as const;

const treeDialog = () => within(document.body).findByRole("dialog", { name: "Pages" }, PAGE_WAIT);

const openTree = async (canvas: Parameters<NonNullable<Story["play"]>>[0]["canvas"]) => {
    await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT);
    await userEvent.click(await pressable(canvas, "Pages"));

    return treeDialog();
};

export const DesktopTreeBeside: Story = {
    args: OPEN,
    globals: { viewport: { isRotated: false, value: "desktop" } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT)).toHaveValue("Pricing page copy");
        await expect(await canvas.findByRole("navigation", { name: "Your pages" }, PAGE_WAIT)).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Pages" })).toBeNull();
    },
};

export const PhoneTreeClosed: Story = {
    ...PHONE,
    args: OPEN,
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT)).toBeVisible();
        await expect(await canvas.findByRole("button", { name: "Pages" })).toHaveAttribute("aria-expanded", "false");
        await expect(canvas.queryByRole("navigation", { name: "Your pages" })).toBeNull();
        await expect(within(document.body).queryByRole("dialog", { name: "Pages" })).toBeNull();
    },
};

export const PhoneTreeOpen: Story = {
    ...PHONE,
    args: OPEN,
    play: async ({ canvas }) => {
        const dialog = await openTree(canvas);

        const tree = await within(dialog).findByRole("navigation", { name: "Your pages" }, PAGE_WAIT);

        // The sheet fades in: wait for the end of it rather than judging its first frame.
        await waitFor(() => expect(tree).toBeVisible(), PAGE_WAIT);
        await expect(within(dialog).getByRole("searchbox", { name: "Search pages" })).toBeVisible();
    },
};

export const PhoneTreePickClosesAndRestoresFocus: Story = {
    ...PHONE,
    args: OPEN,
    play: async ({ canvas }) => {
        const dialog = await openTree(canvas);

        await userEvent.click(await within(dialog).findByRole("link", { name: "Support macros" }, PAGE_WAIT));
        await waitFor(() => expect(within(document.body).queryByRole("dialog", { name: "Pages" })).toBeNull(), PAGE_WAIT);
        // The page's header remounts for the page just picked; focus lands on its toggle once it is there.
        await waitFor(() => expect(canvas.getByRole("button", { name: "Pages" })).toHaveFocus(), PAGE_WAIT);
    },
};

export const PhoneTreePickOpenPageCloses: Story = {
    ...PHONE,
    args: OPEN,
    play: async ({ canvas }) => {
        const dialog = await openTree(canvas);

        // The page is already open, so the page id does not change: the drawer closes on the click itself.
        await userEvent.click(await within(dialog).findByRole("link", { current: "page", name: "Pricing page copy" }, PAGE_WAIT));
        await waitFor(() => expect(within(document.body).queryByRole("dialog", { name: "Pages" })).toBeNull(), PAGE_WAIT);
        await waitFor(() => expect(canvas.getByRole("button", { name: "Pages" })).toHaveFocus(), PAGE_WAIT);
    },
};

export const PhoneNotFound: Story = {
    ...PHONE,
    args: OPEN,
    parameters: { msw: { handlers: handlers(...documentFixtures(), lunoraError(api.pages.functions.getPage, "NOT_FOUND", "Page not found", 404)) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Page not found", undefined, PAGE_WAIT)).toBeVisible();
        // The tree is a drawer here, and this is the way to it from a page that is not there.
        await expect(await canvas.findByRole("button", { name: "Pages" })).toBeVisible();
    },
};

export const PhoneTreeEscapeRestoresFocus: Story = {
    ...PHONE,
    args: OPEN,
    play: async ({ canvas }) => {
        await openTree(canvas);
        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(within(document.body).queryByRole("dialog", { name: "Pages" })).toBeNull(), PAGE_WAIT);
        await waitFor(() => expect(canvas.getByRole("button", { name: "Pages" })).toHaveFocus(), PAGE_WAIT);
    },
};

export const PhonePagesList: Story = {
    ...PHONE,
    args: { levels: [...LEVELS.slice(0, 2), { path: "/", route: PagesIndexRoute }], url: "/pages" },
    play: async ({ canvas }) => {
        // On the list the tree is the content: no drawer, no toggle.
        await expect(await canvas.findByRole("navigation", { name: "Your pages" }, PAGE_WAIT)).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Pages" })).toBeNull();
    },
};

export const NarrowTreeClosed: Story = {
    ...NARROW,
    args: OPEN,
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("textbox", { name: "Page title" }, PAGE_WAIT)).toBeVisible();
        await expect(await canvas.findByRole("button", { name: "Pages" })).toBeVisible();
        await expect(canvas.queryByRole("navigation", { name: "Your pages" })).toBeNull();
    },
};

export const NarrowTreeOpen: Story = {
    ...NARROW,
    args: OPEN,
    play: async ({ canvas }) => {
        const dialog = await openTree(canvas);
        const tree = await within(dialog).findByRole("navigation", { name: "Your pages" }, PAGE_WAIT);

        await waitFor(() => expect(tree).toBeVisible(), PAGE_WAIT);
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
