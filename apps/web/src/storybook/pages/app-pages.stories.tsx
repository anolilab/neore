import type { Meta, StoryObj } from "@storybook/react-vite";
import type { screen } from "storybook/test";
import { expect, waitFor } from "storybook/test";

import { Route as ShortcutRoute } from "@/routes/_shortcut";
import { Route as CodeRoute } from "@/routes/_shortcut/code/index";
import { Route as DevelopRoute } from "@/routes/_shortcut/develop";
import { Route as EvalsRoute } from "@/routes/_shortcut/evals";
import { Route as PagesRoute } from "@/routes/_shortcut/pages";
import { Route as PagesIndexRoute } from "@/routes/_shortcut/pages/index";
import { Route as PromptsRoute } from "@/routes/_shortcut/prompts";
import { Route as SkillsRoute } from "@/routes/_shortcut/skills";
import { Route as TasksRoute } from "@/routes/_shortcut/tasks";
import { Route as VaultRoute } from "@/routes/_shortcut/vault";
import { Route as WorkflowGalleryRoute } from "@/routes/(chat)/workflow/gallery";
import { Route as WorkflowIndexRoute } from "@/routes/(chat)/workflow/index";
import { Route as WorkflowLayoutRoute } from "@/routes/(chat)/workflow/route";
import { Route as DashboardIndexRoute } from "@/routes/dashboard/index";
import { Route as DashboardRoute } from "@/routes/dashboard/route";
import { chatFixtures } from "@/storybook/fixtures/chat";
import { evalsFixtures, homeFixtures, promptsFixtures, skillsFixtures, tasksFixtures, vaultFixtures } from "@/storybook/fixtures/library";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { codeFixtures, developFixtures, DEVICES, DEVICES_WITH_AGENT, pagesFixtures, workflowFixtures } from "@/storybook/fixtures/workspace";
import { lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// A page loads its route chunk, then its data; with four browser projects running at once that can outlast a few seconds.
const PAGE_WAIT = { timeout: 15_000 } as const;

const handlers = (...fixtures: ReturnType<typeof userFixtures>) => {
    return { gateway: gatewayModelsHandler(), lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...fixtures) };
};

/**
 * The signed-in pages that are not chat or settings, populated: home, skills, prompts, tasks, the vault, evals and the rest
 * of the app's library pages. Each story mounts the real layout routes and the page.
 */
