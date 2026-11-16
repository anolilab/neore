import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import type { AutoContinueState } from "./auto-continue-status";
import AutoContinueStatus from "./auto-continue-status";

const state = (overrides: Partial<AutoContinueState>): AutoContinueState => {
    return { active: true, iteration: 3, maxIterations: 25, status: "thinking", toolCalls: [], ...overrides };
};

const meta: Meta<typeof AutoContinueStatus> = {
    args: { onCancel: fn(), state: state({}) },
    component: AutoContinueStatus,
    title: "Chat/AutoContinueStatus",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Thinking: Story = {
    play: async ({ args, canvas }) => {
        await expect(canvas.getByText("Thinking...")).toBeVisible();
        await expect(canvas.getByRole("progressbar", { name: "Deep work progress" })).toHaveAttribute("aria-valuenow", "3");
        await userEvent.click(canvas.getByRole("button", { name: "Cancel deep work" }));
        await expect(args.onCancel).toHaveBeenCalledOnce();
    },
};

/** Only the last three calls are listed; the count covers all of them. */
export const ExecutingTools: Story = {
    args: {
        state: state({
            iteration: 8,
            status: "executing_tools",
            toolCalls: [
                { status: "complete", toolName: "web_search" },
                { status: "complete", toolName: "mcp_github__list_issues" },
                { status: "error", toolName: "read_file" },
                { status: "running", toolName: "run_code" },
            ],
        }),
    },
    play: async ({ canvas }) => {
        await expect(canvas.getByText(/2\/4 tools/u)).toBeVisible();
        await expect(canvas.queryByText("Web Search")).toBeNull();
        await expect(canvas.getByText("List Issues")).toBeVisible();
    },
};

export const Compressing: Story = { args: { state: state({ iteration: 14, status: "compressing" }) } };

export const Finalizing: Story = { args: { state: state({ iteration: 25, status: "finalizing" }) } };

export const WithoutCancel: Story = {
    args: { onCancel: undefined },
    play: async ({ canvas }) => {
        await expect(canvas.queryByRole("button", { name: "Cancel deep work" })).toBeNull();
    },
};

/** An inactive state renders nothing. */
export const Inactive: Story = {
    args: { state: state({ active: false }) },
    play: async ({ canvas }) => {
        await expect(canvas.queryByRole("status")).toBeNull();
    },
};
