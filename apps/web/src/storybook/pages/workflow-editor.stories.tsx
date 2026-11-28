import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Route as WorkflowEditorRoute } from "@/routes/(chat)/workflow/$workflowId";
import { Route as WorkflowLayoutRoute } from "@/routes/(chat)/workflow/route";
import { chatFixtures } from "@/storybook/fixtures/chat";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { NEW_WORKFLOW, RUNNING_EXECUTIONS, WORKFLOW_ID, workflowEditorFixtures } from "@/storybook/fixtures/workflow";
import { lunoraAnswered, lunoraHandlers, lunoraPending } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// The editor loads its route chunk, the canvas library, then the workflow; with four browser projects running at once that can outlast a few seconds.
const PAGE_WAIT = { timeout: 20_000 } as const;

const handlers = (...fixtures: ReturnType<typeof userFixtures>) => {
    return {
        gateway: gatewayModelsHandler(),
        lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...workflowEditorFixtures(), ...fixtures),
    };
};

/**
 * Opening one workflow: the header, the canvas with its node palette, toolbar and run controls, the run history panel
 * and the empty, loading and error states. Each story mounts the real workflow layout route and the editor route.
 */
const meta = {
    args: {
        levels: [
            { path: "workflow", route: WorkflowLayoutRoute },
            { path: "$workflowId", route: WorkflowEditorRoute },
        ],
        url: `/workflow/${WORKFLOW_ID}`,
    },
    component: StoryPage,
    parameters: { layout: "fullscreen", msw: { handlers: handlers() } },
    title: "Pages/Workflow editor",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** An existing workflow, nothing selected. */
export const Editor: Story = {
    play: async ({ canvas, canvasElement }) => {
        await expect(await canvas.findByRole("heading", { name: "Product photo set" }, PAGE_WAIT)).toBeVisible();
        await expect(await canvas.findByRole("button", { name: "Show run history" }, PAGE_WAIT)).toBeVisible();
        // The Result node's type is `output`, a class React Flow styles for its own built-in node: its wrapper must stay bare
        // (no white fill behind the card, no centred text), and the card's selects keep the label above them as their name.
        const wrapper = await waitFor(() => {
            const found = canvasElement.querySelector<HTMLElement>(".react-flow__node-output");

            expect(found).not.toBeNull();

            return found as HTMLElement;
        }, PAGE_WAIT);

        await expect(getComputedStyle(wrapper).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        await expect(getComputedStyle(wrapper).textAlign).not.toBe("center");
        await expect(await canvas.findByRole("combobox", { name: "Output Type" }, PAGE_WAIT)).toBeVisible();
    },
};

/** A node picked on the canvas: its toolbar and selection ring show. The node's own settings live inside the node. */
export const NodeSelected: Story = {
    play: async ({ canvas }) => {
        const node = await canvas.findByText("Write the scene prompt", undefined, PAGE_WAIT);

        await userEvent.click(node);
        // Every node has its toolbar; the picked one is the first in the canvas order here.
        const [duplicate] = await canvas.findAllByRole("button", { name: /Duplicate/u }, PAGE_WAIT);

        await expect(duplicate).toBeVisible();
    },
};

/** The node palette: the rail at the left edge, one group opened, and the add-node popover from the bottom bar. */
export const PaletteOpen: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Expand Image operations" }, PAGE_WAIT));
        await userEvent.click(await canvas.findByRole("button", { name: "Add node" }, PAGE_WAIT));
        // "Text" is in the rail and, once open, in the add-node popover too: the popover's is the last.
        await waitFor(async () => expect(await canvas.findAllByRole("button", { name: "Text" })).toHaveLength(2), PAGE_WAIT);
    },
};

/** Past runs: a finished run opened to show each node's result, with a failed run and an older one below it. */
export const RunHistory: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Show run history" }, PAGE_WAIT));
        await lunoraAnswered(api.workflow.functions.listExecutions);

        const rows = await canvas.findAllByRole("button", { expanded: false }, PAGE_WAIT);
        const firstRun = rows.find((row) => row.textContent?.includes("Completed"));

        if (firstRun) {
            await userEvent.click(firstRun);
        }

        await expect(await canvas.findByText("Node Results", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** A run in progress: the run controls show Stop and the status, and the history lists the running run first. */
export const RunInProgress: Story = {
    parameters: {
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures(),
                    ...workflowEditorFixtures({ executions: RUNNING_EXECUTIONS }),
                    lunoraPending(api.workflow.executor.executeWorkflow),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Show run history" }, PAGE_WAIT));
        await userEvent.click(await canvas.findByRole("button", { name: "Run" }, PAGE_WAIT));
        await expect(await canvas.findByRole("button", { name: "Stop" }, PAGE_WAIT)).toBeVisible();
    },
};

/** The publish dialog opened from the header. */
export const PublishDialogOpen: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: /Publish/ }, PAGE_WAIT));
        const dialog = await within(document.body).findByRole("dialog", undefined, PAGE_WAIT);

        // The dialog fades in: wait for the end of it rather than judging its first frame.
        await waitFor(() => expect(dialog).toBeVisible(), PAGE_WAIT);
    },
};

/** The template picker opened from the controls bar. */
export const TemplatesOpen: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: /Templates/ }, PAGE_WAIT));
        const dialog = await within(document.body).findByRole("dialog", undefined, PAGE_WAIT);

        // The dialog fades in: wait for the end of it rather than judging its first frame.
        await waitFor(() => expect(dialog).toBeVisible(), PAGE_WAIT);
    },
};

/** The keyboard shortcuts dialog opened from the controls bar. */
export const ShortcutsOpen: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Keyboard shortcuts" }, PAGE_WAIT));
        const dialog = await within(document.body).findByRole("dialog", undefined, PAGE_WAIT);

        // The dialog fades in: wait for the end of it rather than judging its first frame.
        await waitFor(() => expect(dialog).toBeVisible(), PAGE_WAIT);
    },
};

/** A workflow just created: an empty canvas under an untitled header. */
export const EmptyWorkflow: Story = {
    parameters: {
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures(),
                    ...workflowEditorFixtures({ executions: [], workflow: NEW_WORKFLOW }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("heading", { name: "Untitled Workflow" }, PAGE_WAIT)).toBeVisible();
    },
};

/** The workflow is still loading. */
export const Loading: Story = {
    parameters: {
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures(),
                    ...workflowEditorFixtures(),
                    lunoraPending(api.workflow.functions.getWorkflow),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Loading workflow...", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** The workflow does not exist, or belongs to someone else. */
export const NotFound: Story = {
    parameters: {
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...workflowEditorFixtures({ workflow: null })),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Workflow not found", undefined, PAGE_WAIT)).toBeVisible();
    },
};
