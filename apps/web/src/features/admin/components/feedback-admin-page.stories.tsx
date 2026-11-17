import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor } from "storybook/test";

import { ago, DAY, HOUR } from "@/storybook/clock";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraError, lunoraHandlers, lunoraPending } from "@/storybook/lunora";

import type { AdminFeedbackItem } from "../hooks/use-admin";
import FeedbackAdminPage from "./feedback-admin-page";

/** A tiny inline picture, so the story requests nothing outside the page. */
const SCREENSHOT = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#8b5cf6"/></svg>')}`;

const FEEDBACK: AdminFeedbackItem[] = [
    {
        _id: "feedback_1" as Id<"feedback">,
        createdAt: ago(2 * HOUR),
        images: [
            { contentType: "image/svg+xml", url: SCREENSHOT },
            { contentType: "image/png", url: null },
        ],
        kind: "problem",
        message: "The model picker closes as soon as I scroll inside it.",
        pagePath: "/chat/thread-1",
        sender: { email: "ada@example.com", image: null, name: "Ada Lovelace", userId: "user_ada" },
    },
    {
        _id: "feedback_2" as Id<"feedback">,
        createdAt: ago(DAY),
        images: [],
        kind: "idea",
        message: "Let me pin a project to the top of the sidebar.",
        pagePath: null,
        sender: { email: null, image: null, name: null, userId: "user_gone" },
    },
];

const meta = {
    component: FeedbackAdminPage,
    decorators: [
        (Story) => (
            <div className="w-[48rem] max-w-full">
                <Story />
            </div>
        ),
    ],
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    lunora(api.feedback.admin.listFeedback, ({ cursor, kind }) => {
                        const rows = FEEDBACK.filter((item) => kind === undefined || item.kind === kind);

                        // Two pages of one row each, so "Older" and "Newer" have somewhere to go.
                        return cursor === "page-2" || kind !== undefined
                            ? { continueCursor: null, isDone: true, page: cursor === "page-2" ? rows.slice(1) : rows }
                            : { continueCursor: "page-2", isDone: false, page: rows.slice(0, 1) };
                    }),
                ),
            },
        },
        persona: "admin",
    },
    title: "Admin/Feedback",
} satisfies Meta<typeof FeedbackAdminPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The newest feedback, with its sender, page path and images (one that could not be signed). */
export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/model picker closes/i)).toBeVisible();
        await expect(canvas.getByRole("img", { name: "Image 1 from Ada Lovelace" })).toBeVisible();
        await expect(canvas.getByRole("img", { name: "Image 2 could not be loaded" })).toBeVisible();
        await expect(canvas.getByRole("button", { name: /newer/i })).toBeDisabled();
    },
};

/** "Older" moves to the next page; a sender whose account is gone shows as deleted. */
export const NextPage: Story = {
    play: async ({ canvas }) => {
        await canvas.findByText(/model picker closes/i);
        await waitFor(async () => {
            await expect(canvas.getByRole("button", { name: /older/i })).toBeEnabled();
        });
        await userEvent.click(canvas.getByRole("button", { name: /older/i }));

        await expect(await canvas.findByText(/pin a project/i)).toBeVisible();
        await expect(canvas.getByText("Deleted user")).toBeVisible();
        await waitFor(async () => {
            await expect(canvas.getByRole("button", { name: /older/i })).toBeDisabled();
        });
        await expect(canvas.getByRole("button", { name: /newer/i })).toBeEnabled();
    },
};

/** How many times the `Refresh` story's list was read; reset each time the story opens. */
const refreshReads = { count: 0 };

/** "Refresh" reads the list again and shows feedback sent since the page opened. */
export const Refresh: Story = {
    beforeEach: () => {
        refreshReads.count = 0;
    },
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    lunora(api.feedback.admin.listFeedback, () => {
                        refreshReads.count += 1;

                        return { continueCursor: null, isDone: true, page: refreshReads.count === 1 ? FEEDBACK.slice(1) : FEEDBACK };
                    }),
                ),
            },
        },
    },
    play: async ({ canvas }) => {
        await canvas.findByText(/pin a project/i);
        await expect(canvas.queryByText(/model picker closes/i)).not.toBeInTheDocument();

        await userEvent.click(canvas.getByRole("button", { name: /refresh/i }));

        await expect(await canvas.findByText(/model picker closes/i)).toBeVisible();
    },
};

export const Empty: Story = {
    parameters: {
        msw: {
            handlers: { lunora: lunoraHandlers(...userFixtures(), lunora(api.feedback.admin.listFeedback, { continueCursor: null, isDone: true, page: [] })) },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("No feedback yet")).toBeVisible();
    },
};

export const Loading: Story = {
    parameters: { msw: { handlers: { lunora: lunoraHandlers(...userFixtures(), lunoraPending(api.feedback.admin.listFeedback)) } } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("status", { name: "Loading feedback" })).toBeInTheDocument();
    },
};

/** The read is refused (the caller lost the admin role). */
export const LoadError: Story = {
    parameters: {
        msw: {
            handlers: {
                lunora: lunoraHandlers(...userFixtures(), lunoraError(api.feedback.admin.listFeedback, "FORBIDDEN", "Admins only.", 403)),
            },
        },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("alert")).toHaveTextContent("Feedback could not be loaded.");
    },
};
