import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { useThreadListUIStore } from "@/features/chat/thread-list/stores/thread-list-ui-store";
import { Route as ThreadRoute } from "@/routes/(chat)/chat/$threadId";
import { Route as ChatIndexRoute } from "@/routes/(chat)/chat/index";
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

const TAGS = [
    { _id: "tag_team", color: "blue", name: "team", order: 0 },
    { _id: "tag_marketing", color: "green", name: "marketing", order: 1 },
];

/** One card for each second-line state: tags, a chat on the user's computer, a temporary chat, a locked chat, a long title. */
const ROW_STATE_THREADS = [
    THREADS.main,
    thread({ _id: "0193c1b2-7d1e-7a3c-9f00-000000000021", tagIds: ["tag_team", "tag_marketing"], title: "Weekly team update draft" }),
    thread({ _id: "0193c1b2-7d1e-7a3c-9f00-000000000022", runner: "host", title: "Refactor the billing worker" }),
    // A temporary chat: its expiry is on the list row, not on the stored thread type.
    { ...thread({ _id: "0193c1b2-7d1e-7a3c-9f00-000000000023", title: "Brainstorm names" }), expiresAt: ago(-3 * HOUR) },
    thread({ _id: "0193c1b2-7d1e-7a3c-9f00-000000000024", lockedAt: ago(DAY), title: "Salary review notes" }),
    thread({
        _id: "0193c1b2-7d1e-7a3c-9f00-000000000025",
        title: "A very long thread title that keeps going well past the width of the sidebar card so it has to be cut",
    }),
];

/** The second line of each card says what is true of its thread; a locked chat shows nothing about itself. */
export const CardStates: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures({ tags: TAGS as never, threads: ROW_STATE_THREADS })),
            },
        },
    },
    play: async ({ canvasElement }) => {
        const root = await sidebar(canvasElement);

        await expect(await root.findByText("team", undefined, PAGE_WAIT)).toBeInTheDocument();
        await expect(root.getByText("Runs on your computer")).toBeInTheDocument();
        await expect(root.getByRole("link", { name: "Locked chat" })).toBeInTheDocument();
        await expect(root.getByRole("link", { name: /^A very long thread title/ })).toBeInTheDocument();
    },
};

/** Thirty threads: past fifteen rows the list renders virtually, and the taller cards must still be measured right. */
export const LongList: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures({
                        threads: [
                            THREADS.main,
                            ...Array.from({ length: 30 }, (_, index) =>
                                thread({
                                    _id: `0193c1b2-7d1e-7a3c-9f00-0000000001${String(index).padStart(2, "0")}`,
                                    lastReplyAt: ago((index + 2) * HOUR),
                                    title: `Research note ${String(index + 1)}`,
                                    updatedAt: ago((index + 2) * HOUR),
                                }),
                            ),
                        ],
                    }),
                ),
            },
        },
    },
    play: async ({ canvasElement }) => {
        const root = await sidebar(canvasElement);

        const first = await root.findByRole("link", { name: "Research note 1" }, PAGE_WAIT);
        // The virtual list scrolls its own container: the last card is reached by scrolling it to the end.
        const scroller = first.closest<HTMLElement>("[data-sidebar='content']") ?? first.closest<HTMLElement>(".overflow-auto");

        scroller?.scrollTo({ top: scroller.scrollHeight });
        await expect(await root.findByRole("link", { name: "Research note 30" }, PAGE_WAIT)).toBeInTheDocument();
    },
};

/** Selection mode (from the filter menu's Select multiple threads, covered by the dock's tests): every card gets a checkbox. */
export const SelectionMode: Story = {
    beforeEach: () => {
        useThreadListUIStore.setState({ isSelectionMode: true });
    },
    play: async ({ canvasElement }) => {
        const root = within(canvasElement);

        // A selected list shows titles as text, not links: a row selects rather than opens.
        await root.findByText("Pricing page copy", undefined, PAGE_WAIT);
        await lunoraIdle();
        await waitFor(() => expect(root.getAllByRole("checkbox").length).toBeGreaterThan(3), PAGE_WAIT);
    },
};

/** Only active threads: the Working and Archived sections hold nothing, so their buttons show no counter. */
export const DockZeroCounts: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures()) } },
    },
    play: async ({ canvasElement }) => {
        const root = await sidebar(canvasElement);
        const bar = await root.findByRole("group", { name: "Thread sections (shift-click to show several)" }, PAGE_WAIT);
        const working = await within(bar).findByRole("button", { name: /^Working, 0$/ }, PAGE_WAIT);

        await expect(working).not.toHaveTextContent("0");
        await expect(within(bar).getByRole("button", { name: /^Archived, 0$/ })).not.toHaveTextContent("0");
    },
};

/** A section with nothing in it says so (on a new chat: an open thread would stay in the list). */
export const EmptySection: Story = {
    args: {
        levels: [
            { id: "/(chat)", route: ChatLayoutRoute },
            { path: "chat/", route: ChatIndexRoute },
        ],
        url: "/chat",
    },
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures()) } },
    },
    play: async ({ canvasElement }) => {
        const bar = await within(canvasElement).findByRole("group", { name: "Thread sections (shift-click to show several)" }, PAGE_WAIT);

        await userEvent.click(await within(bar).findByRole("button", { name: /^Archived, 0$/ }, PAGE_WAIT));

        await expect(await within(canvasElement).findByText("No threads in this section", undefined, PAGE_WAIT)).toBeInTheDocument();
    },
};

