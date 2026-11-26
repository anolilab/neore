import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { useThreadListUIStore } from "@/features/chat/thread-list/stores/thread-list-ui-store";
import { Route as ThreadRoute } from "@/routes/(chat)/chat/$threadId";
import { Route as ChatLayoutRoute } from "@/routes/(chat)/route";
import { ago, DAY, HOUR, MINUTE } from "@/storybook/clock";
import { chatFixtures, pageOf, thread, THREAD_IDS, THREADS } from "@/storybook/fixtures/chat";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraHandlers, lunoraIdle } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// Page data arrives after the route loads; under a loaded machine that can outlast the 1 s default of `find*`.
const PAGE_WAIT = { timeout: 15_000 } as const;

/** Stable ids for the extra threads: UUIDs, so the sidebar accepts them as thread ids. */
const SIDEBAR_IDS = {
    archived: "0193c1b2-7d1e-7a3c-9f00-000000000011",
    branch: "0193c1b2-7d1e-7a3c-9f00-000000000012",
    needsYou: "0193c1b2-7d1e-7a3c-9f00-000000000013",
    snoozed: "0193c1b2-7d1e-7a3c-9f00-000000000014",
    working: "0193c1b2-7d1e-7a3c-9f00-000000000015",
} as const;

/** One thread in each section the bar can show, plus a branch under the open thread. */
const SIDEBAR_THREADS = [
    ...Object.values(THREADS),
    thread({
        _id: SIDEBAR_IDS.needsYou,
        awaitingInput: "approval",
        lastReplyAt: ago(5 * MINUTE),
        title: "Deploy the billing migration",
        updatedAt: ago(5 * MINUTE),
    }),
    thread({ _id: SIDEBAR_IDS.working, lastReplyAt: ago(MINUTE), status: "running", title: "Draft the launch email sequence", updatedAt: ago(MINUTE) }),
    thread({ _id: SIDEBAR_IDS.snoozed, snoozedUntil: ago(-2 * HOUR), title: "Follow up with the design agency" }),
    thread({ _id: SIDEBAR_IDS.archived, lastReplyAt: ago(20 * DAY), status: "archived", title: "Old onboarding survey", updatedAt: ago(20 * DAY) }),
    thread({ _id: SIDEBAR_IDS.branch, title: "Owners and due dates" }),
];

const SIDEBAR_RELATIONSHIPS = [{ parentThreadId: THREAD_IDS.main, threadId: SIDEBAR_IDS.branch }];

/** Everything the page reads, with the sidebar's richer thread list. */
const sidebarFixtures = () => [...userFixtures(), ...shellFixtures(), ...chatFixtures({ relationships: SIDEBAR_RELATIONSHIPS, threads: SIDEBAR_THREADS })];

/** The thread list's region: the dock, the section bar and the cards all live in the left sidebar. */
const sidebar = async (canvasElement: HTMLElement) => {
    const root = within(canvasElement);

    await root.findByRole("link", { name: "Plan the Q1 product launch" }, PAGE_WAIT);
    await lunoraIdle();

    return root;
};

/** The section bar and its buttons, once the list has published its counts. */
const sectionButton = async (canvasElement: HTMLElement, name: RegExp) => {
    const root = await sidebar(canvasElement);
    const bar = await root.findByRole("group", { name: "Thread sections (shift-click to show several)" }, PAGE_WAIT);

    return within(bar).findByRole("button", { name }, PAGE_WAIT);
};

/**
 * The left sidebar of the chat: two-line thread cards grouped by pin, project and date, the section bar that filters them,
 * and the dock with search, the filter menu, Add project and New Thread.
 */
const meta = {
    args: {
        levels: [
            { id: "/(chat)", route: ChatLayoutRoute },
            { path: "chat/$threadId", route: ThreadRoute },
        ],
        url: `/chat/${THREAD_IDS.main}`,
    },
    // The section choice is saved in this browser; every story starts from the full list.
    beforeEach: () => {
        useThreadListUIStore.setState({ isSelectionMode: false, searchQuery: "", sectionFilter: ["active"], showSearch: false });
    },
    component: StoryPage,
    parameters: {
        layout: "fullscreen",
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(...sidebarFixtures()),
            },
        },
    },
    title: "Pages/Chat sidebar",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Every active thread, with the one that needs an approval on top and the branch under the open thread. */
