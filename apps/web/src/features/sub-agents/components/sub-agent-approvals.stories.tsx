import type { ArgsOf, ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { userFixtures } from "@/storybook/fixtures/user";
import type { LunoraFixture } from "@/storybook/lunora";
import { lunora, lunoraError, lunoraHandlers, lunoraPending } from "@/storybook/lunora";

import SubAgentApprovals from "./sub-agent-approvals";

type Request = ReturnOf<typeof api.sub_agents.functions.listSubAgentApprovals>["requests"][number];

const RUN_ID = "run-1" as Request["runId"];
const CHILD_ID = "thread-child" as Request["childThreadId"];

const REQUEST: Request = {
    approvalId: "approval-1",
    childThreadId: CHILD_ID,
    input: JSON.stringify({ path: "/projects/old.txt" }, null, 2),
    omittedCharacters: 0,
    runId: RUN_ID,
    server: "Files",
    skillSlug: "tidy",
    toolName: "delete",
};

/** What the answers sent, to check they go to the child's thread. */
const answers: ArgsOf<typeof api.chat.tool_permissions.respondToToolApproval>[] = [];

const handlers = (...fixtures: LunoraFixture[]) =>
    lunoraHandlers(
        ...userFixtures(),
        lunora(api.sub_agents.functions.listSubAgentApprovals, { cut: [], requests: [REQUEST] }),
        lunora(api.chat.tool_permissions.respondToToolApproval, (args) => {
            answers.push(args);

            return { alreadyResolved: false, streamId: null };
        }),
        ...fixtures,
    );

const meta = {
    args: { parentThreadId: "thread-parent", runId: RUN_ID },
    component: SubAgentApprovals,
    parameters: { layout: "padded", msw: { handlers: { lunora: handlers() } } },
    title: "Chat/Sub-agents/Approval in the parent",
} satisfies Meta<typeof SubAgentApprovals>;

export default meta;

type Story = StoryObj<typeof meta>;

const ALLOWED_FOR_A_PERIOD = /for 1 hour|for today/iu;
const MORE_WAITING = "More requests are waiting in the sub-agent's thread.";

/** The sub-agent waits: its request names it, the tool and the server, and offers allow once, deny and always allow, never an allow for a period. */
export const Waiting: Story = {
    play: async ({ canvas }) => {
        const card = await canvas.findByRole("group", { name: '/tidy wants to run "delete"' });

        await expect(card).toHaveTextContent("Waiting for your approval");
        await expect(within(card).getByText("Files")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Approve delete once" })).toBeEnabled();
        await expect(canvas.getByRole("button", { name: "Deny delete" })).toBeEnabled();
        await expect(canvas.getByRole("button", { name: "Always allow delete" })).toBeEnabled();
        // The claim refuses a timed allow for a sub-agent's request, so the card does not offer one.
        await expect(canvas.queryByRole("button", { name: ALLOWED_FOR_A_PERIOD })).not.toBeInTheDocument();
        await expect(canvas.queryByText(MORE_WAITING)).not.toBeInTheDocument();
    },
};

/** Approved from the parent: the answer goes to the child's thread, and the card says the tool runs. */
export const Answered: Story = {
    play: async ({ canvas }) => {
        answers.length = 0;
        await userEvent.click(await canvas.findByRole("button", { name: "Approve delete once" }));

        await expect(await canvas.findByText("Approved — running tool")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Deny delete" })).toBeDisabled();
        await waitFor(async () => {
            await expect(answers.at(-1)).toMatchObject({ approvalId: "approval-1", decision: "approve", threadId: CHILD_ID });
        });
    },
};

/** The claim refused the answer (the sub-agent ended meanwhile): a toast says why, and the card asks again. */
export const Refused: Story = {
    parameters: {
        msw: {
            handlers: { lunora: handlers(lunoraError(api.chat.tool_permissions.respondToToolApproval, "BAD_REQUEST", "This sub-agent has already ended.")) },
        },
    },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Deny delete" }));

        const toast = await screen.findByText("This sub-agent has already ended.");

        // The toast fades in from `opacity: 0`.
        await waitFor(async () => {
            await expect(toast).toBeVisible();
        });
        await waitFor(async () => {
            await expect(canvas.getByRole("button", { name: "Deny delete" })).toBeEnabled();
            await expect(canvas.getByRole("group", { name: '/tidy wants to run "delete"' })).toHaveTextContent("Waiting for your approval");
        });
    },
};

/** A long tool input, cut by the server: the card says how much it does not show, in the locale's number format. */
export const LongInput: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: handlers(
                    lunora(api.sub_agents.functions.listSubAgentApprovals, { cut: [], requests: [{ ...REQUEST, omittedCharacters: 1200, skillSlug: null }] }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await canvas.findByRole("group", { name: 'The sub-agent wants to run "delete"' });
        await userEvent.click(canvas.getByText("Show what it will send"));

        await expect(canvas.getByText(/1,200 more characters not shown; approving runs the whole call/u)).toBeVisible();
    },
};

/** The list failed to load: an error, not an empty card. */
export const LoadError: Story = {
    parameters: {
        msw: { handlers: { lunora: handlers(lunoraError(api.sub_agents.functions.listSubAgentApprovals, "INTERNAL", "Shard unavailable", 500)) } },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("alert")).toHaveTextContent("Could not load the sub-agent's requests.");
        await expect(canvas.queryByRole("button", { name: "Approve delete once" })).not.toBeInTheDocument();
    },
};

/** The list's cap dropped some of this run's requests: the card says more wait in the child's thread. */
export const CutShort: Story = {
    parameters: {
        msw: { handlers: { lunora: handlers(lunora(api.sub_agents.functions.listSubAgentApprovals, { cut: [RUN_ID], requests: [REQUEST] })) } },
    },
    play: async ({ canvas }) => {
        await canvas.findByRole("group", { name: '/tidy wants to run "delete"' });
        await expect(canvas.getByText(MORE_WAITING)).toBeVisible();
    },
};

/** The list has not answered yet: a polite status, not an empty card. */
export const Loading: Story = {
    parameters: { msw: { handlers: { lunora: handlers(lunoraPending(api.sub_agents.functions.listSubAgentApprovals)) } } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("status")).toHaveTextContent("Loading the sub-agent's requests…");
    },
};