const meta = {
    args: { levels: [], url: "/dashboard" },
    component: StoryPage,
    parameters: { layout: "fullscreen", msw: { handlers: handlers() } },
    title: "Pages/App pages",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

const SHORTCUT = { id: "/_shortcut", route: ShortcutRoute } as const;

const HOME_LEVELS = [
    { path: "dashboard", route: DashboardRoute },
    { path: "/", route: DashboardIndexRoute },
] as const;

export const Home: Story = {
    args: { levels: HOME_LEVELS, url: "/dashboard" },
    parameters: { msw: { handlers: handlers(...homeFixtures()) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("heading", { name: /^Needs you/u }, PAGE_WAIT)).toBeVisible();
    },
};

export const HomeQuiet: Story = {
    args: { levels: HOME_LEVELS, url: "/dashboard" },
    parameters: {
        msw: {
            handlers: handlers(
                ...homeFixtures({ approvals: [], codingAgents: [], notifications: [], recentThreads: [], reviews: [], runningTasks: [], unreadCount: 0 }),
            ),
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Nothing is waiting on you.", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Skills: Story = {
    args: { levels: [SHORTCUT, { path: "skills", route: SkillsRoute }], url: "/skills" },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Weekly update", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const SkillsEmpty: Story = {
    args: { levels: [SHORTCUT, { path: "skills", route: SkillsRoute }], url: "/skills" },
    parameters: { msw: { handlers: handlers(...skillsFixtures({ skills: [] })) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("No skills yet", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const SkillsMarketplace: Story = {
    args: { levels: [SHORTCUT, { path: "skills", route: SkillsRoute }], url: "/skills" },
    parameters: { msw: { handlers: handlers(...skillsFixtures()) } },
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(await canvas.findByRole("tab", { name: "Marketplace" }, PAGE_WAIT));
        await expect(await canvas.findByText("Meeting minutes", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Prompts: Story = {
    args: { levels: [SHORTCUT, { path: "prompts", route: PromptsRoute }], url: "/prompts" },
    parameters: { msw: { handlers: handlers(...promptsFixtures()) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Careful editor", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const PromptsEmpty: Story = {
    args: { levels: [SHORTCUT, { path: "prompts", route: PromptsRoute }], url: "/prompts" },
    parameters: { msw: { handlers: handlers(...promptsFixtures([])) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("No prompts yet", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Tasks: Story = {
    args: { levels: [SHORTCUT, { path: "tasks", route: TasksRoute }], url: "/tasks" },
    parameters: { msw: { handlers: handlers(...tasksFixtures()) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Review the pricing page copy", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const TasksEmpty: Story = {
    args: { levels: [SHORTCUT, { path: "tasks", route: TasksRoute }], url: "/tasks" },
    parameters: { msw: { handlers: handlers(...tasksFixtures({ goals: [], tasks: [] })) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("No tasks yet", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Vault: Story = {
    args: { levels: [SHORTCUT, { path: "vault", route: VaultRoute }], url: "/vault" },
    parameters: { msw: { handlers: handlers(...vaultFixtures()) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("launch-plan.pdf", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const VaultEmpty: Story = {
    args: { levels: [SHORTCUT, { path: "vault", route: VaultRoute }], url: "/vault" },
    parameters: { msw: { handlers: handlers(...vaultFixtures([])) } },
};

export const Evals: Story = {
    args: { levels: [SHORTCUT, { path: "evals", route: EvalsRoute }], url: "/evals" },
    parameters: { msw: { handlers: handlers(...evalsFixtures()) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findAllByText("Support answers", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

export const EvalsEmpty: Story = {
    args: { levels: [SHORTCUT, { path: "evals", route: EvalsRoute }], url: "/evals" },
    parameters: { msw: { handlers: handlers(...evalsFixtures([])) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("No datasets yet", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Develop: Story = {
    args: { levels: [SHORTCUT, { path: "develop", route: DevelopRoute }], url: "/develop?repository=acme%2Fstorefront&number=482" },
    parameters: { msw: { handlers: handlers(...developFixtures()) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findAllByText("Cache thread titles by owner so the sidebar stops refetching", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};

export const DevelopNotConnected: Story = {
    args: { levels: [SHORTCUT, { path: "develop", route: DevelopRoute }], url: "/develop" },
    parameters: { msw: { handlers: handlers(...developFixtures({ connected: false })) } },
};

export const DevelopEmptyInbox: Story = {
    args: { levels: [SHORTCUT, { path: "develop", route: DevelopRoute }], url: "/develop" },
    parameters: { msw: { handlers: handlers(...developFixtures({ items: [] })) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Nothing here.", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const Pages: Story = {
    args: { levels: [SHORTCUT, { path: "pages", route: PagesRoute }, { path: "/", route: PagesIndexRoute }], url: "/pages" },
    parameters: { msw: { handlers: handlers(...pagesFixtures()) } },
    play: async ({ canvas }) => {
        // The page is in Favorites and in Private.
        await expect(await canvas.findAllByText("Launch plan", undefined, PAGE_WAIT)).toHaveLength(2);
    },
};

export const PagesEmpty: Story = {
    args: { levels: [SHORTCUT, { path: "pages", route: PagesRoute }, { path: "/", route: PagesIndexRoute }], url: "/pages" },
    parameters: { msw: { handlers: handlers(...pagesFixtures({ owned: [], shared: [] })) } },
};

/** The row of a setup step, found by its title. */
const setupRow = async (canvas: Pick<typeof screen, "findByText">, title: string) => {
    const label = await canvas.findByText(title, undefined, PAGE_WAIT);

    return label.closest("li");
};

const CODE_ARGS = { levels: [SHORTCUT, { path: "code/", route: CodeRoute }], url: "/code" } as const;

/** Every setup step is done or skipped: the main area is the plain "pick a host" state. */
export const Code: Story = {
    args: CODE_ARGS,
    parameters: {
        msw: { handlers: handlers(...codeFixtures(DEVICES_WITH_AGENT, { gitConnected: true }), ...userFixtures({ settings: { setupStepsSkipped: ["ssh"] } })) },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Studio MacBook", undefined, PAGE_WAIT)).toBeVisible();
        await expect(await canvas.findByText("Pick a host or a pull request", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** A computer is paired and the server step is skipped; the agent and the Git host are still open. */
export const CodePartlySetUp: Story = {
    args: CODE_ARGS,
    parameters: { msw: { handlers: handlers(...codeFixtures(DEVICES), ...userFixtures({ settings: { setupStepsSkipped: ["ssh"] } })) } },
    play: async ({ canvas }) => {
        // On a phone the host list comes first when a host exists, so the steps are in the page but behind it.
        await expect(await canvas.findByText("Coding setup", { ignore: "button, script, style" }, PAGE_WAIT)).toBeInTheDocument();
        await expect(await setupRow(canvas, "Pair a computer")).toHaveTextContent("Done");
        await expect(await setupRow(canvas, "Add an SSH server")).toHaveTextContent("Skipped");
    },
};

/** Nothing paired, nothing skipped: the setup steps replace the "pick a host" message. */
export const CodeNoComputer: Story = {
    args: CODE_ARGS,
    parameters: { msw: { handlers: handlers(...codeFixtures([])) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Coding setup", { ignore: "button, script, style" }, PAGE_WAIT)).toBeVisible();
        // The host answers after the steps do.
        await waitFor(async () => expect(await setupRow(canvas, "Connect a Git host")).toHaveTextContent("To do"), PAGE_WAIT);
        await expect(canvas.queryByText("Pick a host or a pull request")).toBeNull();
    },
};

const WORKFLOW_LEVELS = [{ path: "workflow", route: WorkflowLayoutRoute }] as const;

export const Workflows: Story = {
    args: { levels: [...WORKFLOW_LEVELS, { path: "/", route: WorkflowIndexRoute }], url: "/workflow" },
    parameters: { msw: { handlers: handlers(...workflowFixtures()) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Product photo set", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const WorkflowsEmpty: Story = {
    args: { levels: [...WORKFLOW_LEVELS, { path: "/", route: WorkflowIndexRoute }], url: "/workflow" },
    parameters: { msw: { handlers: handlers(...workflowFixtures({ workflows: [] })) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("No workflows yet", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const WorkflowGallery: Story = {
    args: { levels: [...WORKFLOW_LEVELS, { path: "gallery", route: WorkflowGalleryRoute }], url: "/workflow/gallery" },
    parameters: { msw: { handlers: handlers(...workflowFixtures()) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findAllByText("Storyboard to clip", undefined, PAGE_WAIT)).not.toHaveLength(0);
    },
};