export const AllSections: Story = {
    play: async ({ canvasElement }) => {
        const root = await sidebar(canvasElement);

        await expect(await root.findByRole("link", { name: "Deploy the billing migration" }, PAGE_WAIT)).toBeInTheDocument();
        await expect(await root.findByRole("button", { name: /^Active, \d+$/ }, PAGE_WAIT)).toHaveAttribute("aria-pressed", "true");
        // Archived and snoozed threads wait behind their own sections.
        await expect(root.queryByRole("link", { name: "Old onboarding survey" })).not.toBeInTheDocument();
        await expect(root.queryByRole("link", { name: "Follow up with the design agency" })).not.toBeInTheDocument();
    },
};

/** A click on one section shows only that section; the open thread stays in view. */
export const ArchivedOnly: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(await sectionButton(canvasElement, /^Archived, \d+$/));
        const root = within(canvasElement);

        await expect(await root.findByRole("link", { name: "Old onboarding survey" }, PAGE_WAIT)).toBeInTheDocument();
        await waitFor(() => expect(root.queryByRole("link", { name: "Pricing page copy" })).not.toBeInTheDocument());
        await expect(root.getByRole("link", { name: "Plan the Q1 product launch" })).toBeInTheDocument();
    },
};

/** Shift-click adds a section to the ones shown. */
export const SnoozedAndWorking: Story = {
    play: async ({ canvasElement }) => {
        // One user-event session, so the held Shift reaches the second click.
        const user = userEvent.setup();

        await user.click(await sectionButton(canvasElement, /^Snoozed, \d+$/));
        await user.keyboard("{Shift>}");
        await user.click(await sectionButton(canvasElement, /^Working, \d+$/));
        await user.keyboard("{/Shift}");
        const root = within(canvasElement);

        await expect(await root.findByRole("link", { name: "Follow up with the design agency" }, PAGE_WAIT)).toBeInTheDocument();
        await expect(await root.findByRole("link", { name: "Draft the launch email sequence" }, PAGE_WAIT)).toBeInTheDocument();
        await waitFor(() => expect(root.queryByRole("link", { name: "Pricing page copy" })).not.toBeInTheDocument());
    },
};

/** The dock's filter menu holds the search scope, category and tags, and the list's other actions. */
export const FilterMenu: Story = {
    play: async ({ canvasElement }) => {
        const root = await sidebar(canvasElement);

        await userEvent.click(await root.findByRole("button", { name: "Search filters" }, PAGE_WAIT));
        const menu = within(document.body);

        await expect(await menu.findByRole("menuitemradio", { name: "Threads" }, PAGE_WAIT)).toBeInTheDocument();
        await expect(menu.getByRole("menuitem", { name: /New group chat/ })).toBeInTheDocument();
        await expect(menu.getByRole("menuitem", { name: /Select multiple threads/ })).toBeInTheDocument();
        await expect(menu.getByRole("menuitem", { name: /Keyboard shortcuts/ })).toBeInTheDocument();
    },
};

/** The search field opens in place in the dock; a title search finds the launch thread. */
export const Search: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...sidebarFixtures(),
                    lunora(api.chat.functions.searchThreads, () => pageOf([THREADS.main]) as unknown as ReturnOf<typeof api.chat.functions.searchThreads>),
                ),
            },
        },
    },
    play: async ({ canvasElement }) => {
        const root = await sidebar(canvasElement);

        await userEvent.click(await root.findByRole("button", { name: /^Search threads/ }, PAGE_WAIT));
        const field = await root.findByRole("textbox", { name: "Search thread titles and summaries" }, PAGE_WAIT);

        await userEvent.type(field, "launch");
        await expect(field).toHaveValue("launch");
        await expect(await root.findByRole("link", { name: "Plan the Q1 product launch" }, PAGE_WAIT)).toBeInTheDocument();
        await waitFor(() => expect(root.queryByRole("link", { name: "Pricing page copy" })).not.toBeInTheDocument(), PAGE_WAIT);
        // The section bar steps aside while a search runs: it looks through every thread.
        await waitFor(() => expect(root.queryByRole("group", { name: "Thread sections (shift-click to show several)" })).not.toBeInTheDocument());
    },
};

/** Hovering a card shows Pin, Snooze, Archive and the options menu. */
export const RowActions: Story = {
    play: async ({ canvasElement }) => {
        const root = await sidebar(canvasElement);
        const link = await root.findByRole("link", { name: "Pricing page copy" }, PAGE_WAIT);

        await userEvent.hover(link);
        await expect(await root.findByRole("button", { name: "Pin thread: Pricing page copy" }, PAGE_WAIT)).toBeInTheDocument();
        await expect(root.getByRole("button", { name: "Snooze thread: Pricing page copy" })).toBeInTheDocument();
        await expect(root.getByRole("button", { name: "Archive thread: Pricing page copy" })).toBeInTheDocument();
        await expect(root.getByRole("button", { name: "Thread options: Pricing page copy" })).toBeInTheDocument();
    },
};