/** The thread's details as a raised panel beside the chat: tabs in a well, the summary and the system prompt below. */
export const DetailsPanel: Story = {
    play: async ({ canvasElement }) => {
        const root = await sidebar(canvasElement);
        const toggles = await root.findAllByRole("button", { name: "Toggle Sidebar" }, PAGE_WAIT);

        await userEvent.click(toggles.at(-1) as HTMLElement);
        await expect(await root.findByRole("tab", { name: "Thread" }, PAGE_WAIT)).toHaveAttribute("aria-selected", "true");
        await expect(root.getByText("Thread summary")).toBeVisible();
    },
};

/** What the context box reads for a thread: a linked pull request, a goal two rounds in, its project and the tokens it used. */
const contextFixtures = (options: { host?: boolean } = {}) => {
    const current = { ...THREADS.main, projectId: "project_q1", ...(options.host && { runner: "host" }) };

    return [
        ...userFixtures(),
        ...shellFixtures(),
        ...chatFixtures({ relationships: SIDEBAR_RELATIONSHIPS, thread: current as typeof THREADS.main, threads: SIDEBAR_THREADS }),
        lunora(api.source_control.pr_thread_attach.listForThread, [
            {
                baseBranch: "main",
                createdAt: ago(3 * HOUR),
                headBranch: "feat/launch-checklist",
                kind: "opened",
                number: 412,
                repository: "acme/launch",
                threadId: THREAD_IDS.main,
                title: "Add the launch checklist and owners",
                url: "https://github.com/acme/launch/pull/412",
            },
        ]),
        lunora(api.chat.composite.getThreadPaneState, {
            childThreads: [],
            goal: {
                costMicrodollars: 180_000,
                createdAt: ago(2 * HOUR),
                goalId: "goal_launch",
                maxCostMicrodollars: 2_000_000,
                maxRounds: 5,
                round: 2,
                startMessageId: "message_goal",
                status: "active",
                text: "Every track has an owner and a due date in the checklist",
                verdicts: [],
            },
            relationship: null,
            title: current.title,
        } as never),
        lunora(api.projects.functions.getProject, {
            _creationTime: ago(20 * DAY),
            _id: "project_q1",
            createdAt: ago(20 * DAY),
            title: "Q1 Launch",
            updatedAt: ago(DAY),
            userId: "user-pro",
        } as never),
        lunora(api.acp.functions.getHostSession, {
            _id: "acp_session_1",
            agentKey: "claude-code",
            agentLabel: "Claude Code",
            createdAt: ago(HOUR),
            deviceId: "device_nova",
            folderLabel: "~/Projects/launch",
            liveStreamId: "stream_live",
            status: "busy",
            threadId: THREAD_IDS.main,
        } as never),
        lunora(api.devices.functions.listDevices, [
            {
                _id: "device_nova",
                appVersion: "1.14.2",
                createdAt: ago(60 * DAY),
                lastSeenAt: ago(MINUTE),
                name: "nova",
                platform: "linux",
                toolNames: ["read_file", "write_file", "run_command"],
                updateRequired: false,
            },
        ] as never),
    ];
};

/** Opens the details panel and waits for the context box. */
const openContext = async (canvasElement: HTMLElement) => {
    const root = await sidebar(canvasElement);
    const toggles = await root.findAllByRole("button", { name: "Toggle Sidebar" }, PAGE_WAIT);

    await userEvent.click(toggles.at(-1) as HTMLElement);

    return await root.findByRole("region", { name: "Context" }, PAGE_WAIT);
};

/** A chat thread's context: its linked pull request, the goal two rounds in, the model, the permission mode, its project and tokens. */
export const ContextBox: Story = {
    parameters: {
        msw: { handlers: { lunora: lunoraHandlers(...contextFixtures()) } },
    },
    play: async ({ canvasElement }) => {
        const box = within(await openContext(canvasElement));

        await expect(await box.findByText("Every track has an owner and a due date in the checklist", undefined, PAGE_WAIT)).toBeVisible();
        await expect(await box.findByText("Q1 Launch", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** A thread that runs on a paired computer: the computer, its folder and the coding agent, which is working. */
export const ContextBoxOnComputer: Story = {
    parameters: {
        // Axe checks the box. The computer thread's composer gives its textarea role="combobox", which axe rejects; that is the
        // composer's, it predates the box, and this is the first story with a computer thread.
        a11y: { context: { include: ['[data-slot="thread-context"]'] } },
        msw: { handlers: { lunora: lunoraHandlers(...contextFixtures({ host: true })) } },
    },
    play: async ({ canvasElement }) => {
        const box = within(await openContext(canvasElement));

        await expect(await box.findByText("nova", undefined, PAGE_WAIT)).toBeVisible();
        await expect(box.getByText("~/Projects/launch")).toBeVisible();
    },
};
